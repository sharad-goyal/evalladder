// Example: one prompt, two cheap Bedrock models (one AWS role, no API keys), judged by a cheap-first judge ladder.
// Prices are list prices as of Oct 2026 (USD per 1M tokens). Check current pricing before relying on cost numbers.
import { defineConfig } from 'evalladder/core';
import { bedrock } from 'evalladder/bedrock';

const models = {
  novaLite:  { id: 'bedrock-nova-lite', provider: 'bedrock', modelId: 'us.amazon.nova-lite-v1:0', tier: 'cheap', priceInPer1M: 0.06, priceOutPer1M: 0.24, options: { region: 'us-east-1' } },
  haiku45:   { id: 'bedrock-haiku-4-5', provider: 'bedrock', modelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', tier: 'mid', priceInPer1M: 1, priceOutPer1M: 5, options: { region: 'us-east-1' } },
  sonnet45:  { id: 'judge-sonnet-4-5', provider: 'bedrock', modelId: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', tier: 'reasoning', priceInPer1M: 3, priceOutPer1M: 15, options: { region: 'us-east-1' } },
};

const label = (id, text, expected) => ({
  id,
  vars: { text },
  assertions: [{ type: 'is-json' }, { type: 'regex', value: `"category"\\s*:\\s*"${expected}"` }],
});

export default defineConfig({
  plugins: [bedrock()],
  suite: {
    suiteId: 'support-triage',
    prompt: {
      id: 'triage-v1',
      system: 'You route customer support messages.',
      template:
        'Classify the message into one category: billing, bug, account, feature_request, other.\n' +
        'Reply with JSON only: {"category": "...", "reply": "one short polite sentence to the customer"}.\n\nMessage: {{text}}',
    },
    targets: [models.novaLite, models.haiku45],
    cases: [
      label('refund', 'I was charged twice this month, please refund one payment.', 'billing'),
      label('crash', 'The app closes every time I open the settings page.', 'bug'),
      label('password', "I can't log in, the reset email never arrives.", 'account'),
      label('dark-mode', 'Would love a dark mode option.', 'feature_request'),
      label('invoice', 'Where can I download last year\'s invoices?', 'billing'),
      {
        id: 'angry-polite-reply',
        vars: { text: 'This is the third time your update broke my exports. Fix it.' },
        assertions: [
          { type: 'is-json' },
          { type: 'llm-rubric', rubric: 'The "reply" field is calm, polite, takes responsibility, and does not promise a specific date.' },
        ],
      },
    ],
    graderPolicy: { tiers: [models.haiku45, models.sonnet45], threshold: 0.7, nearThresholdBand: 0.1, maxHops: 2 },
    passThreshold: 0.8,
    concurrency: 4,
    retries: 2,
    request: { temperature: 0, maxTokens: 200 },
  },
});
