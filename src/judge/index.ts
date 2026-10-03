import { stripFences } from '../core/assertions.js';
import {
  isInfraError,
  InfraError,
  type AssertionPlugin,
  type AssertionResult,
  type ModelOutput,
  type ModelProduct,
  type PluginAssertion,
  type ProviderRegistry,
  type TestCase,
} from '../core/index.js';

/**
 * Optional LLM judge. Off unless you register it AND a test case uses { type: 'llm-rubric', rubric }.
 * Use it only when code can't check the answer (tone, helpfulness...).
 */
export interface LlmRubricAssertion extends PluginAssertion {
  type: 'llm-rubric';
  rubric: string;
}

export interface JudgeOptions {
  /** Registry that can resolve the judge models (can be the same one used for targets). */
  registry: ProviderRegistry;
  /** Judge models, cheapest first. Escalation walks this list. */
  ladder: ModelProduct[];
  /** Max escalations after the first judge call. Default 2. */
  maxHops?: number;
  /** Score at or above this passes. Default 0.7. */
  threshold?: number;
  /** Escalate when |score - threshold| < band. Default 0.1. */
  nearThresholdBand?: number;
}

/** Input to one judge call. */
export interface JudgeInput {
  rubric: string;
  output: ModelOutput;
  testCase: TestCase;
}

export const JUDGE_SYSTEM =
  'You are a strict evaluator. Grade the OUTPUT against the RUBRIC. ' +
  'Reply with JSON only: {"score": number between 0 and 1, "reason": "one sentence"}.';

export function judgePrompt(input: JudgeInput): string {
  return `RUBRIC:\n${input.rubric}\n\nINPUT VARIABLES:\n${JSON.stringify(input.testCase.vars)}\n\nOUTPUT:\n${input.output.text}`;
}

/** Parse judge JSON. Returns null when unparseable (that triggers escalation). */
export function parseVerdict(text: string): { score: number; reason: string } | null {
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
 * Cheap-first judge with escalation. Starts on the first ladder model and moves up on:
 * an infra error, unparseable output, or a score near the threshold. Never judges a model with itself.
 * judge(input): Promise<AssertionResult>
 *   resolves: a verdict (pass true/false), or pass:false "ungraded" when every judge's answer was unusable
 *   rejects:  InfraError when no judge could be reached at all
 */
export class JudgeRouter {
  constructor(private opts: JudgeOptions) {}

  async judge(input: JudgeInput): Promise<AssertionResult> {
    const threshold = this.opts.threshold ?? 0.7;
    const band = this.opts.nearThresholdBand ?? 0.1;
    const maxHops = this.opts.maxHops ?? 2;
    const ladder = this.opts.ladder.filter((m) => m.id !== input.output.productId && m.modelId !== input.output.modelId);
    if (ladder.length === 0) {
      return { type: 'llm-rubric', pass: false, score: 0, reason: 'no judge available (judge must differ from the model under test)', costUsd: 0 };
    }
    let cost = 0;
    let last: AssertionResult | null = null;
    let problem = '';
    let reached = false;
    const attempts = Math.min(ladder.length, maxHops + 1);
    for (let hop = 0; hop < attempts; hop++) {
      const model = ladder[hop];
      try {
        const res = await this.opts.registry.resolve(model).complete({ system: JUDGE_SYSTEM, prompt: judgePrompt(input), temperature: 0, maxTokens: 300 });
        reached = true;
        cost += res.costUsd;
        const v = parseVerdict(res.text);
        if (!v) {
          problem = `judge ${model.modelId} returned unparseable output`;
          continue;
        }
        last = { type: 'llm-rubric', pass: v.score >= threshold, score: v.score, reason: v.reason, costUsd: round(cost), checkedBy: model.modelId };
        if (Math.abs(v.score - threshold) >= band) return last;
        problem = 'score near threshold';
      } catch (e) {
        if (!isInfraError(e)) throw e;
        problem = `judge ${model.modelId}: ${e.message}`;
      }
    }
    if (last) return { ...last, costUsd: round(cost) };
    if (!reached) throw new InfraError(`no judge reachable: ${problem}`);
    return { type: 'llm-rubric', pass: false, score: 0, reason: `ungraded: ${problem}`, costUsd: round(cost) };
  }
}

/** Register on the runner: new DefaultEvalRunner(registry, { assertionPlugins: [judge({...})] }). */
export function judge(opts: JudgeOptions): AssertionPlugin {
  const router = new JudgeRouter(opts);
  return {
    type: 'llm-rubric',
    check: (assertion, output, testCase) => router.judge({ rubric: String((assertion as LlmRubricAssertion).rubric ?? ''), output, testCase }),
  };
}

const round = (n: number) => Math.round(n * 1e8) / 1e8;

export default judge;
