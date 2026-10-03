// Simulation: scripted good / sloppy / wrong / slow / flaky / down models, no keys.
// Exercises run() and compare() end to end: assertions, opt-in judge, retries, typed errors, ranking, release gate.
import { describe, it, expect } from 'vitest';
import {
  compare, DefaultEvalRunner, ProviderRegistry, releaseGate, ConfigError, type EvalSuite, type RunReport,
} from '../../src/core/index.js';
import { judge } from '../../src/judge/index.js';
import { good, sloppy, wrong, slow, flaky, down, noAuth, judgeCheap, judgeTop, simPlugin } from './models.js';

const TRIAGE = 'Classify the message as billing, bug or other. Reply with JSON only: {"category": "...", "reply": "..."}';
const isBilling = [{ type: 'is-json' as const }, { type: 'regex' as const, value: '"category"\\s*:\\s*"billing"' }];

const suite = (over: Partial<EvalSuite> = {}): EvalSuite => ({
  suiteId: 'sim',
  prompt: { id: 'triage', template: `${TRIAGE}\n\nMessage: {{text}}` },
  targets: [good, sloppy, wrong],
  cases: [
    { id: 'refund', vars: { text: 'I was charged twice' }, assertions: [{ type: 'is-json' }, { type: 'regex', value: '"category"\\s*:\\s*"billing"' }] },
    { id: 'crash', vars: { text: 'The app closes on start' }, assertions: [{ type: 'is-json' }, { type: 'regex', value: '"category"\\s*:\\s*"bug"' }] },
    { id: 'hello', vars: { text: 'Just saying hi' }, assertions: [{ type: 'is-json' }, { type: 'regex', value: '"category"\\s*:\\s*"other"' }] },
  ],
  passThreshold: 0.8,
  retries: 2,
  ...over,
});

const runner = (plugin = simPlugin(), judgePlugin?: ReturnType<typeof judge>) =>
  new DefaultEvalRunner(new ProviderRegistry().use(plugin), { backoffMs: 1, assertionPlugins: judgePlugin ? [judgePlugin] : [] });

const mkJudge = (plugin = simPlugin()) => judge({ registry: new ProviderRegistry().use(plugin), ladder: [judgeCheap, judgeTop], threshold: 0.7 });
const rate = (r: RunReport, id: string) => r.models.find((m) => m.productId === id)!.passRate;

describe('simulation: run() across all models', () => {
  it('S1 every model x every case runs; pass rate per model matches its personality', async () => {
    const r = await runner().run(suite());
    expect(r.cases).toHaveLength(9);
    expect(rate(r, 'good')).toBe(1);
    expect(rate(r, 'sloppy')).toBe(0); // not JSON
    expect(rate(r, 'wrong')).toBeCloseTo(1 / 3, 3); // only "other" is right
  });

  it('S2 a failed check is a result (pass:false with reason), not an error', async () => {
    const r = await runner().run(suite({ targets: [sloppy] }));
    expect(r.cases.every((c) => !c.pass && !c.error)).toBe(true);
    expect(r.cases[0].assertions[0]).toMatchObject({ type: 'is-json', pass: false, costUsd: 0 });
  });

  it('S3 retryable InfraError (throttle) is retried and then passes', async () => {
    const plugin = simPlugin();
    const r = await runner(plugin).run(suite({ targets: [flaky], cases: [suite().cases[0]], concurrency: 1 }));
    expect(r.cases[0].pass).toBe(true);
    expect(plugin.providers.get('flaky')!.calls).toHaveLength(3);
  });

  it('S4 a model that is down is recorded as errored; other models still finish', async () => {
    const r = await runner().run(suite({ targets: [good, down] }));
    const d = r.models.find((m) => m.productId === 'down')!;
    expect(d.errored).toBe(3);
    expect(r.cases.find((c) => c.productId === 'down')!.error).toContain('503');
    expect(rate(r, 'good')).toBe(1);
  });

  it('S5 non-retryable InfraError (401) is not retried', async () => {
    const plugin = simPlugin();
    await runner(plugin).run(suite({ targets: [noAuth], cases: [suite().cases[0]] }));
    expect(plugin.providers.get('no-auth')!.calls).toHaveLength(1);
  });

  it('S6 models run in parallel (3 slow calls take about one call, not three)', async () => {
    const t0 = Date.now();
    await runner().run(suite({ targets: [slow], concurrency: 3 }));
    expect(Date.now() - t0).toBeLessThan(400);
  });
});

describe('simulation: typed rejects (ConfigError) before any model call', () => {
  it('S7 unknown provider', async () => {
    const plugin = simPlugin();
    await expect(runner(plugin).run(suite({ targets: [{ ...good, provider: 'nope' }] }))).rejects.toBeInstanceOf(ConfigError);
    expect(plugin.providers.size).toBe(0);
  });

  it('S8 llm-rubric used but judge not registered (judge is off by default)', async () => {
    const s = suite({ cases: [{ id: 'tone', vars: { text: 'hi' }, assertions: [{ type: 'llm-rubric', rubric: 'polite' }] }] });
    await expect(runner().run(s)).rejects.toBeInstanceOf(ConfigError);
  });

  it('S9 compare(): empty prompt, no models, nothing to check', async () => {
    const plugins = [simPlugin()];
    await expect(compare('', [good], { plugins, assertions: isBilling })).rejects.toBeInstanceOf(ConfigError);
    await expect(compare('hi', [], { plugins, assertions: isBilling })).rejects.toBeInstanceOf(ConfigError);
    await expect(compare('hi', [good], { plugins })).rejects.toBeInstanceOf(ConfigError);
  });
});

