import type { EvalSuite, ModelProviderPlugin } from './types.js';
import type { GateOptions } from './ReleaseGate.js';

export interface EvalladderConfig {
  /** Provider plugins to register, e.g. [openai(), bedrock()]. */
  plugins: ModelProviderPlugin[];
  suite: EvalSuite;
  gate?: Omit<GateOptions, 'baseline' | 'threshold'> & { threshold?: number };
}

export function defineConfig(c: EvalladderConfig): EvalladderConfig {
  return c;
}
