import { describe, it, expect } from 'vitest';
import { ProviderRegistry, DefaultEvalRunner, releaseGate, InfraError, parseJudge, toMarkdown, type EvalSuite, type ModelProduct } from '../src/core/index.js';
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
    const plugin = mockPlugin('mock', { a: [(r) => (r.prompt.includes('refund') ? 'billing' : 'bug')], b: ['billing'] });
    const report = await new DefaultEvalRunner(new ProviderRegistry().use(plugin), { backoffMs: 1 }).run(suite());
    expect(report.results).toHaveLength(4);
    const a = report.byModel.find((m) => m.productId === 'a')!;
    const b = report.byModel.find((m) => m.productId === 'b')!;
    expect(a.passRate).toBe(1);
    expect(b.passRate).toBe(0.5);
    // 2 calls x (10 in * $1 + 5 out * $2) / 1M
    expect(a.modelCostUsd).toBeCloseTo(0.00004, 10);
    expect(plugin.providers.get('a')!.calls[0].prompt).toBe('Classify: refund please');
    expect(toMarkdown(report)).toContain('model-a');
  });

  it('a failing case resolves pass:false; it does not reject or kill the suite', async () => {
    const plugin = mockPlugin('mock', { a: ['nope'], b: ['billing'] });
    const report = await new DefaultEvalRunner(new ProviderRegistry().use(plugin), { backoffMs: 1 }).run(suite());
    expect(report.results.filter((r) => r.productId === 'a').every((r) => !r.grade.pass && !r.error)).toBe(true);
  });

  it('retries infra errors, then records error without killing other targets', async () => {
    const plugin = mockPlugin('mock', {
      a: [new InfraError('throttled'), 'billing'],
      b: [new InfraError('timeout')],
    });
    const report = await new DefaultEvalRunner(new ProviderRegistry().use(plugin), { backoffMs: 1 }).run(
      suite({ cases: [suite().cases[0]], retries: 1, concurrency: 1 }),
    );
    const a = report.results.find((r) => r.productId === 'a')!;
    const b = report.results.find((r) => r.productId === 'b')!;
    expect(a.grade.pass).toBe(true);
    expect(b.error).toContain('timeout');
    expect(report.byModel.find((m) => m.productId === 'b')!.errored).toBe(1);
    expect(plugin.providers.get('b')!.calls).toHaveLength(2); // 1 try + 1 retry
  });

  it('does not retry non-retryable errors (auth/config)', async () => {
    const plugin = mockPlugin('mock', { a: [new Error('API key is not set')] });
    const report = await new DefaultEvalRunner(new ProviderRegistry().use(plugin), { backoffMs: 1 }).run(
      suite({ targets: [cheapA], cases: [suite().cases[0]], retries: 3 }),
    );
    expect(report.results[0].error).toContain('API key');
    expect(plugin.providers.get('a')!.calls).toHaveLength(1);
  });

  it('unknown provider is an infra error on that target only', async () => {
    const report = await new DefaultEvalRunner(new ProviderRegistry().use(mockPlugin('mock', { a: ['billing'] }))).run(
      suite({ targets: [cheapA, { ...cheapB, provider: 'nope' }], cases: [suite().cases[0]] }),
    );
    expect(report.results.find((r) => r.productId === 'b')!.error).toMatch(/No plugin registered/);
    expect(report.results.find((r) => r.productId === 'a')!.grade.pass).toBe(true);
  });
});

