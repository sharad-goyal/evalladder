import type { ModelProduct, ModelProvider, ModelResponse, PromptRequest } from './types.js';
import { toInfraError } from './errors.js';
import { costUsd } from './cost.js';

export interface RawCompletion {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Base class for provider plugins. Subclasses implement doComplete() only.
 * This class adds timing, cost from the ModelProduct price, and the reject-only-on-infra rule.
 */
export abstract class AbsModelProvider implements ModelProvider {
  constructor(readonly product: ModelProduct) {}

  protected abstract doComplete(req: PromptRequest): Promise<RawCompletion>;

  async complete(req: PromptRequest): Promise<ModelResponse> {
    const t0 = performance.now();
    let raw: RawCompletion;
    try {
      raw = await this.doComplete(req);
    } catch (e) {
      throw toInfraError(e);
    }
    const inputTokens = raw.inputTokens ?? 0;
    const outputTokens = raw.outputTokens ?? 0;
    return {
      text: raw.text ?? '',
      productId: this.product.id,
      modelId: this.product.modelId,
      inputTokens,
      outputTokens,
      costUsd: costUsd(this.product, inputTokens, outputTokens),
      latencyMs: Math.round(performance.now() - t0),
    };
  }
}
