import type { AssertionPlugin, CaseResult, EvalRunner, EvalSuite, ModelOutput, ModelProduct, ModelSummary, RunReport, TestCase } from './types.js';
import { ProviderRegistry } from './ProviderRegistry.js';
import { ConfigError, isInfraError, toInfraError } from './errors.js';
import { runAssertions, validateAssertionTypes } from './assertions.js';
import { render } from './template.js';

export interface RunnerOptions {
  /** Opt-in assertion types, e.g. [judge({...})] from evalladder/judge. */
  assertionPlugins?: AssertionPlugin[];
  /** Base backoff in ms between infra retries. Default 500. */
  backoffMs?: number;
  /** Called after each case finishes. */
  onCase?: (result: CaseResult) => void;
}

/**
 * Runs every target x case with Promise.allSettled, so one failing case never stops the suite.
 * run(suite): Promise<RunReport>. Rejects with ConfigError only (checked before any model call).
 */
export class DefaultEvalRunner implements EvalRunner {
  private plugins: Map<string, AssertionPlugin>;

  constructor(private registry: ProviderRegistry, private opts: RunnerOptions = {}) {
    this.plugins = new Map((opts.assertionPlugins ?? []).map((p) => [p.type, p]));
  }

  async run(suite: EvalSuite): Promise<RunReport> {
    this.validate(suite);
    const startedAt = new Date().toISOString();
    const jobs: Array<{ target: ModelProduct; tc: TestCase }> = [];
    for (const target of suite.targets) for (const tc of suite.cases) jobs.push({ target, tc });

    const limit = pLimit(suite.concurrency ?? 4);
    const settled = await Promise.allSettled(jobs.map((j) => limit(() => this.runCase(suite, j.target, j.tc))));
    const cases: CaseResult[] = settled.map((s, i) =>
      s.status === 'fulfilled'
        ? s.value
        : { caseId: jobs[i].tc.id, productId: jobs[i].target.id, pass: false, assertions: [], error: errMsg(s.reason) },
    );
    const models = suite.targets.map((t) => summarize(t, cases.filter((c) => c.productId === t.id)));
    return {
      suiteId: suite.suiteId,
      promptId: suite.prompt.id,
      startedAt,
      finishedAt: new Date().toISOString(),
      models,
      cases,
      totalCostUsd: round(models.reduce((s, m) => s + m.totalCostUsd, 0)),
    };
  }

  private validate(suite: EvalSuite): void {
    if (!suite.targets.length) throw new ConfigError('Suite has no targets.');
    if (!suite.cases.length) throw new ConfigError('Suite has no cases.');
    for (const t of suite.targets) {
      if (!this.registry.has(t.provider)) {
        throw new ConfigError(`No plugin for provider "${t.provider}" (product "${t.id}"). Registered: ${this.registry.keys().join(', ') || 'none'}`);
      }
    }
    validateAssertionTypes(suite.cases, this.plugins);
  }

  /** One case on one model. Resolves always; failures are recorded on the CaseResult. */
  private async runCase(suite: EvalSuite, target: ModelProduct, tc: TestCase): Promise<CaseResult> {
    const base = { caseId: tc.id, productId: target.id };
    let output: ModelOutput;
    try {
      const provider = this.registry.resolve(target);
      const input = { ...suite.settings, system: suite.prompt.system, prompt: render(suite.prompt.template, tc.vars) };
      output = await withRetry(() => provider.complete(input), suite.retries ?? 2, this.opts.backoffMs ?? 500);
    } catch (e) {
      return this.emit({ ...base, pass: false, assertions: [], error: `model call failed: ${toInfraError(e).message}` });
    }
    try {
      const assertions = await runAssertions(tc, output, this.plugins);
      return this.emit({ ...base, pass: assertions.every((a) => a.pass), output, assertions });
    } catch (e) {
      return this.emit({ ...base, pass: false, output, assertions: [], error: `check failed to run: ${errMsg(e)}` });
    }
  }

  private emit(r: CaseResult): CaseResult {
    this.opts.onCase?.(r);
    return r;
  }
}

/** Retries fn on a retryable InfraError with exponential backoff. Promise<T>; rejects with the last error. */
/** @internal */
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
  const passed = rs.filter((r) => r.pass).length;
  const errored = rs.filter((r) => r.error).length;
  const modelCostUsd = round(rs.reduce((s, r) => s + (r.output?.costUsd ?? 0), 0));
  const assertionCostUsd = round(rs.reduce((s, r) => s + r.assertions.reduce((x, a) => x + a.costUsd, 0), 0));
  const lat = rs.filter((r) => r.output).map((r) => r.output!.latencyMs);
  return {
    productId: t.id,
    provider: t.provider,
    modelId: t.modelId,
    cases: rs.length,
    passed,
    failed: rs.length - passed - errored,
    errored,
    passRate: rs.length ? round(passed / rs.length, 4) : 0,
    modelCostUsd,
    assertionCostUsd,
    totalCostUsd: round(modelCostUsd + assertionCostUsd),
    avgLatencyMs: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : 0,
  };
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const round = (n: number, d = 8) => Math.round(n * 10 ** d) / 10 ** d;

function pLimit(n: number) {
  const queue: Array<() => void> = [];
  let active = 0;
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
