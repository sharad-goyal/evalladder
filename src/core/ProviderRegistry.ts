import type { ModelProduct, ModelProvider, ModelProviderPlugin } from './types.js';
import { InfraError } from './errors.js';

/** Maps ModelProduct.provider -> plugin. Used for BOTH models under test and judge models. */
export class ProviderRegistry {
  private plugins = new Map<string, ModelProviderPlugin>();
  private cache = new Map<string, ModelProvider>();

  use(...plugins: ModelProviderPlugin[]): this {
    for (const p of plugins) this.plugins.set(p.key, p);
    return this;
  }

  has(key: string): boolean {
    return this.plugins.has(key);
  }

  keys(): string[] {
    return [...this.plugins.keys()];
  }

  resolve(product: ModelProduct): ModelProvider {
    const hit = this.cache.get(product.id);
    if (hit) return hit;
    const plugin = this.plugins.get(product.provider);
    if (!plugin) {
      throw new InfraError(
        `No plugin registered for provider "${product.provider}" (product "${product.id}"). Registered: ${this.keys().join(', ') || 'none'}`,
        { retryable: false },
      );
    }
    const provider = plugin.create(product);
    this.cache.set(product.id, provider);
    return provider;
  }
}
