import type { ModelProviderPlugin } from '../../core/index.js';
import { promptfooPlugin, type PluginOptions } from '../../promptfoo/index.js';

/**
 * Local models through Ollama. Server: options.apiBaseUrl or OLLAMA_BASE_URL.
 * ModelProduct: { provider: 'ollama', modelId: '...' }
 */
export function ollama(opts: PluginOptions = {}): ModelProviderPlugin {
  return promptfooPlugin('ollama', (p) => `ollama:chat:${p.modelId}`, opts);
}

export default ollama;
