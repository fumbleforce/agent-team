// What a person sees when adding a model provider: one entry per way the engine adapters in this folder can really be run,
// in that product's own words. The platform renders these generically and never names a provider itself.
// Every entry is honest about the adapter behind it: an adapter that drops API keys from the environment is offered by login only.
export type Billing = 'subscription' | 'metered' | 'local';
export interface ProviderField { key: 'name' | 'models' | 'concurrency' | 'windowTokens' | 'windowHours'; label: string; help?: string; placeholder?: string; input: 'text' | 'lines' | 'number'; suggested?: string; required?: boolean }
export interface ProviderEntry {
  kind: string; title: string; summary: string;
  billing: Billing;
  // Which adapter of this folder runs the turns.
  engine: string;
  // What choosing it means for the team and the bill, in sentences a non-developer understands.
  does: string[];
  // What to do on each worker machine, in order. Shown as a numbered list.
  steps: string[];
  fields: ProviderField[];
  // The secret never enters the app. `variable` is set on the workers, which report only whether it is there;
  // `login` means the engine's own sign-in on the worker holds it and nothing is set at all.
  credential: { label: string; runsOn: 'workers'; variable?: string; login?: string } | null;
}

const models = (suggested: string[], help: string): ProviderField => ({ key: 'models', label: 'Models the team may use', input: 'lines', suggested: suggested.join('\n'), required: true, placeholder: 'one model per line', help: `One per line, exactly as the command-line tool names them. ${help}` });
const CONCURRENCY: ProviderField = { key: 'concurrency', label: 'Agents working at the same time', input: 'number', placeholder: '2', help: 'How many turns may run on this provider at once. Leave empty for 2.' };
const WINDOW: ProviderField[] = [
  { key: 'windowTokens', label: 'Usage allowance, in tokens', input: 'number', placeholder: '2000000', help: 'Optional. The team stops starting new turns on this provider once this many tokens were used within the hours below.' },
  { key: 'windowHours', label: 'Counted over how many hours', input: 'number', placeholder: '5', help: 'Optional. Leave empty for 5 hours.' },
];
const RESTART = 'Restart the worker. It reports what it found, and this page shows it as ready.';

