import { AbsModelProvider, InfraError, type ModelProduct, type ModelProviderPlugin, type ModelInput, type RawCompletion } from '../core/index.js';

/** Minimal slice of a promptfoo ApiProvider we rely on. */
export interface PromptfooApiProvider {
  id(): string;
  callApi(prompt: string, context?: unknown, options?: unknown): Promise<{
    output?: unknown;
    error?: string;
    tokenUsage?: { prompt?: number; completion?: number; total?: number };
  }>;
}

export type PromptfooLoader = (providerId: string, opts?: { options?: { config?: Record<string, unknown> } }) => Promise<PromptfooApiProvider>;

/** Default loader: promptfoo's loadApiProvider (promptfoo is a peer dependency). */
export const defaultLoader: PromptfooLoader = async (id, opts) => {
  const mod = (await import('promptfoo')) as unknown as { loadApiProvider: PromptfooLoader };
  return mod.loadApiProvider(id, opts);
};

/** Build the promptfoo prompt. With a system prompt we send a chat array, which promptfoo chat providers accept. */
export function toPromptfooPrompt(input: ModelInput): string {
  if (!input.system) return input.prompt;
  return JSON.stringify([
    { role: 'system', content: input.system },
    { role: 'user', content: input.prompt },
  ]);
}

/**
 * Runs one ModelProduct through promptfoo. Vendor plugins only supply the promptfoo provider id.
 * promptfoo errors (returned or thrown) become InfraError rejects.
 */
export class PromptfooModelProvider extends AbsModelProvider {
  private apiProvider?: Promise<PromptfooApiProvider>;

  constructor(product: ModelProduct, private providerId: string, private loader: PromptfooLoader = defaultLoader) {
    super(product);
  }

  protected async doComplete(input: ModelInput): Promise<RawCompletion> {
    this.apiProvider ??= this.loader(this.providerId, { options: { config: this.config(input) } });
    const api = await this.apiProvider;
    const res = await api.callApi(toPromptfooPrompt(input));
    if (res.error) throw new InfraError(res.error);
    const output = res.output;
    return {
      text: typeof output === 'string' ? output : JSON.stringify(output ?? ''),
      inputTokens: res.tokenUsage?.prompt,
      outputTokens: res.tokenUsage?.completion,
    };
  }

  private config(input: ModelInput): Record<string, unknown> {
    const c: Record<string, unknown> = { ...(this.product.options ?? {}) };
    if (input.temperature !== undefined) c.temperature ??= input.temperature;
    if (input.maxTokens !== undefined) c.max_tokens ??= input.maxTokens;
    return c;
  }
}

export interface PluginOptions {
  loader?: PromptfooLoader;
}

/** Helper for writing a plugin: key + how to map a ModelProduct to a promptfoo provider id. */
export function promptfooPlugin(key: string, toId: (p: ModelProduct) => string, opts: PluginOptions = {}): ModelProviderPlugin {
  return { key, create: (p) => new PromptfooModelProvider(p, toId(p), opts.loader) };
}

/** Escape hatch: ModelProduct.modelId is already a full promptfoo id (e.g. "file://my-provider.js", "https://..."). */
export const promptfooRaw = (opts: PluginOptions = {}) => promptfooPlugin('promptfoo', (p) => p.modelId, opts);
