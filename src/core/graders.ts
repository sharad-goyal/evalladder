import type { Assertion, GradeResult, Grader, GraderPolicy, ModelProduct, ModelResponse, TestCase } from './types.js';
import type { ProviderRegistry } from './ProviderRegistry.js';
import { isInfraError } from './errors.js';

type CodeAssertion = Exclude<Assertion, { type: 'llm-rubric' }>;

/** Code checks. $0, no model call. */
export class DeterministicGrader {
  async check(a: CodeAssertion, output: string, tc: TestCase): Promise<GradeResult> {
    const ci = (s: string, on?: boolean) => (on ? s.toLowerCase() : s);
    switch (a.type) {
      case 'equals': {
        const pass = ci(output.trim(), a.ignoreCase) === ci(a.value.trim(), a.ignoreCase);
        return r(pass, pass ? 'equals' : `expected "${a.value}"`);
      }
      case 'contains': {
        const pass = ci(output, a.ignoreCase).includes(ci(a.value, a.ignoreCase));
        return r(pass, pass ? `contains "${a.value}"` : `missing "${a.value}"`);
      }
      case 'not-contains': {
        const pass = !ci(output, a.ignoreCase).includes(ci(a.value, a.ignoreCase));
        return r(pass, pass ? `does not contain "${a.value}"` : `contains forbidden "${a.value}"`);
      }
      case 'regex': {
        const pass = new RegExp(a.value, a.flags).test(output);
        return r(pass, pass ? `matches /${a.value}/` : `no match for /${a.value}/`);
      }
      case 'is-json': {
        try {
          JSON.parse(stripFences(output));
          return r(true, 'valid JSON');
        } catch {
          return r(false, 'not valid JSON');
        }
      }
      case 'javascript': {
        const out = await a.fn(output, tc);
        return typeof out === 'boolean' ? r(out, out ? 'javascript check passed' : 'javascript check failed') : out;
      }
    }
  }
}

function r(pass: boolean, reason: string): GradeResult {
  return { pass, score: pass ? 1 : 0, reason };
}

export function stripFences(s: string): string {
  const m = s.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return m ? m[1] : s.trim();
}

export const JUDGE_SYSTEM =
  'You are a strict evaluator. Grade the OUTPUT against the RUBRIC. ' +
  'Reply with JSON only: {"score": number between 0 and 1, "reason": "one sentence"}.';

export function judgePrompt(rubric: string, output: string, tc: TestCase): string {
  return `RUBRIC:\n${rubric}\n\nINPUT VARIABLES:\n${JSON.stringify(tc.vars)}\n\nOUTPUT:\n${output}`;
}

/** Parse judge JSON. Returns null when unparseable (triggers escalation). */
export function parseJudge(text: string): { score: number; reason: string } | null {
  const body = stripFences(text);
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const j = JSON.parse(body.slice(start, end + 1));
    const score = Number(j.score);
    if (!Number.isFinite(score) || score < 0 || score > 1) return null;
    return { score, reason: String(j.reason ?? '') };
  } catch {
    return null;
  }
}

/**
 * LLM judge with escalation. Starts on the cheapest tier, escalates on
 * infra reject, unparseable output, or a score near the threshold. Max hops default 2.
 * Never uses the model under test as its own judge.
 */
export class JudgeRouter {
  constructor(private registry: ProviderRegistry, private policy: GraderPolicy) {}

  async judge(rubric: string, tc: TestCase, out: ModelResponse): Promise<GradeResult> {
    const threshold = this.policy.threshold ?? 0.7;
    const band = this.policy.nearThresholdBand ?? 0.1;
    const maxHops = this.policy.maxHops ?? 2;
    const tiers = this.policy.tiers.filter((t: ModelProduct) => t.id !== out.productId && t.modelId !== out.modelId);
    if (tiers.length === 0) {
      return { pass: false, score: 0, reason: 'no judge available (judge must differ from model under test)' };
    }
    let cost = 0;
    let last: GradeResult | null = null;
    let lastProblem = '';
    const attempts = Math.min(tiers.length, maxHops + 1);
    for (let hop = 0; hop < attempts; hop++) {
      const judge = tiers[hop];
      try {
        const res = await this.registry.resolve(judge).complete({
          system: JUDGE_SYSTEM,
          prompt: judgePrompt(rubric, out.text, tc),
          temperature: 0,
          maxTokens: 300,
        });
        cost += res.costUsd;
        const parsed = parseJudge(res.text);
        if (!parsed) {
          lastProblem = `judge ${judge.modelId} returned unparseable output`;
          continue;
        }
        last = {
          pass: parsed.score >= threshold,
          score: parsed.score,
          reason: parsed.reason,
          graderModelId: judge.modelId,
          hops: hop,
          graderCostUsd: round(cost),
        };
        if (Math.abs(parsed.score - threshold) >= band) return last;
        lastProblem = 'score near threshold';
      } catch (e) {
        if (!isInfraError(e)) throw e;
        lastProblem = `judge ${judge.modelId} infra error: ${e.message}`;
      }
    }
    if (last) return { ...last, graderCostUsd: round(cost) };
    // Every judge failed. Still resolve (case fails), never reject for a grading problem.
    return { pass: false, score: 0, reason: `ungraded: ${lastProblem}`, hops: attempts - 1, graderCostUsd: round(cost) };
  }
}

const round = (n: number) => Math.round(n * 1e8) / 1e8;

/** Default grader: code assertions first (cheap); judge only if all code checks pass. */
export class CompositeGrader implements Grader {
  private det = new DeterministicGrader();
  constructor(private judge?: JudgeRouter) {}

  async grade(tc: TestCase, out: ModelResponse): Promise<GradeResult> {
    const code = tc.assertions.filter((a): a is CodeAssertion => a.type !== 'llm-rubric');
    const rubrics = tc.assertions.filter((a): a is Extract<Assertion, { type: 'llm-rubric' }> => a.type === 'llm-rubric');
    const results: GradeResult[] = [];
    for (const a of code) {
      const g = await this.det.check(a, out.text, tc);
      results.push(g);
      if (!g.pass) return { ...g, score: mean(results.map((x) => x.score)) };
    }
    for (const a of rubrics) {
      if (!this.judge) return { pass: false, score: 0, reason: 'llm-rubric assertion but no graderPolicy configured' };
      const g = await this.judge.judge(a.rubric, tc, out);
      results.push(g);
      if (!g.pass) break;
    }
    if (results.length === 0) return { pass: true, score: 1, reason: 'no assertions' };
    const pass = results.every((x) => x.pass);
    const judged = results.filter((x) => x.graderModelId);
    return {
      pass,
      score: mean(results.map((x) => x.score)),
      reason: results.map((x) => x.reason).join('; '),
      graderModelId: judged.at(-1)?.graderModelId,
      hops: judged.length ? Math.max(...judged.map((x) => x.hops ?? 0)) : undefined,
      graderCostUsd: judged.length ? round(judged.reduce((s, x) => s + (x.graderCostUsd ?? 0), 0)) : undefined,
    };
  }
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
