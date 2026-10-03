// Simulated models for the simulation suite. No network, no keys.
// Each one has a fixed personality so results are predictable.
import { InfraError, type ModelProduct } from '../../src/core/index.js';
import { mockPlugin, type MockReply } from '../../src/testkit/index.js';

const m = (id: string, tier: ModelProduct['tier'], inP: number, outP: number): ModelProduct => ({
  id, provider: 'sim', modelId: `sim-${id}`, tier, priceInPer1M: inP, priceOutPer1M: outP,
});

export const good = m('good', 'mid', 1, 5); //       always right, valid JSON
export const sloppy = m('sloppy', 'cheap', 0.1, 0.4); // right category, wrapped in prose (not JSON)
export const wrong = m('wrong', 'cheap', 0.05, 0.2); //  valid JSON, wrong category
export const slow = m('slow', 'cheap', 0.06, 0.24); //   right, but takes 150 ms
export const flaky = m('flaky', 'cheap', 0.06, 0.24); // throttled twice, then right
export const down = m('down', 'cheap', 0.06, 0.24); //   always 503
export const noAuth = m('no-auth', 'cheap', 0.06, 0.24); // 401, not retryable
export const judgeCheap = m('judge-cheap', 'cheap', 1, 5);
export const judgeTop = m('judge-top', 'reasoning', 3, 15);

export const category = (prompt: string) =>
  /charged|refund|invoice/i.test(prompt) ? 'billing' : /crash|closes|broke/i.test(prompt) ? 'bug' : 'other';
const json = (p: string) => JSON.stringify({ category: category(p), reply: 'Sorry about that, we are on it.' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Judge: 0.9 for a JSON answer with a polite reply, 0.2 otherwise. */
const verdict: MockReply = (i) => {
  const out = i.prompt.split('OUTPUT:\n')[1] ?? '';
  return out.trim().startsWith('{') ? '{"score": 0.9, "reason": "clear and polite"}' : '{"score": 0.2, "reason": "not in the asked format"}';
};

/** A fresh plugin per test, so call counts start at 0. */
export function simPlugin(extra: Record<string, MockReply[]> = {}) {
  return mockPlugin('sim', {
    good: [(i) => json(i.prompt)],
    sloppy: [(i) => `Sure! The category is ${category(i.prompt)}.`],
    wrong: [() => JSON.stringify({ category: 'other', reply: 'ok' })],
    slow: [async (i) => (await sleep(150), json(i.prompt))],
    flaky: [new InfraError('ThrottlingException: rate exceeded'), new InfraError('ThrottlingException: rate exceeded'), (i) => json(i.prompt)],
    down: [new InfraError('503 Service Unavailable')],
    'no-auth': [new InfraError('401 Unauthorized: invalid api key', { retryable: false })],
    'judge-cheap': [verdict],
    'judge-top': [verdict],
    ...extra,
  });
}
