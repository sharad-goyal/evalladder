import {
  InfraError,
  isInfraError,
  AbsModelProvider,
  type ModelProduct,
  type ModelProviderPlugin,
  type PromptRequest,
  type RawCompletion,
} from '../core/index.js';

export type MockReply = string | RawCompletion | Error | ((req: PromptRequest, call: number) => string | RawCompletion | Error | Promise<string | RawCompletion | Error>);

/** Scripted provider for tests. Replies are consumed in order; the last one repeats. Errors are thrown. */
export class MockModelProvider extends AbsModelProvider {
  calls: PromptRequest[] = [];
  constructor(product: ModelProduct, private replies: MockReply[] = ['ok']) {
    super(product);
  }
  protected async doComplete(req: PromptRequest): Promise<RawCompletion> {
    this.calls.push(req);
    const n = this.calls.length - 1;
    let r = this.replies[Math.min(n, this.replies.length - 1)];
    if (typeof r === 'function') r = await r(req, n);
    if (r instanceof Error) throw r;
    return typeof r === 'string' ? { text: r, inputTokens: 10, outputTokens: 5 } : r;
  }
}

/** Plugin whose providers reply per product id. */
export function mockPlugin(key = 'mock', replies: Record<string, MockReply[]> = {}): ModelProviderPlugin & { providers: Map<string, MockModelProvider> } {
  const providers = new Map<string, MockModelProvider>();
  return {
    key,
    providers,
    create(p) {
      const m = new MockModelProvider(p, replies[p.id] ?? ['ok']);
      providers.set(p.id, m);
      return m;
    },
  };
}

/** A fake promptfoo ApiProvider, so plugins can be tested without network. */
export function fakePromptfooLoader(behavior: { output?: string; error?: string; throws?: string; tokens?: [number, number] } = {}) {
  const seen: Array<{ id: string; config?: Record<string, unknown>; prompts: string[] }> = [];
  const loader = async (id: string, opts?: { options?: { config?: Record<string, unknown> } }) => {
    const rec = { id, config: opts?.options?.config, prompts: [] as string[] };
    seen.push(rec);
    return {
      id: () => id,
      async callApi(prompt: string) {
        rec.prompts.push(prompt);
        if (behavior.throws) throw new Error(behavior.throws);
        if (behavior.error) return { error: behavior.error };
        const [pi, co] = behavior.tokens ?? [100, 20];
        return { output: behavior.output ?? 'hello', tokenUsage: { prompt: pi, completion: co, total: pi + co } };
      },
    };
  };
  return { loader, seen };
}

export interface ConformanceCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * The shared contract test every provider plugin must pass, run the same way for every model:
 * 1. plugin.key matches the product's provider
 * 2. complete() resolves a ModelResponse with the product's ids, numeric tokens/cost/latency
 * 3. cost equals tokens x ModelProduct price
 * 4. an infra failure rejects with InfraError (never resolves junk)
 * Pass `makeFailing` to build the same plugin wired to a failing transport for check 4.
 */
export async function runProviderConformance(opts: {
  plugin: ModelProviderPlugin;
  product: ModelProduct;
  makeFailing?: () => ModelProviderPlugin;
  request?: PromptRequest;
}): Promise<ConformanceCheck[]> {
  const out: ConformanceCheck[] = [];
  const add = (name: string, ok: boolean, detail = '') => out.push({ name, ok, detail });
  add('plugin key matches product.provider', opts.plugin.key === opts.product.provider, `${opts.plugin.key} vs ${opts.product.provider}`);
  const req = opts.request ?? { prompt: 'Reply with the single word: pong', maxTokens: 10, temperature: 0 };
  try {
    const r = await opts.plugin.create(opts.product).complete(req);
    add('resolves ModelResponse', typeof r.text === 'string', JSON.stringify(r).slice(0, 200));
    add('ids carried through', r.productId === opts.product.id && r.modelId === opts.product.modelId, `${r.productId}/${r.modelId}`);
    const nums = [r.inputTokens, r.outputTokens, r.costUsd, r.latencyMs].every((n) => typeof n === 'number' && n >= 0);
    add('tokens, cost, latency are numbers >= 0', nums);
    const expected =
      (r.inputTokens * (opts.product.priceInPer1M ?? 0) + r.outputTokens * (opts.product.priceOutPer1M ?? 0)) / 1e6;
    add('cost = tokens x price', Math.abs(r.costUsd - expected) < 1e-6, `${r.costUsd} vs ${expected}`);
  } catch (e) {
    add('resolves ModelResponse', false, e instanceof Error ? e.message : String(e));
  }
  if (opts.makeFailing) {
    try {
      await opts.makeFailing().create(opts.product).complete(req);
      add('infra failure rejects with InfraError', false, 'resolved instead of rejecting');
    } catch (e) {
      add('infra failure rejects with InfraError', isInfraError(e), e instanceof Error ? e.name : String(e));
    }
  }
  return out;
}

export { InfraError };
