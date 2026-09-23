// What a person sees when adding a model provider: one entry per way the engine adapters in this folder can really be run,
// in that product's own words and as few of them as possible. The platform renders these generically and never names a provider itself.
// Every entry is honest about the adapter behind it: an adapter that drops API keys from the environment is offered by sign-in only.
export type Billing = 'subscription' | 'metered' | 'local';
type Fetch = typeof fetch;
export interface ModelChoice { id: string; name: string; note?: string }
export interface ProviderEntry {
  kind: string; title: string; summary: string;
  billing: Billing;
  // Which adapter of this folder runs the turns, and the one command that installs its tool on a worker.
  engine: string; install: string;
  // A key typed into the app: kept sealed by the coordinator and handed to a worker only for a turn on this provider.
  // The same variable set on a worker by hand still counts, unless the adapter drops it from a worker's own environment (`inAppOnly`).
  // `optional`: a worker signed in by hand needs none; the key is how a machine nobody signs in on (one started for a job) runs it.
  key?: { variable: string; label: string; getAt: string; placeholder?: string; inAppOnly?: boolean; optional?: boolean; help?: string };
  // Or the tool's own sign-in, run once on the worker.
  signIn?: string;
  // Asked only when there can be several of the kind.
  named?: boolean;
  // No model names are written down here: they come from `listModels` or from the tool on the worker. The one exception is a
  // tool's own standing aliases (names it promises to keep pointing at its newest models), offered ticked. A name can always be typed.
  aliases?: string[];
  // Which of those aliases is the tool's quick, inexpensive middle model: what a seat that must answer fast starts on.
  responsive?: string;
  // The product's own list of models, when it publishes one. The key is passed when one is saved and the list needs it.
  listModels?(key: string | null, request: Fetch): Promise<ModelChoice[]>;
  // Whether a usage allowance over some hours makes sense here.
  window: boolean;
}

const OPENCODE = 'npm install -g opencode-ai', perMillion = (price: string | undefined) => (price && Number(price) > 0 ? `$${(Number(price) * 1_000_000).toFixed(2)}` : null);
const pick = (names: string[]): ModelChoice[] => names.map(id => ({ id, name: id }));

// Model families whose weights are published, by the names their vendors and routers use. A model run on this machine counts too.
const OPEN_WEIGHT = /(^|[/:_-])(llama|qwen|qwq|deepseek|mistral|mixtral|ministral|codestral|devstral|gemma|glm|kimi|minimax|gpt-oss|phi|olmo|nemotron|granite|command-r|yi|hermes|starcoder|falcon)/i;
// The family a model belongs to, as far as its name tells: models of one family tend to share blind spots, so two seats that
// check the same work should not both run on it. The vendor prefix of a routed name ("vendor/model") is dropped first.
export function modelFamily(model: string | null): string | null {
  if (!model) return null;
  const name = model.toLowerCase().split('/').at(-1)!;
  const family = /^(claude|gpt|o\d|gemini|llama|qwen|qwq|deepseek|mistral|mixtral|ministral|codestral|devstral|gemma|glm|kimi|minimax|phi|olmo|nemotron|granite|command|grok|yi|hermes)/.exec(name)?.[1];
  if (!family) return name.split(/[-:_.\d]/)[0] || null;
  if (/^o\d$/.test(family) || family === 'gpt') return 'gpt';
  if (['mistral', 'mixtral', 'ministral', 'codestral', 'devstral'].includes(family)) return 'mistral';
  if (family === 'qwq') return 'qwen';
  return family;
}
export const isOpenWeight = (model: string | null, providerKind: string | null): boolean => providerKind === 'local' || (model !== null && OPEN_WEIGHT.test(model));

