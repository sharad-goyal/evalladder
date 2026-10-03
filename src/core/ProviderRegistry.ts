import type { ModelProduct, ModelProvider, ModelProviderPlugin } from './types.js';
import { ConfigError } from './errors.js';

/** Maps ModelProduct.provider -> plugin. resolve() is synchronous and throws ConfigError for an unknown provider. */
export class ProviderRegistry {
  private plugins = new Map<string, ModelProviderPlugin>();
  private cache = new Map<string, ModelProvider>();

  use(...plugins: ModelProviderPlugin[]): this {
    for (const p of plugins) this.plugins.set(p.key, p);
    return this;
  }

  /** @internal */
  has(key: string): boolean {
    return this.plugins.has(key);
  }

  /** @internal */
  keys(): string[] {
    return [...this.plugins.keys()];
  }

  resolve(product: ModelProduct): ModelProvider {
    const hit = this.cache.get(product.id);
    if (hit) return hit;
    const plugin = this.plugins.get(product.provider);
    if (!plugin) {
      throw new ConfigError(
        `No plugin registered for provider "${product.provider}" (product "${product.id}"). Registered: ${this.keys().join(', ') || 'none'}`,
      );
    }
    const provider = plugin.create(product);
    this.cache.set(product.id, provider);
    return provider;
  }
}
