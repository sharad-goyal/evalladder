import { describe, it, expect } from 'vitest';
import { runProviderConformance, fakePromptfooLoader } from '../src/testkit/index.js';
import plugin from '../src/providers/openai/index.js';

const product = { id: 'openai-test', provider: 'openai', modelId: 'some-model', priceInPer1M: 1, priceOutPer1M: 4 };

describe('openai plugin conformance (same suite for every provider)', () => {
  it('passes the provider contract', async () => {
    const ok = fakePromptfooLoader({ output: 'pong', tokens: [12, 3] });
    const checks = await runProviderConformance({
      plugin: plugin({ loader: ok.loader }),
      product,
      makeFailing: () => plugin({ loader: fakePromptfooLoader({ error: '429 Too Many Requests' }).loader }),
    });
    for (const c of checks) expect(c.ok, `${c.name}: ${c.detail}`).toBe(true);
    expect(ok.seen[0].id).toBe('openai:chat:some-model');
  });

  it('resolves to a real promptfoo provider id (no network)', async () => {
    const { loadApiProvider } = await import('promptfoo');
    const p = await loadApiProvider('openai:chat:some-model');
    expect(typeof p.callApi).toBe('function');
  });

  it.skipIf(!process.env.EVALLADDER_LIVE_OPENAI_MODEL)('live call', async () => {
    const live = { ...product, modelId: process.env.EVALLADDER_LIVE_OPENAI_MODEL! };
    const checks = await runProviderConformance({ plugin: plugin(), product: live });
    for (const c of checks) expect(c.ok, `${c.name}: ${c.detail}`).toBe(true);
  }, 60_000);
});
