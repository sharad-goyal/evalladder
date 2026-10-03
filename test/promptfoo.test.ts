import { describe, it, expect } from 'vitest';
import { PromptfooModelProvider, toPromptfooPrompt, promptfooRaw } from '../src/promptfoo/index.js';
import { fakePromptfooLoader } from '../src/testkit/index.js';
import { isInfraError } from '../src/core/index.js';

const product = { id: 'x', provider: 'promptfoo', modelId: 'openai:chat:m', priceInPer1M: 2, priceOutPer1M: 8, options: { region: 'us-east-1' } };

describe('PromptfooModelProvider', () => {
  it('sends system prompt as chat array and passes options + request params as config', async () => {
    const f = fakePromptfooLoader({ output: 'hi', tokens: [1000, 500] });
    const p = new PromptfooModelProvider(product, 'openai:chat:m', f.loader);
    const r = await p.complete({ prompt: 'q', system: 's', temperature: 0, maxTokens: 50 });
    expect(JSON.parse(f.seen[0].prompts[0])).toEqual([{ role: 'system', content: 's' }, { role: 'user', content: 'q' }]);
    expect(f.seen[0].config).toEqual({ region: 'us-east-1', temperature: 0, max_tokens: 50 });
    expect(r.costUsd).toBeCloseTo((1000 * 2 + 500 * 8) / 1e6, 10);
  });
  it('plain prompt without system', () => expect(toPromptfooPrompt({ prompt: 'q' })).toBe('q'));
  it('returned and thrown promptfoo errors reject as InfraError', async () => {
    for (const b of [{ error: 'boom' }, { throws: 'API key is not set' }]) {
      const p = new PromptfooModelProvider(product, 'id', fakePromptfooLoader(b).loader);
      await expect(p.complete({ prompt: 'q' })).rejects.toSatisfy(isInfraError);
    }
  });
  it('raw plugin passes modelId through as the promptfoo id', async () => {
    const f = fakePromptfooLoader();
    await promptfooRaw({ loader: f.loader }).create(product).complete({ prompt: 'q' });
    expect(f.seen[0].id).toBe('openai:chat:m');
  });
});