describe('simulation: opt-in judge', () => {
  it('S10 with the judge registered, llm-rubric is scored and says which model judged', async () => {
    const plugin = simPlugin();
    const s = suite({ targets: [good, sloppy], cases: [{ id: 'tone', vars: { text: 'charged twice' }, assertions: [{ type: 'llm-rubric', rubric: 'JSON with a polite reply' }] }] });
    const r = await runner(plugin, mkJudge(plugin)).run(s);
    const g = r.cases.find((c) => c.productId === 'good')!.assertions[0];
    const b = r.cases.find((c) => c.productId === 'sloppy')!.assertions[0];
    expect(g).toMatchObject({ type: 'llm-rubric', pass: true, score: 0.9, checkedBy: 'sim-judge-cheap' });
    expect(b).toMatchObject({ pass: false, score: 0.2 });
    expect(g.costUsd).toBeGreaterThan(0);
  });

  it('S11 judge runs only if code checks pass (no judge cost on a failed case)', async () => {
    const plugin = simPlugin();
    const s = suite({ targets: [sloppy], cases: [{ id: 't', vars: { text: 'charged' }, assertions: [{ type: 'is-json' }, { type: 'llm-rubric', rubric: 'polite' }] }] });
    const r = await runner(plugin, mkJudge(plugin)).run(s);
    expect(r.models[0].assertionCostUsd).toBe(0);
    expect(plugin.providers.has('judge-cheap')).toBe(false);
  });
});

describe('simulation: compare() one prompt, all models, ranked', () => {
  const PROMPT = `${TRIAGE}\n\nMessage: I was charged twice`;

  it('S12 code checks: ranked good/slow first, errors last; text, cost, latency filled', async () => {
    const r = await compare(PROMPT, [down, wrong, sloppy, slow, good], { plugins: [simPlugin()], assertions: isBilling, backoffMs: 1 });
    const order = r.ranking.map((x) => x.productId);
    expect(order.slice(0, 2).sort()).toEqual(['good', 'slow']);
    expect(order[order.length - 1]).toBe('down');
    const top = r.ranking[0];
    expect(top).toMatchObject({ rank: 1, pass: true, score: 1 });
    expect(top.text).toContain('billing');
    expect(top.costUsd).toBeGreaterThan(0);
    expect(r.ranking.find((x) => x.productId === 'down')).toMatchObject({ pass: false, score: 0, text: '' });
    expect(r.ranking.find((x) => x.productId === 'sloppy')!.reason).toContain('is-json');
  });

  it('S13 ties on pass and score break on cost, then latency', async () => {
    const r = await compare(PROMPT, [good, slow], { plugins: [simPlugin()], assertions: isBilling });
    expect(r.ranking[0].productId).toBe('slow'); // same result, cheaper
  });

  it('S14 judge only (free-form answer): scored by the judge, cost includes the judge', async () => {
    const plugin = simPlugin();
    const r = await compare('Tell a customer we are fixing the crash.', [good, sloppy], { plugins: [plugin], judge: mkJudge(plugin) });
    expect(r.ranking.map((x) => x.productId)).toEqual(['good', 'sloppy']);
    expect(r.ranking[0].score).toBe(0.9);
    const judgeSawPrompt = plugin.providers.get('judge-cheap')!.calls[0].prompt;
    expect(judgeSawPrompt).toContain('fixing the crash');
    expect(r.ranking[0].costUsd).toBeGreaterThan(r.cases[0].output!.costUsd);
  });

  it('S15 {{ }} in the prompt is sent as typed', async () => {
    const plugin = simPlugin();
    await compare('Fill {{name}} in JSON', [good], { plugins: [plugin], assertions: [{ type: 'is-json' }] });
    expect(plugin.providers.get('good')!.calls[0].prompt).toBe('Fill {{name}} in JSON');
  });

  it('S16 the result is also a normal RunReport (works with releaseGate)', async () => {
    const r = await compare(PROMPT, [good, wrong], { plugins: [simPlugin()], assertions: isBilling });
    expect(r.models).toHaveLength(2);
    expect(releaseGate(r, { threshold: 1 }).pass).toBe(false);
  });
});

describe('simulation: release gate', () => {
  it('S17 passes when every model meets the threshold', async () => {
    const r = await runner().run(suite({ targets: [good, slow] }));
    expect(releaseGate(r, { threshold: 0.8 }).pass).toBe(true);
  });

  it('S18 fails when one model is under the threshold, with a reason', async () => {
    const r = await runner().run(suite({ targets: [good, wrong] }));
    const g = releaseGate(r, { threshold: 0.8 });
    expect(g.pass).toBe(false);
    expect(g.models.find((m) => m.productId === 'wrong')!.reason).toContain('threshold');
  });

  it('S19 fails on regression vs last run, even above the threshold', async () => {
    const r = await runner().run(suite({ targets: [wrong] }));
    const g = releaseGate(r, { threshold: 0.2, baseline: { wrong: 1 } });
    expect(g.pass).toBe(false);
    expect(g.models[0].reason).toContain('baseline');
  });

  it('S20 errored cases count as not passed (an outage fails the gate)', async () => {
    const r = await runner().run(suite({ targets: [down] }));
    expect(releaseGate(r, { threshold: 0.1 }).pass).toBe(false);
  });
});
