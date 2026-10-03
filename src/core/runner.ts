import type { CaseResult, EvalReport, EvalRunner, EvalSuite, Grader, ModelProduct, ModelResponse, ModelSummary, TestCase } from './types.js';
import { ProviderRegistry } from './ProviderRegistry.js';
import { CompositeGrader, JudgeRouter } from './graders.js';
import { isInfraError, toInfraError } from './errors.js';
import { render } from './template.js';

export interface RunnerOptions {
  grader?: Grader;
  /** Base backoff in ms between infra retries. Default 500. */
  backoffMs?: number;
  onResult?: (r: CaseResult) => void;
}

/** Runs every target x case. Promise.allSettled so one bad case never kills the suite. */
export class DefaultEvalRunner implements EvalRunner {
  constructor(private registry: ProviderRegistry, private opts: RunnerOptions = {}) {}

  async run(suite: EvalSuite): Promise<EvalReport> {
    const startedAt = new Date().toISOString();
    const grader =
      this.opts.grader ?? new CompositeGrader(suite.graderPolicy ? new JudgeRouter(this.registry, suite.graderPolicy) : undefined);
    const jobs: Array<{ target: ModelProduct; tc: TestCase }> = [];
    for (const target of suite.targets) for (const tc of suite.cases) jobs.push({ target, tc });

    const limit = pLimit(suite.concurrency ?? 4);
    const settled = await Promise.allSettled(jobs.map((j) => limit(() => this.runOne(suite, j.target, j.tc, grader))));
    const results: CaseResult[] = settled.map((s, i) =>
      s.status === 'fulfilled'
        ? s.value
        : {
            caseId: jobs[i].tc.id,
            productId: jobs[i].target.id,
            modelId: jobs[i].target.modelId,
            grade: { pass: false, score: 0, reason: 'runner error' },
            error: s.reason instanceof Error ? s.reason.message : String(s.reason),
          },
    );
    const byModel = suite.targets.map((t) => summarize(t, results.filter((r) => r.productId === t.id)));
    return {
      suiteId: suite.suiteId,
      promptId: suite.prompt.id,
      startedAt,
      finishedAt: new Date().toISOString(),
      byModel,
      results,
      totalCostUsd: round(byModel.reduce((s, m) => s + m.totalCostUsd, 0)),
    };
  }

  private async runOne(suite: EvalSuite, target: ModelProduct, tc: TestCase, grader: Grader): Promise<CaseResult> {
    const base = { caseId: tc.id, productId: target.id, modelId: target.modelId };
    let response: ModelResponse;
    try {
      const provider = this.registry.resolve(target);
      response = await withRetry(
        () => provider.complete({ ...suite.request, system: suite.prompt.system, prompt: render(suite.prompt.template, tc.vars) }),
        suite.retries ?? 2,
        this.opts.backoffMs ?? 500,
      );
    } catch (e) {
      const err = toInfraError(e);
      const r: CaseResult = { ...base, grade: { pass: false, score: 0, reason: 'model call failed (infra)' }, error: err.message };
      this.opts.onResult?.(r);
      return r;
    }
    const grade = await grader.grade(tc, response);
    const r: CaseResult = { ...base, response, grade };
    this.opts.onResult?.(r);
    return r;
  }
}

export async function withRetry<T>(fn: () => Promise<T>, retries: number, backoffMs: number): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      const retryable = isInfraError(e) ? e.retryable : false;
      if (!retryable || attempt >= retries) throw e;
      await new Promise((res) => setTimeout(res, backoffMs * 2 ** attempt));
      attempt++;
    }
  }
}

function summarize(t: ModelProduct, rs: CaseResult[]): ModelSummary {
  const passed = rs.filter((r) => r.grade.pass).length;
  const errored = rs.filter((r) => r.error).length;
  const modelCostUsd = round(rs.reduce((s, r) => s + (r.response?.costUsd ?? 0), 0));
  const graderCostUsd = round(rs.reduce((s, r) => s + (r.grade.graderCostUsd ?? 0), 0));
  const lat = rs.filter((r) => r.response).map((r) => r.response!.latencyMs);
  return {
    productId: t.id,
    provider: t.provider,
    modelId: t.modelId,
    passed,
    failed: rs.length - passed - errored,
    errored,
    passRate: rs.length ? round(passed / rs.length, 4) : 0,
    modelCostUsd,
    graderCostUsd,
    totalCostUsd: round(modelCostUsd + graderCostUsd),
    avgLatencyMs: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : 0,
  };
}

const round = (n: number, d = 8) => Math.round(n * 10 ** d) / 10 ** d;

function pLimit(n: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    active--;
    queue.shift()?.();
  };
  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const go = () => {
        active++;
        fn().then(resolve, reject).finally(next);
      };
      active < Math.max(1, n) ? go() : queue.push(go);
    });
}
