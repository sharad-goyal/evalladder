import { describe, it, expect } from 'vitest';
import { ProviderRegistry, DefaultEvalRunner, releaseGate, InfraError, ConfigError, toMarkdown, type EvalSuite, type ModelProduct } from '../src/core/index.js';
import { judge, parseVerdict } from '../src/judge/index.js';
import { mockPlugin } from '../src/testkit/index.js';

const cheapA: ModelProduct = { id: 'a', provider: 'mock', modelId: 'model-a', tier: 'cheap', priceInPer1M: 1, priceOutPer1M: 2 };
const cheapB: ModelProduct = { id: 'b', provider: 'mock', modelId: 'model-b', tier: 'cheap', priceInPer1M: 0.5, priceOutPer1M: 1 };
const judge1: ModelProduct = { id: 'j1', provider: 'mock', modelId: 'judge-cheap', tier: 'cheap', priceInPer1M: 1, priceOutPer1M: 1 };
const judge2: ModelProduct = { id: 'j2', provider: 'mock', modelId: 'judge-mid', tier: 'mid', priceInPer1M: 3, priceOutPer1M: 15 };
const judge3: ModelProduct = { id: 'j3', provider: 'mock', modelId: 'judge-top', tier: 'reasoning', priceInPer1M: 10, priceOutPer1M: 40 };

const suite = (over: Partial<EvalSuite> = {}): EvalSuite => ({
  suiteId: 's1',
  prompt: { id: 'p1', template: 'Classify: {{text}}' },
  targets: [cheapA, cheapB],
  cases: [
    { id: 'c1', vars: { text: 'refund please' }, assertions: [{ type: 'contains', value: 'billing', ignoreCase: true }] },
    { id: 'c2', vars: { text: 'app crashes' }, assertions: [{ type: 'contains', value: 'bug', ignoreCase: true }] },
  ],
  passThreshold: 0.5,
  ...over,
});

describe('runner', () => {
  it('runs every target x case, renders template, reports cost per model', async () => {
    const plugin = mockPlugin('mock', { a: [(i) => (i.prompt.includes('refund') ? 'billing' : 'bug')], b: ['billing'] });
    const report = await new DefaultEvalRunner(new ProviderRegistry().use(plugin), { backoffMs: 1 }).run(suite());
    expect(report.cases).toHaveLength(4);
    const a = report.models.find((m) => m.productId === 'a')!;
    const b = report.models.find((m) => m.productId === 'b')!;
    expect(a.passRate).toBe(1);
    expect(b.passRate).toBe(0.5);
    expect(a.cases).toBe(2);
    // 2 calls x (10 in * $1 + 5 out * $2) / 1M
    expect(a.modelCostUsd).toBeCloseTo(0.00004, 10);
    expect(a.assertionCostUsd).toBe(0);
    expect(plugin.providers.get('a')!.calls[0].prompt).toBe('Classify: refund please');
    expect(toMarkdown(report)).toContain('model-a');
  });

  it('a failing check resolves pass:false; it does not reject or kill the suite', async () => {
    const plugin = mockPlugin('mock', { a: ['nope'], b: ['billing'] });
    const report = await new DefaultEvalRunner(new ProviderRegistry().use(plugin), { backoffMs: 1 }).run(suite());
    const aCases = report.cases.filter((r) => r.productId === 'a');
    expect(aCases.every((r) => !r.pass && !r.error && r.assertions[0].pass === false)).toBe(true);
  });

  it('retries infra errors, then records error without killing other targets', async () => {
    const plugin = mockPlugin('mock', {
      a: [new InfraError('throttled'), 'billing'],
      b: [new InfraError('timeout')],
    });
    const report = await new DefaultEvalRunner(new ProviderRegistry().use(plugin), { backoffMs: 1 }).run(
      suite({ cases: [suite().cases[0]], retries: 1, concurrency: 1 }),
    );
    const a = report.cases.find((r) => r.productId === 'a')!;
    const b = report.cases.find((r) => r.productId === 'b')!;
    expect(a.pass).toBe(true);
    expect(b.error).toContain('timeout');
    expect(b.output).toBeUndefined();
    expect(report.models.find((m) => m.productId === 'b')!.errored).toBe(1);
    expect(plugin.providers.get('b')!.calls).toHaveLength(2); // 1 try + 1 retry
  });

  it('does not retry non-retryable errors (auth)', async () => {
    const plugin = mockPlugin('mock', { a: [new Error('API key is not set')] });
    const report = await new DefaultEvalRunner(new ProviderRegistry().use(plugin), { backoffMs: 1 }).run(
      suite({ targets: [cheapA], cases: [suite().cases[0]], retries: 3 }),
    );
    expect(report.cases[0].error).toContain('API key');
    expect(plugin.providers.get('a')!.calls).toHaveLength(1);
  });

  it('run() rejects with ConfigError for an unknown provider, before any model call', async () => {
    const plugin = mockPlugin('mock', { a: ['billing'] });
    const run = new DefaultEvalRunner(new ProviderRegistry().use(plugin)).run(suite({ targets: [cheapA, { ...cheapB, provider: 'nope' }] }));
    await expect(run).rejects.toBeInstanceOf(ConfigError);
    expect(plugin.providers.size).toBe(0);
  });

  it('run() rejects with ConfigError when an assertion type has no plugin (judge is off by default)', async () => {
    const s = suite({ cases: [{ id: 'r', vars: { text: 'x' }, assertions: [{ type: 'llm-rubric', rubric: 'polite?' }] }] });
    await expect(new DefaultEvalRunner(new ProviderRegistry().use(mockPlugin('mock'))).run(s)).rejects.toThrow(/no plugin handles it/);
  });
});

