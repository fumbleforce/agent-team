import test from 'node:test';
import assert from 'node:assert/strict';
import { confidenceOf, DeciderError, levelOf, type Answer, type Decider, type Question } from './contract.ts';
import { fakeDecider } from './fake.ts';
import { deciderFor, environmentDecider } from './index.ts';
import { OPENROUTER_ENDPOINT, typesafeDecider } from './typesafe.ts';

const KEY = 'ts-secret-key-value';
const QUESTIONS: Record<string, Question> = {
  kind: { type: 'choice', instructions: 'What is this?', criteria: { defect: 'Something is broken', request: 'Someone wants something new' } },
  severity: { type: 'score', instructions: 'How bad?', criteria: ['Cosmetic', 'Degraded', 'Blocking'] },
  urgent: { type: 'noul', instructions: 'Does it need attention today?' },
};
// A recorded answer, in the shape the service documents.
const RECORDED = { model: 'jev-1.13.0', answers: {
  kind: { type: 'choice', choice: 'defect', confidence: 0.9, probabilities: { defect: 0.95, request: 0.05 } },
  severity: { type: 'score', score: 1.43, confidence: 0.35, legend: { 0: 'Cosmetic', 1: 'Degraded', 2: 'Blocking' }, probabilities: { 0: 0, 1: 0.57, 2: 0.43 } },
  urgent: { type: 'noul', noul: 0.8 },
}, usage: { input_tokens: 1000, output_tokens: 34 } };
const ANSWERS = RECORDED.answers as Record<string, Answer>;

// Every fetch the service would see, and a scripted reply per call: a status with a JSON body, or an error to throw.
function fakeFetch(replies: ({ status: number; body?: unknown } | Error)[]) {
  const seen: { url: string; init: RequestInit }[] = [];
  const request = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    const reply = replies.shift() ?? { status: 200, body: RECORDED };
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { request, seen };
}

// Both adapters answer the same contract: typed answers with probabilities, and a usage that is never negative.
const adapters: [string, () => Decider][] = [
  ['typesafe', () => typesafeDecider({ apiKey: KEY, fetch: fakeFetch([]).request, backoffMs: [0, 0] })],
  ['fake', () => fakeDecider(ANSWERS)],
];
for (const [name, make] of adapters) {
  test(`${name}: answers are typed, probabilities add up, confidence is between 0 and 1`, async () => {
    const decision = await make().decide('The export button crashes the settings page.', QUESTIONS);
    const kind = decision.answers.kind!, severity = decision.answers.severity!, urgent = decision.answers.urgent!;
    assert.equal(kind.type, 'choice');
    assert.equal(severity.type, 'score');
    assert.equal(urgent.type, 'noul');
    if (kind.type !== 'choice' || severity.type !== 'score' || urgent.type !== 'noul') return;
    assert.equal(kind.choice, 'defect');
    assert.ok(Math.abs(Object.values(kind.probabilities).reduce((sum, p) => sum + p, 0) - 1) < 0.01);
    assert.equal(levelOf(severity), 'Degraded');
    for (const answer of Object.values(decision.answers)) { const confidence = confidenceOf(answer); assert.ok(confidence >= 0 && confidence <= 1); }
    assert.ok(decision.usage.inputTokens >= 0 && decision.usage.usdMicro >= 0);
  });
}

test('typesafe: the key travels in the header only, the state and questions in the body, and the price is per input token', async () => {
  const { request, seen } = fakeFetch([]);
  const decision = await typesafeDecider({ apiKey: KEY, fetch: request }).decide({ report: 'Nothing loads' }, QUESTIONS);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal((seen[0]!.init.headers as Record<string, string>).authorization, `Bearer ${KEY}`);
  const body = JSON.parse(seen[0]!.init.body as string);
  assert.deepEqual([body.model, body.state, Object.keys(body.questions)], ['jev-latest', { report: 'Nothing loads' }, ['kind', 'severity', 'urgent']]);
  assert.ok(!(seen[0]!.init.body as string).includes(KEY));
  assert.deepEqual(decision.usage, { inputTokens: 1000, outputTokens: 34, usdMicro: 42 });
  assert.equal(decision.model, 'jev-1.13.0');
});