describe('deterministic assertions', () => {
  it('equals, regex, is-json, not-contains, javascript', async () => {
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
              { type: 'javascript', fn: (o) => JSON.parse(o.replace(/```(json)?/g, '')).label === 'billing' },
            ],
          },
          { id: 'eq', vars: { text: 'x' }, assertions: [{ type: 'equals', value: 'billing' }] },
        ],
      }),
    );
    expect(report.results.find((r) => r.caseId === 'c')!.grade.pass).toBe(true);
    expect(report.results.find((r) => r.caseId === 'eq')!.grade.pass).toBe(false);
  });
});

describe('JudgeRouter', () => {
  const rubricSuite = (targets = [cheapA]) =>
    suite({
      targets,
      cases: [{ id: 'r', vars: { text: 'x' }, assertions: [{ type: 'llm-rubric', rubric: 'Is it polite?' }] }],
      graderPolicy: { tiers: [judge1, judge2, judge3], threshold: 0.7, nearThresholdBand: 0.1, maxHops: 2 },
    });

  it('cheap judge decides when confident (0 hops)', async () => {
    const plugin = mockPlugin('mock', { a: ['hello'], j1: ['{"score":0.95,"reason":"polite"}'] });
    const r = (await new DefaultEvalRunner(new ProviderRegistry().use(plugin)).run(rubricSuite())).results[0];
    expect(r.grade).toMatchObject({ pass: true, graderModelId: 'judge-cheap', hops: 0 });
    expect(plugin.providers.has('j2')).toBe(false);
  });

  it('escalates on unparseable, infra error and near-threshold; stops at maxHops', async () => {
    const plugin = mockPlugin('mock', {
      a: ['hello'],
      j1: ['I think it is fine'],
      j2: ['{"score":0.72,"reason":"borderline"}'],
      j3: ['{"score":0.2,"reason":"rude"}'],
    });
    const r = (await new DefaultEvalRunner(new ProviderRegistry().use(plugin)).run(rubricSuite())).results[0];
    expect(r.grade).toMatchObject({ pass: false, graderModelId: 'judge-top', hops: 2 });
    expect(r.grade.graderCostUsd).toBeGreaterThan(0);
  });

  it('infra error on a judge escalates instead of rejecting', async () => {
    const plugin = mockPlugin('mock', { a: ['hello'], j1: [new InfraError('throttled')], j2: ['{"score":0.9,"reason":"ok"}'] });
    const r = (await new DefaultEvalRunner(new ProviderRegistry().use(plugin)).run(rubricSuite())).results[0];
    expect(r.grade).toMatchObject({ pass: true, graderModelId: 'judge-mid', hops: 1 });
  });

  it('all judges fail -> resolves ungraded pass:false', async () => {
    const plugin = mockPlugin('mock', { a: ['hello'], j1: ['?'], j2: ['?'], j3: ['?'] });
    const r = (await new DefaultEvalRunner(new ProviderRegistry().use(plugin)).run(rubricSuite())).results[0];
    expect(r.grade.pass).toBe(false);
    expect(r.grade.reason).toMatch(/ungraded/);
  });

  it('never lets a model judge itself', async () => {
    const plugin = mockPlugin('mock', { j1: ['hello'], j2: ['{"score":0.9,"reason":"ok"}'] });
    const r = (await new DefaultEvalRunner(new ProviderRegistry().use(plugin)).run(rubricSuite([judge1]))).results[0];
    expect(r.grade.graderModelId).toBe('judge-mid');
  });

  it('skips the judge when a code assertion already failed', async () => {
    const plugin = mockPlugin('mock', { a: ['nope'], j1: ['{"score":1,"reason":"x"}'] });
    const s = rubricSuite();
    s.cases[0].assertions.unshift({ type: 'contains', value: 'hello' });
    const r = (await new DefaultEvalRunner(new ProviderRegistry().use(plugin)).run(s)).results[0];
    expect(r.grade.pass).toBe(false);
    expect(plugin.providers.has('j1')).toBe(false);
  });

  it('parseJudge rejects out-of-range and junk', () => {
    expect(parseJudge('{"score": 1.4}')).toBeNull();
    expect(parseJudge('nothing')).toBeNull();
    expect(parseJudge('Sure: {"score": 0.5, "reason": "meh"}')).toEqual({ score: 0.5, reason: 'meh' });
  });
});

describe('ReleaseGate', () => {
  const report = (a: number, b: number) =>
    ({
      byModel: [
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
