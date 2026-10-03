# evalladder spec (v0.1.1)

Goal: test any AI model the same way, the way UI plug-ins are tested: one shared contract, one plug-in per vendor, every plug-in passes the same suite.

## Decisions

| # | Decision | Why |
|---|---|---|
| D1 | One npm package `evalladder` with subpath layers: `core` (contract + DTOs), `testkit` (shared tests), `promptfoo` (base plug-in), one subpath per vendor. | Same layering as a core-models / base-plugin / per-feature-plugin setup, without needing an npm org. Vendor code loads only when imported. |
| D2 | Every vendor is a `ModelProviderPlugin` (`key` + `create(product)`). Plug-ins extend `AbsModelProvider` and implement only `doComplete()`. | Interface -> abstract base -> implementation. Timing, cost and the error rule live in one place. |
| D3 | A model is a `ModelProduct` config object (provider, modelId, tier, price, options). No raw secrets in it. | Add a model = add a row. Credentials stay in each vendor's normal chain (env, AWS OIDC). |
| D4 | Built-in vendor plug-ins call promptfoo's `loadApiProvider()`. promptfoo is a peer dependency, not bundled. | promptfoo already handles 60+ vendors; we add what it lacks. |
| D5 | Our own runner instead of `promptfoo.evaluate()`. | Needed for per-model cost, the release gate and opt-in assertion plug-ins. Vendor calls still go through promptfoo. |
| D6 | Promise rule: resolve = the step ran (a failed check is `pass:false`); reject = the step could not run, typed: `InfraError` from `complete()`/`check()`, `ConfigError` from `run()`/`resolve()`. Retryable infra errors retry with backoff (default 2). | Failing checks are results, not crashes; callers can tell bad setup from outages. |
| D7 | `Promise.allSettled` over target x case, bounded concurrency (default 4). | One bad case or model never kills the run. |
| D8 | An `Assertion` is a deterministic check by default (built-in, $0). Other types come from an `AssertionPlugin` registered on the runner; plug-in checks run only if built-ins pass. | No model call unless you opt in. |
| D9 | The LLM judge is an optional plug-in (`evalladder/judge`, type `llm-rubric`). Its JudgeRouter: judges listed cheapest first; escalate on infra error, unparseable JSON, or score within `nearThresholdBand` of `threshold`; `maxHops` default 2; skip any judge equal to the model under test. If every judge fails, the case resolves `pass:false` "ungraded"; if no judge is reachable it rejects `InfraError`. | Cheap by default, accurate when it matters, no self-grading. |
| D10 | ReleaseGate per model: `passRate >= threshold` and `>= baseline - tolerance`. Errored cases count as not passed. | A model can't regress silently; infra outages fail loud. |
| D11 | Shared conformance suite (`runProviderConformance`) runs offline against a fake transport for every plug-in, plus an optional live call when `EVALLADDER_LIVE_<VENDOR>_MODEL` is set. | Same tests for every model; CI needs no keys. |
| D12 | MIT. Node >= 22.22 (promptfoo's floor). ESM only. | |
| D13 | `compare(prompt, models, opts): Promise<CompareReport>` is a shortcut over `run()`: one case, all models in parallel, checks = given assertions and/or the judge with a rubric. Returns the RunReport plus a ranking (pass, score, cost, latency). | "Run a prompt on all models, check the answers, come back with the result" in one call. |
| D14 | `test/simulation/` uses scripted models with fixed personalities (good, sloppy, wrong, slow, flaky, down, no-auth) to test the whole flow offline. | Every behavior is checked in CI with no keys. |

## Flow

Class diagram: [uml.png](uml.png). Method list with counts: [methods.png](methods.png).

```
EvalSuite                    --EvalRunner.run-------->  Promise<RunReport>          rejects ConfigError
  ModelProduct               --ProviderRegistry.resolve->  ModelProvider (sync)     throws ConfigError
  TestCase + PromptTemplate  --render---------------->  ModelInput
  ModelInput                 --ModelProvider.complete->  Promise<ModelOutput>       rejects InfraError
  ModelOutput + Assertion    --checkBuiltin / AssertionPlugin.check->  Promise<AssertionResult>  rejects InfraError (plug-ins only)
  AssertionResult[]          --> CaseResult --> ModelSummary --> RunReport
RunReport                    --releaseGate----------->  GateDecision (sync)
```

## Contract (src/core/types.ts)

```ts
// interfaces
interface ModelProviderPlugin { key: string; create(p: ModelProduct): ModelProvider }
interface ModelProvider   { product: ModelProduct; complete(input: ModelInput): Promise<ModelOutput> }            // rejects InfraError
abstract class AbsModelProvider implements ModelProvider { protected doComplete(input: ModelInput): Promise<RawCompletion> }
interface AssertionPlugin { type: string; check(a: PluginAssertion, output: ModelOutput, tc: TestCase): Promise<AssertionResult> } // rejects InfraError
interface EvalRunner      { run(suite: EvalSuite): Promise<RunReport> }                                           // rejects ConfigError
function compare(prompt: string, models: ModelProduct[], opts: CompareOptions): Promise<CompareReport>             // rejects ConfigError
function releaseGate(report: RunReport, opts: GateOptions): GateDecision

// input DTOs
type ModelProduct   = { id; provider; modelId; tier?: 'cheap'|'mid'|'reasoning'; priceInPer1M?; priceOutPer1M?; options? }
type PromptTemplate = { id; template; system? }
type Assertion      = BuiltinAssertion (equals | contains | not-contains | regex | is-json | custom(fn)) | PluginAssertion { type; ... }
type TestCase       = { id; vars: Record<string,string>; assertions: Assertion[] }
type EvalSuite      = { suiteId; prompt: PromptTemplate; targets: ModelProduct[]; cases: TestCase[]; passThreshold; concurrency?=4; retries?=2; settings?: ModelSettings }
type ModelInput     = { prompt; system?; maxTokens?; temperature? }

// output DTOs
type RawCompletion   = { text; inputTokens?; outputTokens? }
type ModelOutput     = { productId; modelId; text; inputTokens; outputTokens; costUsd; latencyMs }
type AssertionResult = { type; pass; score 0..1; reason; costUsd; checkedBy? }
type CaseResult      = { caseId; productId; pass; output?: ModelOutput; assertions: AssertionResult[]; error? }
type ModelSummary    = { productId; provider; modelId; cases; passed; failed; errored; passRate; modelCostUsd; assertionCostUsd; totalCostUsd; avgLatencyMs }
type RunReport       = { suiteId; promptId; startedAt; finishedAt; models: ModelSummary[]; cases: CaseResult[]; totalCostUsd }
type CompareOptions  = { plugins; assertions?; judge?: AssertionPlugin; rubric?; system?; settings?; retries?; concurrency?; backoffMs? }
type RankedOutput    = { rank; productId; modelId; pass; score; costUsd; latencyMs; text; reason; error? }
type CompareReport   = RunReport & { ranking: RankedOutput[] }
type GateDecision    = { pass; models: { productId; passRate; threshold; baseline?; pass; reason }[] }

// errors (the only rejects)
class InfraError extends Error { retryable: boolean }
class ConfigError extends Error {}
```

## Out of scope for v0.1

Streaming, tool-call assertions, multi-turn conversations, dataset files (CSV/YAML), HTML viewer (use promptfoo's), caching of model responses.