test('typesafe: a rate limit is tried again, a bad key is not, and a service that never answers is an error, not a hang', async () => {
  const limited = fakeFetch([{ status: 429 }, { status: 200, body: RECORDED }]);
  const decision = await typesafeDecider({ apiKey: KEY, fetch: limited.request, backoffMs: [0] }).decide('x', QUESTIONS);
  assert.equal(limited.seen.length, 2);
  assert.equal(decision.answers.kind?.type, 'choice');

  const unauthorized = fakeFetch([{ status: 401 }]);
  await assert.rejects(typesafeDecider({ apiKey: KEY, fetch: unauthorized.request, backoffMs: [0] }).decide('x', QUESTIONS), (error: DeciderError) => error instanceof DeciderError && error.status === 401 && !error.retryable);
  assert.equal(unauthorized.seen.length, 1);

  const overloaded = fakeFetch([{ status: 529 }, { status: 529 }, { status: 529 }]);
  await assert.rejects(typesafeDecider({ apiKey: KEY, fetch: overloaded.request, backoffMs: [0, 0] }).decide('x', QUESTIONS), (error: DeciderError) => error.status === 529 && error.retryable);
  assert.equal(overloaded.seen.length, 3);

  const rejected = fakeFetch([{ status: 422 }]);
  await assert.rejects(typesafeDecider({ apiKey: KEY, fetch: rejected.request }).decide('x', QUESTIONS), (error: DeciderError) => error.status === 422 && !error.retryable);

  const gone = fakeFetch([new Error('fetch failed')]);
  await assert.rejects(typesafeDecider({ apiKey: KEY, fetch: gone.request, backoffMs: [] }).decide('x', QUESTIONS), (error: DeciderError) => error instanceof DeciderError && error.status === 0);
});

test('through OpenRouter the same call goes to its endpoint and the cost it reports is kept, to the millionth of a dollar', async () => {
  const { request, seen } = fakeFetch([{ status: 200, body: { ...RECORDED, id: 'gen-dec-1', provider: 'TypeSafe', usage: { input_tokens: 275, output_tokens: 20, cost: 0.00003 } } }]);
  const decision = await deciderFor({ OPENROUTER_API_KEY: KEY }, request)!.decide('x', QUESTIONS);
  assert.equal(seen[0]!.url, OPENROUTER_ENDPOINT);
  assert.equal((seen[0]!.init.headers as Record<string, string>).authorization, `Bearer ${KEY}`);
  assert.deepEqual(decision.usage, { inputTokens: 275, outputTokens: 20, usdMicro: 30 });
});

test('the environment names the decider, TypeSafe’s own key first; a key entered later is used on the next call, and none means not ready', async () => {
  const { request, seen } = fakeFetch([]);
  assert.equal(deciderFor({}, request), null);
  assert.equal(deciderFor({ TYPESAFE_API_KEY: KEY, OPENROUTER_API_KEY: 'or' }, request)?.name, 'typesafe');
  assert.equal(deciderFor({ OPENROUTER_API_KEY: 'or' }, request)?.name, 'typesafe-openrouter');
  const env: NodeJS.ProcessEnv = {};
  const decider = environmentDecider(env, request);
  assert.equal(decider.ready!(), false);
  await assert.rejects(decider.decide('x', QUESTIONS), (error: DeciderError) => error instanceof DeciderError && error.status === 0);
  env.OPENROUTER_API_KEY = 'or';
  assert.equal(decider.ready!(), true);
  await decider.decide('x', QUESTIONS);
  assert.equal(seen[0]!.url, OPENROUTER_ENDPOINT);
  delete env.OPENROUTER_API_KEY;
  assert.equal(decider.ready!(), false);
});

test('fake: answers only what the script has, and remembers what it was asked', async () => {
  const decider = fakeDecider({ kind: ANSWERS.kind! });
  const decision = await decider.decide('state', QUESTIONS);
  assert.deepEqual(Object.keys(decision.answers), ['kind']);
  assert.equal(decider.calls.length, 1);
  assert.deepEqual(Object.keys(decider.calls[0]!.questions), ['kind', 'severity', 'urgent']);
});
