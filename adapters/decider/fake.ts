import type { Answer, Decider, Question } from './contract.ts';

export type Script = Record<string, Answer> | ((state: string | object, questions: Record<string, Question>) => Record<string, Answer>);

// A scripted decider for tests: no model, no network. It answers from the script and remembers what it was asked. Usage is
// made up but not zero (one token per four characters of state, a millionth of a dollar each), so costs can be seen recorded.
export function fakeDecider(script: Script): Decider & { calls: { state: string | object; questions: Record<string, Question> }[] } {
  const calls: { state: string | object; questions: Record<string, Question> }[] = [];
  return {
    name: 'fake',
    calls,
    async decide(state, questions) {
      calls.push({ state, questions });
      const scripted = typeof script === 'function' ? script(state, questions) : script;
      const answers = Object.fromEntries(Object.keys(questions).flatMap(key => (scripted[key] ? [[key, scripted[key]]] : [])));
      const inputTokens = Math.ceil((typeof state === 'string' ? state : JSON.stringify(state)).length / 4);
      return { model: 'fake', answers, usage: { inputTokens, outputTokens: 0, usdMicro: inputTokens } };
    },
  };
}
