// Engine adapter for the OpenCode CLI. The shared roles file is the OpenCode configuration format,
// so it is passed whole through OPENCODE_CONFIG_CONTENT with the worktree instruction paths added.
export const NAME = 'opencode';
export const BIN = 'opencode';
export const BILLING_MODES = ['provider'];
export const DEFAULT_BILLING = 'provider';
export const DEFAULT_MODEL = undefined;
export const NEEDS_SYSTEM_PROMPT_FILE = false;
export const BILLING_DESCRIPTIONS = { provider: 'whichever provider the CLI is logged in to' };
// No bounded question sessions: the resident PM and owner chat need another engine.
export const SUPPORTS_ASK = false;

export function rateLimitPolicy() { return 'job'; }

// Denied shell prefixes from the SCM adapter and the tracker's MCP server are folded into the
// roles configuration OpenCode reads; the roles file itself names no provider.
export function environment(env, { roles, denied = [], mcp = {}, access = {} } = {}) {
  if (Object.hasOwn(env, 'OPENCODE_CONFIG_CONTENT')) throw new Error('Preexisting OPENCODE_CONFIG_CONTENT is not allowed; unset it explicitly');
  const filtered = { ...env };
  if (roles) {
    const config = structuredClone(roles);
    for (const key of ['team', 'roster', 'blueprint']) delete config[key];
    const coordinator = config.agent?.['team-coordinator'];
    if (coordinator?.permission?.bash && typeof coordinator.permission.bash === 'object') for (const rule of denied) coordinator.permission.bash[`*${rule}*`] = 'deny';
    if (Object.keys(mcp).length) config.mcp = Object.fromEntries(Object.entries(mcp).map(([name, server]) => [name, server.type === 'stdio'
      ? { type: 'local', command: [server.command, ...(server.args ?? [])], enabled: true }
      : { type: 'remote', url: server.url, enabled: true, ...(server.headers ? { headers: server.headers } : {}) }]));
    // A server granted to named roles only is denied to every other agent as a tool pattern.
    for (const [server, allowed] of Object.entries(access)) {
      if (!Array.isArray(allowed)) continue;
      for (const [name, agent] of Object.entries(config.agent ?? {})) if (!allowed.includes(name)) { agent.permission ??= {}; agent.permission[`${server}_*`] = 'deny'; }
    }
    filtered.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
  }
  return filtered;
}

export function preflight({ command, cwd, env }) {
  return { opencode: command(BIN, ['--version'], cwd, env) };
}

// OpenCode reads roles from its configuration; the system prompt is not a separate file.
export function systemPrompt() { return ''; }

export function invocation({ role, prompt, model, worktree }) {
  const args = ['run', '--agent', role, '--format', 'json', '--auto', '--dir', worktree];
  if (model) args.push('--model', model);
  args.push(prompt);
  return { bin: BIN, args };
}

export function stopReason() { return null; }

// JSON parts: text, tool_use (task parts name the subagent) and step_finish token counts.
export function parseEvent(event, context) {
  const { push } = context;
  if (event.type === 'text' && event.part?.text?.trim()) { push('coordinator', 'text', event.part.text); return true; }
  if (event.type === 'tool_use' && event.part) {
    const input = event.part.state?.input ?? {};
    const detail = input.description ?? input.command ?? input.filePath ?? input.pattern ?? input.prompt ?? '';
    const task = event.part.tool === 'task';
    push(task ? 'subagent' : 'coordinator', 'tool', `${event.part.tool}${input.subagent_type ? ` → ${input.subagent_type}` : ''}${detail ? `: ${detail}` : ''}`, task ? input.subagent_type ?? 'subagent' : null);
    return true;
  }
  if (event.type === 'step_finish') {
    if (Number.isFinite(event.part?.tokens?.total)) context.tokens += event.part.tokens.total;
    return true;
  }
  return false;
}

export function ask() {
  return Promise.reject(new Error('The opencode engine does not support bounded question sessions; use another engine for the PM'));
}
