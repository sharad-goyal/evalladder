# evalladder

Test any AI model the same way. Every model is a plug-in; every plug-in passes the same tests.

- **Plug-in per vendor.** Bedrock, OpenAI, Anthropic, Gemini, Ollama/local. Add your own in ~10 lines.
- **Models are config, not code.** A model is one `ModelProduct` object: provider, modelId, tier, price. Add a model = add a row.
- **Same suite, many models.** One prompt and one set of test cases run side by side across every target model.
- **Cheap judge first.** `llm-rubric` checks start on the cheapest judge and escalate only when the judge errors, returns junk, or scores near the threshold (max 2 hops). A model never judges itself.
- **Cost on every run.** Pass rate, model $, judge $ and latency per model.
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
import { openai } from 'evalladder/openai';
import { bedrock } from 'evalladder/bedrock';

const novaLite = { id: 'nova-lite', provider: 'bedrock', modelId: 'us.amazon.nova-lite-v1:0', tier: 'cheap', priceInPer1M: 0.06, priceOutPer1M: 0.24 };
const nano     = { id: 'gpt-5-nano', provider: 'openai', modelId: 'gpt-5-nano', tier: 'cheap', priceInPer1M: 0.05, priceOutPer1M: 0.4 };
const judge    = { id: 'judge-mini', provider: 'openai', modelId: 'gpt-5-mini', tier: 'cheap', priceInPer1M: 0.25, priceOutPer1M: 2 };

export default defineConfig({
  plugins: [openai(), bedrock()],
  suite: {
    suiteId: 'support-triage',
    prompt: { id: 'triage-v1', template: 'Classify as billing|bug|other. JSON only: {"category": "..."}\n\n{{text}}' },
    targets: [novaLite, nano],
    cases: [
      { id: 'refund', vars: { text: 'I was charged twice' }, assertions: [{ type: 'is-json' }, { type: 'contains', value: 'billing' }] },
      { id: 'tone', vars: { text: 'Your update broke my exports' }, assertions: [{ type: 'llm-rubric', rubric: 'Reply is calm and polite' }] },
    ],
    graderPolicy: { tiers: [judge /*, mid, reasoning */], threshold: 0.7 },
    passThreshold: 0.8,
  },
});
```

```bash
npx evalladder run --config evalladder.config.mjs --out report.json --baseline last-report.json
```

Prices are examples. Check current vendor pricing.

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

`equals`, `contains`, `not-contains`, `regex`, `is-json`, `javascript` (your function), `llm-rubric` (judge).
Code checks run first and cost $0. If one fails, the judge is skipped.

## Rules the framework enforces

- A failing test case **resolves** with `pass: false`. It never rejects.
- Providers **reject only on infra errors** (`InfraError`: throttle, timeout, 5xx, auth, config). Retryable ones are retried with backoff; auth/config errors are not.
- The runner uses `Promise.allSettled`, so one bad case or model never kills the suite. Errors are counted per model.

## Write a provider plug-in

```ts
import { AbsModelProvider, type ModelProviderPlugin, type PromptRequest } from 'evalladder';

class MyProvider extends AbsModelProvider {
  protected async doComplete(req: PromptRequest) {
    const r = await callMyModel(this.product.modelId, req.prompt);   // your SDK
    return { text: r.text, inputTokens: r.usage.in, outputTokens: r.usage.out };
  }
}
export const myVendor = (): ModelProviderPlugin => ({ key: 'myvendor', create: (p) => new MyProvider(p) });
```

`AbsModelProvider` adds timing, cost from the `ModelProduct` price, and wraps thrown errors as `InfraError`.
If promptfoo already supports your vendor, it's one line: `promptfooPlugin('myvendor', (p) => \`myvendor:${p.modelId}\`)`.

Then run the shared conformance suite, the same one every built-in plug-in passes:

```ts
import { runProviderConformance, fakePromptfooLoader } from 'evalladder/testkit';
const checks = await runProviderConformance({ plugin: myVendor(), product: { id: 't', provider: 'myvendor', modelId: 'x', priceInPer1M: 1, priceOutPer1M: 2 } });
```

## Imports

| Import | What |
|---|---|
| `evalladder` (= `evalladder/core`) | Interfaces, DTOs, runner, graders, JudgeRouter, ReleaseGate, CLI. No dependencies. |
| `evalladder/testkit` | Mock provider + shared provider conformance suite. |
| `evalladder/promptfoo` | Base plug-in that calls any model through promptfoo. |
| `evalladder/bedrock`, `/openai`, `/anthropic`, `/gemini`, `/ollama` | One plug-in per vendor. |

Design and DTOs: [docs/SPEC.md](docs/SPEC.md).

## GitHub Actions

```yaml
- run: npx evalladder run --config evalladder.config.mjs --out report.json --baseline baseline/report.json
```

The markdown table is written to the job summary. Exit code 1 = gate failed.

## License

MIT
