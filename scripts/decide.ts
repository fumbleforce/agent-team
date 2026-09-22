// One real read on the decision model, to see that the key, the endpoint and the answers work: the three kinds of question
// about one small piece of state, printed with what the call cost. Needs TYPESAFE_API_KEY or OPENROUTER_API_KEY in the
// environment; it spends a fraction of a cent. Usage: node scripts/decide.ts ["some state to read"]
import { deciderFor } from '../adapters/decider/index.ts';

const decider = deciderFor(process.env, fetch);
if (!decider) { console.error('Set TYPESAFE_API_KEY or OPENROUTER_API_KEY first.'); process.exit(1); }
const state = process.argv[2] ?? 'Pressing Pay on Safari 18 shows a spinner forever. Chrome works. Three customers wrote in today.';
const started = Date.now();
const decision = await decider.decide(state, {
  kind: { type: 'choice', instructions: 'What is this?', criteria: { defect: 'Something that exists does not work', request: 'Something new is wanted', question: 'A question, not work' } },
  severity: { type: 'score', instructions: 'If something is broken, how badly?', criteria: ['Cosmetic', 'Degraded, a workaround exists', 'Blocking, no workaround'] },
  urgent: { type: 'noul', instructions: 'Does this need attention today?' },
});
console.log(`${decider.name} answered as ${decision.model} in ${Date.now() - started} ms`);
for (const [key, answer] of Object.entries(decision.answers)) console.log(`  ${key}: ${JSON.stringify(answer)}`);
console.log(`  usage: ${decision.usage.inputTokens} tokens in, ${decision.usage.outputTokens} out, $${(decision.usage.usdMicro / 1_000_000).toFixed(6)}`);
