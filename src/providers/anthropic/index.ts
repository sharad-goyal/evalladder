import type { ModelProviderPlugin } from '../../core/index.js';
import { promptfooPlugin, type PluginOptions } from '../../promptfoo/index.js';

/**
 * Anthropic Messages API. Reads ANTHROPIC_API_KEY.
 * ModelProduct: { provider: 'anthropic', modelId: '...' }
 */
export function anthropic(opts: PluginOptions = {}): ModelProviderPlugin {
  return promptfooPlugin('anthropic', (p) => `anthropic:messages:${p.modelId}`, opts);
}

export default anthropic;
