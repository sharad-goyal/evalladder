import type { ModelProviderPlugin } from '../../core/index.js';
import { promptfooPlugin, type PluginOptions } from '../../promptfoo/index.js';

/**
 * Google Gemini. AI Studio by default (GOOGLE_API_KEY); set options.vertex = true for Vertex AI.
 * ModelProduct: { provider: 'gemini', modelId: '...' }
 */
export function gemini(opts: PluginOptions = {}): ModelProviderPlugin {
  return promptfooPlugin('gemini', (p) => (p.options?.vertex ? `vertex:${p.modelId}` : `google:${p.modelId}`), opts);
}

export default gemini;
