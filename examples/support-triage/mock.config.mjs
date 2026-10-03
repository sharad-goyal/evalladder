// Same suite, no API keys: swaps both vendors for scripted mock plugins. Used by CI to smoke-test the CLI.
import base from './evalladder.config.mjs';
import { mockPlugin } from 'evalladder/testkit';

const answer = (req) => {
  const m = req.prompt.toLowerCase();
  const category = /charged|refund|invoice/.test(m) ? 'billing' : /closes|broke|crash/.test(m) ? 'bug' : /log in|reset/.test(m) ? 'account' : /dark mode/.test(m) ? 'feature_request' : 'other';
  return JSON.stringify({ category, reply: 'Sorry about that, we are looking into it now.' });
};
const judge = () => '{"score": 0.9, "reason": "calm and polite"}';

export default {
  ...base,
  plugins: [
    mockPlugin('bedrock', { 'bedrock-nova-lite': [answer], 'bedrock-haiku-4-5': [answer], 'judge-sonnet-4-5': [judge] }),
  ],
};
