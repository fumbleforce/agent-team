import { DeciderError, type Answer, type Decider, type Question } from './contract.ts';

// Jev, by TypeSafe AI: a model that returns typed, calibrated decisions instead of text. One HTTP call carries the state and
// every question about it; the answers come back together. Reached with the platform's own fetch, so no package is added.
// The same System One API is served by TypeSafe itself and by OpenRouter, which needs no early-access key.
export const TYPESAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/systemone';
const MODEL = 'jev-latest';
// The list price in September 2026: $0.042 per million input tokens, output free. Millionths of a dollar per token.
const USD_MICRO_PER_INPUT_TOKEN = 0.042;
// Waits before the second and third try, on a rate limit or an overloaded service only.
const BACKOFF_MS = [500, 1500];

// OpenRouter also says what the call cost, in dollars; TypeSafe does not, so the list price stands in.
interface Response { model?: string; answers?: Record<string, Answer>; usage?: { input_tokens?: number; output_tokens?: number; cost?: number } }

export function typesafeDecider(options: { apiKey: string; fetch: typeof fetch; endpoint?: string; name?: string; timeoutMs?: number; backoffMs?: number[] }): Decider {
  const { apiKey, endpoint = TYPESAFE_ENDPOINT, timeoutMs = 5000, backoffMs = BACKOFF_MS } = options, request = options.fetch;
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  async function once(body: string) {
    const response = await request(endpoint, { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(timeoutMs) });
    if (response.status === 429 || response.status === 529) throw new DeciderError(response.status, response.status === 429 ? 'The decision model is rate-limited' : 'The decision model is overloaded', true);
    if (response.status === 401) throw new DeciderError(401, 'The decision model did not accept the key');
    if (!response.ok) throw new DeciderError(response.status, `The decision model answered ${response.status}${response.status === 422 ? ': the questions were not accepted' : ''}`);
    return (await response.json()) as Response;
  }

  return {
    name: options.name ?? 'typesafe',
    async decide(state, questions: Record<string, Question>) {
      const body = JSON.stringify({ model: MODEL, state, questions });
      let answer: Response | null = null;
      for (let attempt = 0; answer === null; attempt++) {
        try { answer = await once(body); } catch (error) {
          const retryable = error instanceof DeciderError ? error.retryable : false;
          if (!retryable || attempt >= backoffMs.length) throw error instanceof DeciderError ? error : new DeciderError(0, `The decision model could not be reached: ${(error as Error).message}`, true);
          await sleep(backoffMs[attempt]!);
        }
      }
      const inputTokens = answer.usage?.input_tokens ?? 0, cost = answer.usage?.cost;
      return { model: answer.model ?? MODEL, answers: answer.answers ?? {}, usage: { inputTokens, outputTokens: answer.usage?.output_tokens ?? 0, usdMicro: Math.round(typeof cost === 'number' ? cost * 1_000_000 : inputTokens * USD_MICRO_PER_INPUT_TOKEN) } };
    },
  };
}
