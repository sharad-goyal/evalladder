import type { AssertionPlugin, EvalSuite, ModelProduct, ModelProviderPlugin } from './types.js';
import type { GateOptions } from './ReleaseGate.js';

export interface EvalladderConfig {
  /** Provider plugins to register, e.g. [openai(), bedrock()]. */
  plugins: ModelProviderPlugin[];
  /** Opt-in assertion types, e.g. [judge({...})] from evalladder/judge. */
  assertionPlugins?: AssertionPlugin[];
  /** Needed for `evalladder run`. */
  suite?: EvalSuite;
  /** Models for `evalladder compare`. Defaults to suite.targets. */
  models?: ModelProduct[];
  gate?: Omit<GateOptions, 'baseline' | 'threshold'> & { threshold?: number };
}

export function defineConfig(c: EvalladderConfig): EvalladderConfig {
  return c;
}