export const PROVIDERS: ProviderEntry[] = [
  {
    kind: 'claude-subscription', title: 'Claude subscription', billing: 'subscription', engine: 'claude', install: 'npm install -g @anthropic-ai/claude-code',
    summary: 'Your Pro or Max plan, through Claude Code.', signIn: 'claude', responsive: 'sonnet', window: true,
    // The plan's own long-lived sign-in token, for machines started for a job, where nobody signs in by hand. It is still the plan, never metered use.
    key: { variable: 'CLAUDE_CODE_OAUTH_TOKEN', label: 'Sign-in token', getAt: 'https://docs.claude.com/en/docs/claude-code/setup', placeholder: 'sk-ant-oat01-…', inAppOnly: true, optional: true, help: 'Only for machines started for a job. Make one with “claude setup-token” on a computer where you are signed in.' },
  },
  {
    kind: 'anthropic-api', title: 'Anthropic API', billing: 'metered', engine: 'opencode', install: OPENCODE,
    summary: 'Claude models, billed per token to an API key.', window: true,
    key: { variable: 'ANTHROPIC_API_KEY', label: 'Anthropic API key', getAt: 'https://platform.claude.com/settings/keys', placeholder: 'sk-ant-…', inAppOnly: true },
    async listModels(key, request) {
      if (!key) return [];
      const response = await request('https://api.anthropic.com/v1/models?limit=100', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } });
      if (!response.ok) throw new Error(response.status === 401 ? 'That key was not accepted.' : `The model list answered ${response.status}.`);
      return ((await response.json()) as { data?: { id: string; display_name?: string }[] }).data?.map(model => ({ id: `anthropic/${model.id}`, name: model.display_name ?? model.id })) ?? [];
    },
  },
  {
    kind: 'openrouter', title: 'OpenRouter', billing: 'metered', engine: 'opencode', install: OPENCODE,
    summary: 'One key for models from many vendors, billed per token.', window: true,
    key: { variable: 'OPENROUTER_API_KEY', label: 'OpenRouter key', getAt: 'https://openrouter.ai/keys', placeholder: 'sk-or-…' },
    // The list is public; it needs no key.
    async listModels(_key, request) {
      const response = await request('https://openrouter.ai/api/v1/models');
      if (!response.ok) throw new Error(`The model list answered ${response.status}.`);
      const models = ((await response.json()) as { data?: { id: string; name?: string; context_length?: number; pricing?: { prompt?: string; completion?: string } }[] }).data ?? [];
      return models.map(model => {
        const price = [perMillion(model.pricing?.prompt), perMillion(model.pricing?.completion)];
        const note = [price[0] && price[1] ? `${price[0]} in · ${price[1]} out per million` : model.pricing ? 'free' : null, model.context_length ? `${model.context_length >= 1_000_000 ? `${Math.round(model.context_length / 100_000) / 10}M` : `${Math.round(model.context_length / 1000)}k`} context` : null].filter(Boolean).join(' · ');
        return { id: `openrouter/${model.id}`, name: model.name ?? model.id, ...(note ? { note } : {}) };
      });
    },
  },
  {
    kind: 'openai-compatible', title: 'Another gateway', billing: 'metered', engine: 'opencode', install: OPENCODE, named: true,
    summary: 'Any service that speaks the OpenAI API, set up in opencode on the worker.', signIn: 'opencode auth login', window: true,
  },
  {
    kind: 'ollama', title: 'Local models (Ollama)', billing: 'local', engine: 'opencode', install: OPENCODE,
    summary: 'Models on your own hardware. Nothing is billed.', window: false,
    // Reached only when Ollama runs next to the coordinator; anywhere else the names are typed.
    async listModels(_key, request) {
      const response = await request('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(1500) });
      return response.ok ? pick((((await response.json()) as { models?: { name: string }[] }).models ?? []).map(model => `ollama/${model.name}`)) : [];
    },
  },
  {
    kind: 'codex-subscription', title: 'Codex with a ChatGPT plan', billing: 'subscription', engine: 'codex', install: 'npm install -g @openai/codex',
    summary: 'Your ChatGPT plan, through the Codex tool.', signIn: 'codex login', window: true,
  },
  {
    kind: 'codex-api', title: 'Codex with an OpenAI key', billing: 'metered', engine: 'codex', install: 'npm install -g @openai/codex',
    summary: 'The Codex tool, billed per token to an OpenAI key.', signIn: 'codex login --with-api-key', window: true,
  },
  {
    kind: 'cursor', title: 'Cursor agent', billing: 'subscription', engine: 'cursor', install: 'curl https://cursor.com/install -fsS | bash',
    summary: 'Your Cursor plan, through its command-line agent.', signIn: 'agent login', aliases: ['auto'], window: false,
  },
];

export const providerEntry = (kind: string): ProviderEntry | null => PROVIDERS.find(entry => entry.kind === kind) ?? null;
// The variables a worker looks for so it can report which are present. Names only; a worker never reports a value.
export const PROVIDER_VARIABLES = [...new Set(PROVIDERS.flatMap(entry => (entry.key && !entry.key.inAppOnly ? [entry.key.variable] : [])))];
