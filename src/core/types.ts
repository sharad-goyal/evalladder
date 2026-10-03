// DTOs and interfaces. Read top to bottom: each step takes one DTO in and returns one DTO out.
//
//   EvalSuite --EvalRunner.run--> Promise<RunReport>
//     TestCase + PromptTemplate --render--> ModelInput
//     ModelInput --ModelProvider.complete--> Promise<ModelOutput>
//     ModelOutput + Assertion --check--> Promise<AssertionResult>
//     AssertionResult[] --> CaseResult --> ModelSummary --> RunReport
//   RunReport --releaseGate--> GateDecision
//
// Promise rules (same everywhere):
//   resolve = the step ran. A failed check is a normal result (pass: false), not an error.
//   reject  = the step could not run: InfraError (network, throttle, 5xx, auth) or ConfigError (bad setup).

/** Price/capability tier. Plugins (e.g. evalladder/judge) can use it to pick a cheap model first. */
export type Tier = 'cheap' | 'mid' | 'reasoning';

/**
 * One model you can call, described as data (e.g. a row in your products table).
 * Add a model = add one ModelProduct. `provider` picks the plugin.
 */
export interface ModelProduct {
  /** Your stable id for this row, e.g. "bedrock-nova-lite". */
  id: string;
  /** Plugin key: "bedrock" | "openai" | "anthropic" | "gemini" | "ollama" | your own. */
  provider: string;
  /** Vendor model id, e.g. "us.amazon.nova-lite-v1:0". */
  modelId: string;
  tier?: Tier;
  /** USD per 1M input tokens, used for cost. */
  priceInPer1M?: number;
  /** USD per 1M output tokens. */
  priceOutPer1M?: number;
  /** Plugin options (region, base URL...). Never raw secrets. */
  options?: Record<string, unknown>;
}

// ---------- Inputs ----------

/** The prompt under test. {{var}} placeholders are filled from TestCase.vars. */
export interface PromptTemplate {
  id: string;
  template: string;
  system?: string;
}

/** Built-in checks. Deterministic, no model call, $0. */
export type BuiltinAssertion =
  | { type: 'equals'; value: string; ignoreCase?: boolean }
  | { type: 'contains'; value: string; ignoreCase?: boolean }
  | { type: 'not-contains'; value: string; ignoreCase?: boolean }
  | { type: 'regex'; value: string; flags?: string }
  | { type: 'is-json' }
  | { type: 'custom'; name?: string; fn: (output: ModelOutput, testCase: TestCase) => boolean | Promise<boolean> };

/**
 * A check handled by an AssertionPlugin you register on the runner,
 * e.g. { type: 'llm-rubric', rubric: '...' } from evalladder/judge. Off unless registered.
 */
export interface PluginAssertion {
  type: string;
  [key: string]: unknown;
}

export type Assertion = BuiltinAssertion | PluginAssertion;

/** One test input: values for the template + the checks its output must pass. */
export interface TestCase {
  id: string;
  vars: Record<string, string>;
  assertions: Assertion[];
}

/** What a run needs: one prompt, N models, M test cases. */
export interface EvalSuite {
  suiteId: string;
  prompt: PromptTemplate;
  /** Models under test. Every case runs against every target. */
  targets: ModelProduct[];
  cases: TestCase[];
  /** Pass-rate threshold for the release gate (0..1). */
  passThreshold: number;
  /** Max parallel model calls. Default 4. */
  concurrency?: number;
  /** Retries per model call on a retryable InfraError. Default 2. */
  retries?: number;
  /** Fixed settings for every model call. */
  settings?: ModelSettings;
}

export interface ModelSettings {
  maxTokens?: number;
  temperature?: number;
}

// ---------- Step 1: model call ----------

/** Input to one model call (template already rendered). */
export interface ModelInput extends ModelSettings {
  prompt: string;
  system?: string;
}

/** Output of one model call. */
export interface ModelOutput {
  productId: string;
  modelId: string;
  text: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
}

/**
 * One per vendor model. Implement via AbsModelProvider.
 * complete(): Promise<ModelOutput>
 *   resolves: the model answered (any text, even a wrong answer)
 *   rejects:  InfraError only (throttle, timeout, 5xx, auth)
 */
export interface ModelProvider {
  readonly product: ModelProduct;
  complete(input: ModelInput): Promise<ModelOutput>;
}

/** Turns a ModelProduct row into a ModelProvider. One plugin per vendor. */
export interface ModelProviderPlugin {
  /** Matches ModelProduct.provider. */
  key: string;
  create(product: ModelProduct): ModelProvider;
}

// ---------- Step 2: assertions ----------

/** Output of one assertion. */
export interface AssertionResult {
  /** Assertion type, e.g. "regex" or "llm-rubric". */
  type: string;
  pass: boolean;
  /** 0..1. Built-ins give 1 or 0. */
  score: number;
  reason: string;
  /** USD spent on this check. 0 for built-ins. */
  costUsd: number;
  /** Model that did the check, if a plugin used one. */
  checkedBy?: string;
}

/**
 * Opt-in assertion type (e.g. the LLM judge). Register on the runner.
 * check(): Promise<AssertionResult>
 *   resolves: the check ran; pass true or false
 *   rejects:  InfraError only (the check could not run)
 */
export interface AssertionPlugin {
  type: string;
  check(assertion: PluginAssertion, output: ModelOutput, testCase: TestCase): Promise<AssertionResult>;
}

// ---------- Step 3: results ----------

/** One test case on one model. */
export interface CaseResult {
  caseId: string;
  productId: string;
  /** True when the model answered and every assertion passed. */
  pass: boolean;
  /** Missing when the model call failed. */
  output?: ModelOutput;
  assertions: AssertionResult[];
  /** Set when the model call or a check could not run (after retries). Counts as not passed. */
  error?: string;
}

/** Totals for one model. */
export interface ModelSummary {
  productId: string;
  provider: string;
  modelId: string;
  cases: number;
  passed: number;
  failed: number;
  errored: number;
  /** passed / cases */
  passRate: number;
  /** USD spent on the model under test. */
  modelCostUsd: number;
  /** USD spent by assertion plugins (e.g. judge calls). */
  assertionCostUsd: number;
  totalCostUsd: number;
  avgLatencyMs: number;
}

/** Output of a run. */
export interface RunReport {
  suiteId: string;
  promptId: string;
  startedAt: string;
  finishedAt: string;
  models: ModelSummary[];
  cases: CaseResult[];
  totalCostUsd: number;
}

/**
 * run(): Promise<RunReport>
 *   resolves: always once the suite is valid. Model/check failures are recorded per case.
 *   rejects:  ConfigError only (unknown provider, no handler for an assertion type, empty suite).
 */
export interface EvalRunner {
  run(suite: EvalSuite): Promise<RunReport>;
}

// ---------- Step 4: release gate ----------

export interface GateModelDecision {
  productId: string;
  passRate: number;
  threshold: number;
  baseline?: number;
  pass: boolean;
  reason: string;
}

/** Output of releaseGate(report). Synchronous, no Promise. */
export interface GateDecision {
  pass: boolean;
  models: GateModelDecision[];
}
