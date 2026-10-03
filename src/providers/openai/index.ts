import type { ModelProviderPlugin } from '../../core/index.js';
import { promptfooPlugin, type PluginOptions } from '../../promptfoo/index.js';

/**
 * OpenAI chat models. Reads OPENAI_API_KEY. OpenAI-compatible servers (vLLM, LM Studio): set options.apiBaseUrl.
 * ModelProduct: { provider: 'openai', modelId: '...' }
 */
export function openai(opts: PluginOptions = {}): ModelProviderPlugin {
  return promptfooPlugin('openai', (p) => `openai:chat:${p.modelId}`, opts);
}

export default openai;