describe('built-in assertions', () => {
  it('equals, regex, is-json, not-contains, custom', async () => {
    const plugin = mockPlugin('mock', { a: ['```json\n{"label":"billing"}\n```'] });
    const report = await new DefaultEvalRunner(new ProviderRegistry().use(plugin)).run(
      suite({
        targets: [cheapA],
        cases: [
          {
            id: 'c',
            vars: { text: 'x' },
            assertions: [
              { type: 'is-json' },
              { type: 'regex', value: '"label":\\s*"billing"' },
              { type: 'not-contains', value: 'bug' },
              { type: 'custom', name: 'label is billing', fn: (o) => JSON.parse(o.text.replace(/```(json)?/g, '')).label === 'billing' },
            ],
          },
          { id: 'eq', vars: { text: 'x' }, assertions: [{ type: 'equals', value: 'billing' }] },
          { id: 'throws', vars: { text: 'x' }, assertions: [{ type: 'custom', fn: () => { throw new Error('boom'); } }] },
        ],
      }),
    );
    const c = report.cases.find((r) => r.caseId === 'c')!;
    expect(c.pass).toBe(true);
    expect(c.assertions.map((a) => a.type)).toEqual(['is-json', 'regex', 'not-contains', 'custom']);
    expect(c.assertions.every((a) => a.costUsd === 0)).toBe(true);
    expect(report.cases.find((r) => r.caseId === 'eq')!.pass).toBe(false);
    const t = report.cases.find((r) => r.caseId === 'throws')!;
    expect(t.pass).toBe(false);
    expect(t.assertions[0].reason).toMatch(/boom/);
  });
});

describe('judge plugin (optional)', () => {
  const run = async (replies: Parameters<typeof mockPlugin>[1], targets = [cheapA], extra: object[] = []) => {
    const plugin = mockPlugin('mock', replies);
    const registry = new ProviderRegistry().use(plugin);
    const s = suite({
      targets,
      cases: [{ id: 'r', vars: { text: 'x' }, assertions: [...(extra as any), { type: 'llm-rubric', rubric: 'Is it polite?' }] }],
    });
    const runner = new DefaultEvalRunner(registry, {
      assertionPlugins: [judge({ registry, ladder: [judge1, judge2, judge3], threshold: 0.7, nearThresholdBand: 0.1, maxHops: 2 })],
    });
    return { report: await runner.run(s), plugin };
  };

  it('cheap judge decides when confident', async () => {
    const { report, plugin } = await run({ a: ['hello'], j1: ['{"score":0.95,"reason":"polite"}'] });
    expect(report.cases[0].assertions[0]).toMatchObject({ type: 'llm-rubric', pass: true, checkedBy: 'judge-cheap' });
    expect(plugin.providers.has('j2')).toBe(false);
  });

  it('escalates on unparseable and near-threshold; stops at maxHops; cost lands in assertionCostUsd', async () => {
    const { report } = await run({
      a: ['hello'],
      j1: ['I think it is fine'],
      j2: ['{"score":0.72,"reason":"borderline"}'],
      j3: ['{"score":0.2,"reason":"rude"}'],
    });
    expect(report.cases[0].assertions[0]).toMatchObject({ pass: false, checkedBy: 'judge-top' });
    expect(report.models[0].assertionCostUsd).toBeGreaterThan(0);
  });

  it('infra error on a judge escalates instead of rejecting', async () => {
    const { report } = await run({ a: ['hello'], j1: [new InfraError('throttled')], j2: ['{"score":0.9,"reason":"ok"}'] });
    expect(report.cases[0].assertions[0]).toMatchObject({ pass: true, checkedBy: 'judge-mid' });
  });

  it('every judge answer unusable -> resolves pass:false "ungraded"', async () => {
    const { report } = await run({ a: ['hello'], j1: ['?'], j2: ['?'], j3: ['?'] });
    expect(report.cases[0].pass).toBe(false);
    expect(report.cases[0].assertions[0].reason).toMatch(/ungraded/);
  });

  it('no judge reachable -> InfraError, recorded as case error', async () => {
    const { report } = await run({ a: ['hello'], j1: [new InfraError('down', { retryable: false })], j2: [new InfraError('down')], j3: [new InfraError('down')] });
    expect(report.cases[0].error).toMatch(/no judge reachable/);
  });

  it('never lets a model judge itself', async () => {
    const { report } = await run({ j1: ['hello'], j2: ['{"score":0.9,"reason":"ok"}'] }, [judge1]);
    expect(report.cases[0].assertions[0].checkedBy).toBe('judge-mid');
  });

  it('skips the judge when a built-in assertion already failed', async () => {
    const { report, plugin } = await run({ a: ['nope'], j1: ['{"score":1,"reason":"x"}'] }, [cheapA], [{ type: 'contains', value: 'hello' }]);
    expect(report.cases[0].pass).toBe(false);
    expect(plugin.providers.has('j1')).toBe(false);
  });

  it('parseVerdict rejects out-of-range and junk', () => {
    expect(parseVerdict('{"score": 1.4}')).toBeNull();
    expect(parseVerdict('nothing')).toBeNull();
    expect(parseVerdict('Sure: {"score": 0.5, "reason": "meh"}')).toEqual({ score: 0.5, reason: 'meh' });
  });
});

describe('releaseGate', () => {
  const report = (a: number, b: number) =>
    ({
      models: [
        { productId: 'a', passRate: a },
        { productId: 'b', passRate: b },
      ],
    }) as any;

  it('passes only if every model >= threshold and >= baseline', () => {
    expect(releaseGate(report(0.9, 0.85), { threshold: 0.8 }).pass).toBe(true);
    expect(releaseGate(report(0.9, 0.7), { threshold: 0.8 }).pass).toBe(false);
    const g = releaseGate(report(0.9, 0.85), { threshold: 0.8, baseline: { a: 0.95 } });
    expect(g.pass).toBe(false);
    expect(g.models[0].reason).toMatch(/baseline/);
    expect(releaseGate(report(0.9, 0.85), { threshold: 0.8, baseline: report(0.91, 0.8), tolerance: 0.02 }).pass).toBe(true);
  });
});
