import type { ModelProduct, ModelProvider, ModelOutput, ModelInput } from './types.js';
import { toInfraError } from './errors.js';
import { costUsd } from './cost.js';

export interface RawCompletion {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Base class for provider plugins. Subclasses implement doComplete() only.
 * This class adds timing, cost from the ModelProduct price, and the reject-only-on-infra rule:
 * complete(input): Promise<ModelOutput>, rejects with InfraError only.
 */
export abstract class AbsModelProvider implements ModelProvider {
  constructor(readonly product: ModelProduct) {}

  /** Call the vendor. Throw anything on failure; complete() turns it into an InfraError. */
  protected abstract doComplete(input: ModelInput): Promise<RawCompletion>;

  async complete(input: ModelInput): Promise<ModelOutput> {
    const t0 = performance.now();
    let raw: RawCompletion;
    try {
      raw = await this.doComplete(input);
    } catch (e) {
      throw toInfraError(e);
    }
    const inputTokens = raw.inputTokens ?? 0;
    const outputTokens = raw.outputTokens ?? 0;
    return {
      productId: this.product.id,
      modelId: this.product.modelId,
      text: raw.text ?? '',
      inputTokens,
      outputTokens,
      costUsd: costUsd(this.product, inputTokens, outputTokens),
      latencyMs: Math.round(performance.now() - t0),
    };
  }
}
