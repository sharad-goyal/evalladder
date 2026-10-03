# evalladder

Test any AI model the same way. Every model is a plug-in; every plug-in passes the same tests.

- **Plug-in per vendor.** Bedrock, OpenAI, Anthropic, Gemini, Ollama/local. Add your own in ~10 lines.
- **Models are config, not code.** A model is one `ModelProduct` object: provider, modelId, tier, price. Add a model = add a row.
- **Same suite, many models.** One prompt and one set of test cases run side by side across every target model.
- **Assertions are plain code by default.** `equals`, `contains`, `regex`, `is-json`, your own function. No model call, $0.
- **LLM judge is an opt-in plug-in.** `evalladder/judge` adds an `llm-rubric` assertion. Off unless you register it. It starts on the cheapest judge model and escalates only when needed.
- **Cost on every run.** Pass rate, model $, check $ and latency per model.
- **Release gate for CI.** Per model: pass rate must be at least the threshold and at least the last run. Non-zero exit fails the PR.
- Built on [promptfoo](https://www.promptfoo.dev) for vendor connections. MIT licensed.

## Install

```bash
npm i -D evalladder promptfoo
```

Node 22.22+. One package; each vendor plug-in is a subpath import (`evalladder/bedrock`, `evalladder/openai`, ...). promptfoo is an optional peer, needed only for the built-in vendor plug-ins.

## Quick start

`evalladder.config.mjs`:

```js
import { defineConfig } from 'evalladder';
import { bedrock } from 'evalladder/bedrock';

const novaLite = { id: 'nova-lite', provider: 'bedrock', modelId: 'us.amazon.nova-lite-v1:0', tier: 'cheap', priceInPer1M: 0.06, priceOutPer1M: 0.24 };
const haiku    = { id: 'haiku-4-5', provider: 'bedrock', modelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', tier: 'mid', priceInPer1M: 1, priceOutPer1M: 5 };

export default defineConfig({
  plugins: [bedrock()],
  suite: {
    suiteId: 'support-triage',
    prompt: { id: 'triage-v1', template: 'Classify as billing|bug|other. JSON only: {"category": "..."}\n\n{{text}}' },
    targets: [novaLite, haiku],
    cases: [
      { id: 'refund', vars: { text: 'I was charged twice' }, assertions: [{ type: 'is-json' }, { type: 'contains', value: 'billing' }] },
    ],
    passThreshold: 0.8,
  },
});
```

```bash
npx evalladder run --config evalladder.config.mjs --out report.json --baseline last-report.json
```

Prices are examples. Check current vendor pricing. A full example is in [examples/support-triage](examples/support-triage).

## One prompt, all models: `compare()`

Run one prompt on every model in parallel, check each answer, get a ranked table back.

```ts
import { compare, ProviderRegistry } from 'evalladder';
import { bedrock } from 'evalladder/bedrock';
import { judge } from 'evalladder/judge';

const report = await compare('Write a two-line apology for a late delivery.', [novaLite, haiku], {
  plugins: [bedrock()],
  judge: judge({ registry: new ProviderRegistry().use(bedrock()), ladder: [sonnet] }), // free-form answer: a judge scores it
  rubric: 'Polite, takes responsibility, no promised date.',
  // or code checks: assertions: [{ type: 'is-json' }, { type: 'contains', value: 'billing' }]
});
console.table(report.ranking); // rank, modelId, pass, score, costUsd, latencyMs, text, reason
```

`compare(prompt, models, opts): Promise<CompareReport>`. `CompareReport` is a normal `RunReport` plus `ranking: RankedOutput[]`, ordered by pass, then score, then lower cost, then lower latency; failed model calls go last. It rejects only `ConfigError` (empty prompt, no models, nothing to check).

```bash
npx evalladder compare --config evalladder.config.mjs --prompt "Write a two-line apology for a late delivery." --rubric "Polite, no promised date"
```

The CLI uses the config's `plugins`, its `models` (or `suite.targets`), and the judge if one is registered.

## How it works

Each step takes one DTO in and returns one `Promise<DTO>` out:

```
EvalSuite                    --EvalRunner.run-------->  Promise<RunReport>
  ModelInput                 --ModelProvider.complete->  Promise<ModelOutput>
  ModelOutput + Assertion    --check----------------->  Promise<AssertionResult>
  AssertionResult[]          --> CaseResult --> ModelSummary --> RunReport
RunReport                    --releaseGate----------->  GateDecision (sync)
```

Promise rules, the same for every method:

- **resolve** = the step ran. A failed check is a normal result (`pass: false`), not an error.
- **reject** = the step could not run, with a typed error:
  - `InfraError` (`retryable: boolean`): network, throttle, timeout, 5xx, auth. From `complete()` and `check()`. The runner retries retryable ones with backoff.
  - `ConfigError`: bad setup (unknown provider, unknown assertion type). From `run()` and `ProviderRegistry.resolve()`, before any model is called.
- `run()` uses `Promise.allSettled` over model x case, so one bad case or model never kills the run. Errors are counted per model.

Class diagram: [docs/uml.png](docs/uml.png). Method list: [docs/methods.png](docs/methods.png).

## Simulation tests

`test/simulation/` runs the whole flow against scripted models (good, sloppy, wrong, slow, flaky, down, no-auth, and two judges), with no network and no keys: `npm run test:sim`. It covers run() across all models, assertions, the opt-in judge, retries, typed errors, compare() ranking and the release gate. CI runs it on every push.

## Credentials

evalladder never takes raw keys in config. Each plug-in uses its vendor's normal credential chain:

| Plug-in | Import | promptfoo id | Credentials |
|---|---|---|---|
| `bedrock` | `evalladder/bedrock` | `bedrock:converse:<modelId>` | AWS SDK chain (GitHub OIDC role, SSO, instance role) |
| `openai` | `evalladder/openai` | `openai:chat:<modelId>` | `OPENAI_API_KEY`; `options.apiBaseUrl` for OpenAI-compatible servers (vLLM) |
| `anthropic` | `evalladder/anthropic` | `anthropic:messages:<modelId>` | `ANTHROPIC_API_KEY` |
| `gemini` | `evalladder/gemini` | `google:<modelId>` or `vertex:<modelId>` | `GOOGLE_API_KEY`, or Vertex ADC with `options.vertex: true` |
| `ollama` | `evalladder/ollama` | `ollama:chat:<modelId>` | none (local) |
| `promptfoo` | `evalladder/promptfoo` (`promptfooRaw()`) | `modelId` used as-is | any promptfoo provider, `file://`, `https://` |

## Assertions

Built in, no model call, $0: `equals`, `contains`, `not-contains`, `regex`, `is-json`, `custom` (your function `(output, testCase) => boolean | Promise<boolean>`).

Anything else is an `AssertionPlugin` you register:

```ts
interface AssertionPlugin {
  type: string;
  check(a: PluginAssertion, output: ModelOutput, tc: TestCase): Promise<AssertionResult>; // rejects InfraError only
}
```

Built-in checks run first. Plug-in checks run only if all built-in checks pass, so you don't pay for them on cases that already failed.

### Optional: LLM judge (`evalladder/judge`)

```js
import { ProviderRegistry } from 'evalladder';
import { judge } from 'evalladder/judge';

defineConfig({
  plugins: [bedrock()],
  assertionPlugins: [judge({ registry: new ProviderRegistry().use(bedrock()), ladder: [haiku, sonnet], threshold: 0.7 })],
  suite: { /* a case can now use */ cases: [{ id: 'tone', vars: { text: '...' }, assertions: [{ type: 'llm-rubric', rubric: 'Reply is calm and polite' }] }] },
});
```

The judge tries the first model in `ladder` and moves to the next (max `maxHops`, default 2) only when the judge errors, returns junk, or scores within `nearThresholdBand` of the threshold. A model never judges itself. If no case uses `llm-rubric`, don't register it.

## Write a provider plug-in

```ts
import { AbsModelProvider, type ModelProviderPlugin, type ModelInput, type RawCompletion } from 'evalladder';

class MyProvider extends AbsModelProvider {
  protected async doComplete(input: ModelInput): Promise<RawCompletion> {
    const r = await callMyModel(this.product.modelId, input.prompt);   // your SDK
    return { text: r.text, inputTokens: r.usage.in, outputTokens: r.usage.out };
  }
}
export const myVendor = (): ModelProviderPlugin => ({ key: 'myvendor', create: (p) => new MyProvider(p) });
```

`AbsModelProvider.complete()` adds timing, cost from the `ModelProduct` price, and wraps thrown errors as `InfraError`.
If promptfoo already supports your vendor, it's one line: `promptfooPlugin('myvendor', (p) => \`myvendor:${p.modelId}\`)`.

Then run the shared conformance suite, the same one every built-in plug-in passes:

```ts
import { runProviderConformance } from 'evalladder/testkit';
const checks = await runProviderConformance({ plugin: myVendor(), product: { id: 't', provider: 'myvendor', modelId: 'x', priceInPer1M: 1, priceOutPer1M: 2 } });
```

## Imports

| Import | What |
|---|---|
| `evalladder` (= `evalladder/core`) | Interfaces, DTOs, errors, runner, built-in assertions, ReleaseGate, CLI. No dependencies. |
| `evalladder/judge` | Optional LLM judge (`llm-rubric`). |
| `evalladder/testkit` | Mock provider + shared provider conformance suite. |
| `evalladder/promptfoo` | Base plug-in that calls any model through promptfoo. |
| `evalladder/bedrock`, `/openai`, `/anthropic`, `/gemini`, `/ollama` | One plug-in per vendor. |

Design decisions: [docs/SPEC.md](docs/SPEC.md).

## GitHub Actions

```yaml
- run: npx evalladder run --config evalladder.config.mjs --out report.json --baseline baseline/report.json
```

The markdown table is written to the job summary. Exit code 1 = gate failed.

## License

MIT
