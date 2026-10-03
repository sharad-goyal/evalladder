// DTOs and interfaces. Every model call is async and returns Promise<typed DTO>.

/** Price/capability tier used by JudgeRouter escalation. */
export type Tier = 'cheap' | 'mid' | 'reasoning';

/**
 * One model you can call, described as config (not code).
 * Add a model = add one ModelProduct. `provider` picks the plugin.
 */
export interface ModelProduct {
  /** Your stable id for this row, e.g. "openai-mini". */
  id: string;
  /** Plugin key, e.g. "bedrock" | "openai" | "anthropic" | "gemini" | "ollama" | your own. */
  provider: string;
  /** Vendor model id, e.g. "gpt-4o-mini". */
  modelId: string;
  tier?: Tier;
  /** USD per 1M input tokens, used for cost reporting. */
  priceInPer1M?: number;
  /** USD per 1M output tokens. */
  priceOutPer1M?: number;
  /** Plugin-specific options (region, apiBaseUrl, temperature...). Never put raw secrets here. */
  options?: Record<string, unknown>;
}

export interface PromptRequest {
  prompt: string;
  system?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface ModelResponse {
  text: string;
  productId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
}

/**
 * Contract every provider plugin implements.
 * Resolve with a ModelResponse. Reject ONLY with InfraError (throttle, timeout, 5xx, auth, config).
 */
export interface ModelProvider {
  readonly product: ModelProduct;
  complete(req: PromptRequest): Promise<ModelResponse>;
}

/** A plugin turns a ModelProduct row into a ModelProvider. One plugin per vendor. */
export interface ModelProviderPlugin {
  /** Matches ModelProduct.provider. */
  key: string;
  create(product: ModelProduct): ModelProvider;
}

export interface PromptVersion {
  id: string;
  /** Template with {{var}} placeholders. */
  template: string;
  system?: string;
}

export type Assertion =
  | { type: 'equals'; value: string; ignoreCase?: boolean }
  | { type: 'contains'; value: string; ignoreCase?: boolean }
  | { type: 'not-contains'; value: string; ignoreCase?: boolean }
  | { type: 'regex'; value: string; flags?: string }
  | { type: 'is-json' }
  | { type: 'javascript'; fn: (output: string, tc: TestCase) => boolean | GradeResult | Promise<boolean | GradeResult> }
  | { type: 'llm-rubric'; rubric: string };

export interface TestCase {
  id: string;
  vars: Record<string, string>;
  assertions: Assertion[];
}

export interface GraderPolicy {
  /** Judge models, cheapest first. Escalation walks this list. */
  tiers: ModelProduct[];
  /** Max escalations after the first judge call. Default 2. */
  maxHops?: number;
  /** Score at or above this passes. Default 0.7. */
  threshold?: number;
  /** Escalate when |score - threshold| < band. Default 0.1. */
  nearThresholdBand?: number;
}

export interface EvalSuite {
  suiteId: string;
  prompt: PromptVersion;
  /** Models under test. Same cases run against every target. */
  targets: ModelProduct[];
  cases: TestCase[];
  graderPolicy?: GraderPolicy;
  /** Default pass-rate threshold for ReleaseGate. */
  passThreshold: number;
  /** Max parallel model calls. Default 4. */
  concurrency?: number;
  /** Retries on InfraError per call. Default 2. */
  retries?: number;
  request?: Omit<PromptRequest, 'prompt' | 'system'>;
}

export interface GradeResult {
  pass: boolean;
  score: number;
  reason: string;
  graderModelId?: string;
  /** Judge escalations used (0 = first judge decided). */
  hops?: number;
  graderCostUsd?: number;
}

/** Grader contract. A failing case resolves pass:false. Reject only on infra errors. */
export interface Grader {
  grade(tc: TestCase, out: ModelResponse): Promise<GradeResult>;
}

export interface CaseResult {
  caseId: string;
  productId: string;
  modelId: string;
  response?: ModelResponse;
  grade: GradeResult;
  /** Set when the model call failed after retries (infra). Counts as not passed. */
  error?: string;
}

export interface ModelSummary {
  productId: string;
  provider: string;
  modelId: string;
  passed: number;
  failed: number;
  errored: number;
  passRate: number;
  modelCostUsd: number;
  graderCostUsd: number;
  totalCostUsd: number;
  avgLatencyMs: number;
}

export interface EvalReport {
  suiteId: string;
  promptId: string;
  startedAt: string;
  finishedAt: string;
  byModel: ModelSummary[];
  results: CaseResult[];
  totalCostUsd: number;
}

export interface EvalRunner {
  run(suite: EvalSuite): Promise<EvalReport>;
}

export interface GateModelDecision {
  productId: string;
  passRate: number;
  threshold: number;
  baseline?: number;
  pass: boolean;
  reason: string;
}

export interface GateDecision {
  pass: boolean;
  models: GateModelDecision[];
}
