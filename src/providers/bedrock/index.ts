import type { ModelProviderPlugin } from '../../core/index.js';
import { promptfooPlugin, type PluginOptions } from '../../promptfoo/index.js';

/**
 * AWS Bedrock via the Converse API. Credentials come from the AWS SDK chain (OIDC role in CI, no static keys needed). Region: options.region.
 * ModelProduct: { provider: 'bedrock', modelId: '...' }
 */
export function bedrock(opts: PluginOptions = {}): ModelProviderPlugin {
  return promptfooPlugin('bedrock', (p) => `bedrock:converse:${p.modelId}`, opts);
}

export default bedrock;
