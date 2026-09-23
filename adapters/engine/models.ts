import { isOpenWeight, modelFamily } from './providers.ts';

// What is known about a model beyond its name: how much context it holds, what a token costs in and out (US dollars), its family and
// whether its weights are published. Read from a public list that covers most hosted models, and nothing is guessed where it is silent.
export interface ModelFacts { contextTokens: number | null; inputUsd: number | null; outputUsd: number | null; family: string | null; openWeight: boolean }
interface Listed { id: string; contextTokens: number | null; inputUsd: number | null; outputUsd: number | null }
const perToken = (value: string | undefined) => (value !== undefined && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null);

export async function publishedModels(request: typeof fetch): Promise<Listed[]> {
  const response = await request('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`The model list answered ${response.status}`);
  const body = await response.json() as { data?: { id: string; context_length?: number; pricing?: { prompt?: string; completion?: string } }[] };
  return (body.data ?? []).map(model => ({ id: model.id, contextTokens: model.context_length ?? null, inputUsd: perToken(model.pricing?.prompt), outputUsd: perToken(model.pricing?.completion) }));
}

// A model is looked up by its name as a provider gives it: routed names carry a prefix ("openrouter/vendor/model", "anthropic/model"), and a
// bare name ("gpt-5.5") is matched on its last part.
export function factsOf(listed: readonly Listed[], model: string, providerKind: string | null = null): ModelFacts {
  const name = model.replace(/^openrouter\//, ''), last = name.split('/').at(-1)!.replace(/\[.*\]$/, '');
  const found = listed.find(item => item.id === name) ?? listed.find(item => item.id.split('/').at(-1) === last);
  return { contextTokens: found?.contextTokens ?? null, inputUsd: found?.inputUsd ?? null, outputUsd: found?.outputUsd ?? null, family: modelFamily(model), openWeight: isOpenWeight(model, providerKind) };
}
