import type { Assertion, AssertionPlugin, ModelProduct, ModelProviderPlugin, ModelSettings, RunReport } from './types.js';
import { ProviderRegistry } from './ProviderRegistry.js';
import { DefaultEvalRunner } from './runner.js';
import { ConfigError } from './errors.js';

/** Options for compare(). `plugins` is required; give `assertions`, or a `judge` (+ optional `rubric`), or both. */
export interface CompareOptions {
  /** Provider plugins, e.g. [bedrock()]. */
  plugins: ModelProviderPlugin[];
  /** Code checks every answer must pass. Optional. */
  assertions?: Assertion[];
  /** Optional LLM judge from evalladder/judge. Used when set; required if no assertions. */
  judge?: AssertionPlugin;
  /** What the judge scores against. Default: "The answer is correct, complete and follows the prompt." */
  rubric?: string;
  system?: string;
  settings?: ModelSettings;
  /** Retries per model call on retryable InfraError. Default 2. */
  retries?: number;
  /** Models called at once. Default: all of them. */
  concurrency?: number;
  /** Base backoff between retries in ms. Default 500. */
  backoffMs?: number;
}

/** One model's answer, ranked. */
export interface RankedOutput {
  /** 1 = best. Order: pass, then score, then lower cost, then lower latency. Errors last. */
  rank: number;
  productId: string;
  modelId: string;
  pass: boolean;
  /** Mean assertion score 0..1. 0 when the model call failed. */
  score: number;
  /** Model call + checks, USD. */
  costUsd: number;
  latencyMs: number;
  /** The model's answer. Empty when the model call failed. */
  text: string;
  /** Short why: failing check reasons, or the error. */
  reason: string;
  error?: string;
}

/** A normal RunReport (one case) plus the ranked answers. */
export interface CompareReport extends RunReport {
  ranking: RankedOutput[];
}

export const DEFAULT_RUBRIC = 'The answer is correct, complete and follows the prompt.';

/**
 * Run one prompt on every model in parallel, check each answer, rank them.
 * compare(): Promise<CompareReport>
 *   resolves: every model was tried. A wrong answer or a failed model call is a ranked row (pass:false), not a reject.
 *   rejects:  ConfigError only (no models, no checks, unknown provider), before any model call.
 */
export async function compare(prompt: string, models: ModelProduct[], opts: CompareOptions): Promise<CompareReport> {
  if (!prompt.trim()) throw new ConfigError('compare(): prompt is empty.');
  if (!models.length) throw new ConfigError('compare(): no models.');
  const assertions: Assertion[] = [...(opts.assertions ?? [])];
  if (opts.judge) assertions.push({ type: opts.judge.type, rubric: opts.rubric ?? DEFAULT_RUBRIC });
  if (!assertions.length) {
    throw new ConfigError('compare(): nothing to check. Pass assertions, or a judge from evalladder/judge.');
  }
  const runner = new DefaultEvalRunner(new ProviderRegistry().use(...opts.plugins), {
    assertionPlugins: opts.judge ? [opts.judge] : [],
    backoffMs: opts.backoffMs,
  });
  const report = await runner.run({
    suiteId: 'compare',
    // The prompt is passed as one var, so {{ }} inside it is kept as typed and the judge sees it.
    prompt: { id: 'compare', template: '{{prompt}}', system: opts.system },
    targets: models,
    cases: [{ id: 'prompt', vars: { prompt }, assertions }],
    passThreshold: 1,
    concurrency: opts.concurrency ?? models.length,
    retries: opts.retries,
    settings: opts.settings,
  });
  return { ...report, ranking: rank(report, models) };
}

function rank(report: RunReport, models: ModelProduct[]): RankedOutput[] {
  const rows = report.cases.map((c) => {
    const m = models.find((x) => x.id === c.productId)!;
    const scores = c.assertions.map((a) => a.score);
    const checkCost = c.assertions.reduce((s, a) => s + a.costUsd, 0);
    const failing = c.assertions.filter((a) => !a.pass).map((a) => `${a.type}: ${a.reason}`);
    return {
      rank: 0,
      productId: c.productId,
      modelId: m.modelId,
      pass: c.pass,
      score: c.error || !scores.length ? 0 : round(scores.reduce((s, x) => s + x, 0) / scores.length),
      costUsd: round((c.output?.costUsd ?? 0) + checkCost),
      latencyMs: c.output?.latencyMs ?? 0,
      text: c.output?.text ?? '',
      reason: c.error ?? (failing.length ? failing.join('; ') : 'all checks passed'),
      ...(c.error ? { error: c.error } : {}),
    } satisfies RankedOutput;
  });
  rows.sort(
    (a, b) =>
      Number(!!a.error) - Number(!!b.error) ||
      Number(b.pass) - Number(a.pass) ||
      b.score - a.score ||
      a.costUsd - b.costUsd ||
      a.latencyMs - b.latencyMs,
  );
  rows.forEach((r, i) => (r.rank = i + 1));
  return rows;
}

/** Markdown table of a CompareReport. */
export function compareToMarkdown(r: CompareReport): string {
  const lines = ['| # | Model | Pass | Score | Cost $ | Latency | Answer / reason |', '|---|---|---|---|---|---|---|'];
  for (const x of r.ranking) {
    const ans = (x.error ? `error: ${x.error}` : x.text).replace(/\s+/g, ' ').replace(/\|/g, '\\|').slice(0, 80);
    lines.push(`| ${x.rank} | ${x.modelId} | ${x.pass ? 'yes' : 'no'} | ${x.score.toFixed(2)} | $${x.costUsd.toFixed(6)} | ${x.latencyMs} ms | ${ans} |`);
  }
  lines.push('', `Total cost: $${r.totalCostUsd.toFixed(6)}`);
  return lines.join('\n');
}

const round = (n: number) => Math.round(n * 1e8) / 1e8;
