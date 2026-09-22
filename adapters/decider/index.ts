import { DeciderError, type Decider } from './contract.ts';
import { OPENROUTER_ENDPOINT, typesafeDecider } from './typesafe.ts';

export type { Answer, Decider, Decision, Question, Usage } from './contract.ts';
export { confidenceOf, DeciderError, levelOf } from './contract.ts';

// The keys that turn the decision model on, in the order they are tried: TypeSafe's own early-access key, else the OpenRouter
// key that already runs open-weight models, which serves the same API. Either is read from the environment, where a key
// entered in the app is placed too, so saving one there is enough.
export const DECIDER_KEYS = ['TYPESAFE_API_KEY', 'OPENROUTER_API_KEY'] as const;

// The decider a set of variables names right now, or none.
export function deciderFor(env: NodeJS.ProcessEnv, request: typeof fetch): Decider | null {
  if (env.TYPESAFE_API_KEY) return typesafeDecider({ apiKey: env.TYPESAFE_API_KEY, fetch: request });
  if (env.OPENROUTER_API_KEY) return typesafeDecider({ apiKey: env.OPENROUTER_API_KEY, fetch: request, endpoint: OPENROUTER_ENDPOINT, name: 'typesafe-openrouter' });
  return null;
}

// A decider that looks the key up on every call, so one entered in the app after the coordinator started is used at once,
// and one removed stops being used. The key stays here: a coordinator hands it to no worker and no turn.
export function environmentDecider(env: NodeJS.ProcessEnv, request: typeof fetch): Decider {
  return {
    name: 'environment',
    ready: () => DECIDER_KEYS.some(name => Boolean(env[name])),
    async decide(state, questions) {
      const decider = deciderFor(env, request);
      if (!decider) throw new DeciderError(0, 'No key for the decision model is set');
      return decider.decide(state, questions);
    },
  };
}
