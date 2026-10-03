// Same suite, no API keys: scripted mock models. Used by CI to smoke-test the CLI.
import { makeConfig } from './evalladder.config.mjs';
import { mockPlugin } from 'evalladder/testkit';

const answer = (input) => {
  const m = input.prompt.toLowerCase();
  const category = /charged|refund|invoice/.test(m) ? 'billing' : /closes|broke|crash/.test(m) ? 'bug' : /log in|reset/.test(m) ? 'account' : /dark mode/.test(m) ? 'feature_request' : 'other';
  return JSON.stringify({ category, reply: 'Sorry about that, we are looking into it now.' });
};
const verdict = () => '{"score": 0.9, "reason": "calm and polite"}';

export default makeConfig([
  mockPlugin('bedrock', { 'bedrock-nova-lite': [answer], 'bedrock-haiku-4-5': [(i) => (i.system?.includes('strict evaluator') ? verdict() : answer(i))], 'judge-sonnet-4-5': [verdict] }),
]);