export const PROVIDERS: ProviderEntry[] = [
  {
    kind: 'claude-subscription', title: 'Claude subscription (Pro or Max)', billing: 'subscription', engine: 'claude',
    summary: 'Run agents on your Claude plan through Claude Code, signed in on the worker. Nothing is billed per use.',
    does: ['Agents work within your plan\'s usage limits; when a limit is reached they wait until it resets', 'API keys are never handed to it, so it cannot quietly turn into pay-per-use billing'],
    steps: ['On each worker machine install Claude Code as code.claude.com/docs describes (the native installer is recommended), or with npm: npm install -g @anthropic-ai/claude-code', 'Run "claude" there once and follow the browser prompts to sign in with the account that holds the subscription. If it is already signed in to another account, type /login to switch.', RESTART],
    fields: [models(['sonnet', 'opus', 'haiku'], 'The short names always point at the newest model of that family; a full model name works too.'), CONCURRENCY, ...WINDOW],
    credential: { label: 'Claude sign-in', runsOn: 'workers', login: 'claude, then /login' },
  },
  {
    kind: 'anthropic-api', title: 'Anthropic API (pay per use)', billing: 'metered', engine: 'opencode',
    summary: 'Run agents on Claude models billed per token to an Anthropic API key, through the opencode command-line tool.',
    does: ['Every turn is billed to the API key\'s account; the Costs page shows what was used', 'Kept apart from a Claude subscription on purpose: the two never share a sign-in'],
    steps: ['On each worker machine install opencode: npm install -g opencode-ai', 'Create an API key in the Claude Console at platform.claude.com/settings/keys.', 'On the worker run "opencode auth login", choose Anthropic, choose to enter an API key manually and paste the key. It is stored by opencode on that machine only.', 'Run "opencode models" to see the exact model names you may list below.', RESTART],
    fields: [models(['anthropic/claude-sonnet-4-5', 'anthropic/claude-haiku-4-5'], 'These are suggestions; "opencode models" on a worker prints the names your key can use.'), CONCURRENCY, ...WINDOW],
    credential: { label: 'Anthropic API key', runsOn: 'workers', login: 'opencode auth login' },
  },
  {
    kind: 'openrouter', title: 'OpenRouter', billing: 'metered', engine: 'opencode',
    summary: 'One key for models from many vendors, billed per token by OpenRouter, through the opencode command-line tool.',
    does: ['Any agent can be given any model OpenRouter offers', 'Every turn is billed to your OpenRouter credit; the Costs page shows what was used'],
    steps: ['On each worker machine install opencode: npm install -g opencode-ai', 'Create a key at openrouter.ai/keys.', 'On every worker machine set OPENROUTER_API_KEY to that key.', RESTART],
    fields: [models(['openrouter/anthropic/claude-sonnet-4.5', 'openrouter/openai/gpt-5', 'openrouter/google/gemini-2.5-pro'], 'These are suggestions: write "openrouter/" followed by the model\'s name as openrouter.ai/models shows it.'), CONCURRENCY, ...WINDOW],
    credential: { label: 'OpenRouter key', runsOn: 'workers', variable: 'OPENROUTER_API_KEY' },
  },
  {
    kind: 'openai-compatible', title: 'Another OpenAI-compatible gateway', billing: 'metered', engine: 'opencode',
    summary: 'A company gateway or any other service that speaks the OpenAI API, through the opencode command-line tool.',
    does: ['Agents use the models your gateway serves', 'Billing is whatever the gateway charges; token use still shows on the Costs page'],
    steps: ['On each worker machine install opencode: npm install -g opencode-ai', 'In the worker\'s opencode settings file (~/.config/opencode/opencode.json) add the gateway as a custom provider, as opencode.ai/docs/providers describes: a short id such as "gateway", the package "@ai-sdk/openai-compatible", the gateway\'s address as "baseURL" and the models it serves.', 'Run "opencode auth login", choose Other, enter the same id and paste the gateway\'s key.', RESTART],
    fields: [
      { key: 'name', label: 'What to call it', input: 'text', placeholder: 'Company gateway', help: 'Shown on agent cards and in cost reports.', required: true },
      { ...models([], 'Write the id you chose, a slash, then the model\'s name at the gateway.'), placeholder: 'gateway/model-name' }, CONCURRENCY, ...WINDOW,
    ],
    credential: { label: 'Gateway key', runsOn: 'workers', login: 'opencode auth login' },
  },
  {
    kind: 'ollama', title: 'Local models (Ollama)', billing: 'local', engine: 'opencode',
    summary: 'Run agents on models served by Ollama on your own hardware, through the opencode command-line tool. Nothing is billed.',
    does: ['Nothing leaves your network and nothing is billed', 'Speed and quality depend on the machine and the model; small models struggle with long coding tasks'],
    steps: ['Install Ollama (ollama.com) where the models should run and pull a model, for example: ollama pull qwen2.5-coder', 'On each worker machine install opencode: npm install -g opencode-ai', 'In the worker\'s opencode settings file (~/.config/opencode/opencode.json) add Ollama as a provider with the id "ollama", as opencode.ai/docs/providers describes: the package "@ai-sdk/openai-compatible", the "baseURL" http://localhost:11434/v1 and each model you pulled listed under "models".', 'If Ollama runs on another machine, put that machine\'s address in "baseURL" instead of localhost, and on the Ollama machine set OLLAMA_HOST (for example to 0.0.0.0:11434) so it listens beyond localhost.', 'Ollama\'s own guide says opencode needs a context length of 64k or more; raise the model\'s context length in Ollama if turns stop early.', RESTART],
    fields: [models(['ollama/qwen2.5-coder'], 'Write "ollama/" followed by the name "ollama list" shows.'), { ...CONCURRENCY, placeholder: '1', help: 'How many turns may run at once. One is kind to a single graphics card; leave empty for 2.' }],
    credential: null,
  },
  {
    kind: 'codex-subscription', title: 'Codex with a ChatGPT plan', billing: 'subscription', engine: 'codex',
    summary: 'Run agents on your ChatGPT plan through the Codex command-line tool, signed in on the worker.',
    does: ['Agents work within your plan\'s usage limits; when a limit is reached they wait', 'Restrictions are Codex\'s own sandbox: read-only turns cannot write files'],
    steps: ['On each worker machine install Codex: npm install -g @openai/codex', 'Run "codex login" there and complete the ChatGPT sign-in in the browser. On a machine without a browser, "codex login --device-auth" gives a code to enter elsewhere.', RESTART],
    fields: [models(['gpt-5.5', 'gpt-5.4'], 'These are suggestions and change often; use the names Codex shows under /model.'), CONCURRENCY, ...WINDOW],
    credential: { label: 'ChatGPT sign-in', runsOn: 'workers', login: 'codex login' },
  },
  {
    kind: 'codex-api', title: 'Codex with an OpenAI API key (pay per use)', billing: 'metered', engine: 'codex',
    summary: 'Run agents through the Codex command-line tool, billed per token to an OpenAI API key.',
    does: ['Every turn is billed to the API key\'s account', 'Use a separate worker from one signed in with a ChatGPT plan: Codex holds one sign-in per machine account'],
    steps: ['On each worker machine install Codex: npm install -g @openai/codex', 'Create a key at platform.openai.com/api-keys.', 'On the worker put the key in OPENAI_API_KEY for that one command and run: printenv OPENAI_API_KEY | codex login --with-api-key. Codex stores it on that machine only.', RESTART],
    fields: [models(['gpt-5.5', 'gpt-5.4'], 'These are suggestions and change often; use the names your key has access to.'), CONCURRENCY, ...WINDOW],
    credential: { label: 'OpenAI API key', runsOn: 'workers', login: 'codex login --with-api-key' },
  },
  {
    kind: 'cursor', title: 'Cursor agent', billing: 'subscription', engine: 'cursor',
    summary: 'Run agents on your Cursor plan through Cursor\'s command-line agent, signed in on the worker.',
    does: ['Agents work within your Cursor plan', 'Cursor cannot hold a turn to read-only by itself, so a worker set to strict isolation refuses reviews and planning on it; use it for agents that write code'],
    steps: ['On each worker machine install the Cursor command-line agent as cursor.com/docs/cli/installation describes; "agent --version" confirms it.', 'Run "agent login" there and sign in through the browser; "agent status" shows whether it worked.', RESTART],
    fields: [models(['auto'], '"auto" lets Cursor choose; "agent models" on the worker lists other names.'), CONCURRENCY],
    credential: { label: 'Cursor sign-in', runsOn: 'workers', login: 'agent login' },
  },
];

export const providerEntry = (kind: string): ProviderEntry | null => PROVIDERS.find(entry => entry.kind === kind) ?? null;
// The variables a worker looks for so it can report which are present. Names only; a value never leaves the worker.
export const PROVIDER_VARIABLES = [...new Set(PROVIDERS.flatMap(entry => (entry.credential?.variable ? [entry.credential.variable] : [])))];
