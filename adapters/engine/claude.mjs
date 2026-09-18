import * as fs from 'node:fs';
import { spawnCommand } from '../../core/platform.mjs';

// Engine adapter for the official Claude Code CLI. Three billing modes:
//   subscription: the worker's logged-in claude.ai account; API variables are stripped so the run
//                 cannot silently switch to metered billing, and a usage limit quarantines the project.
//   api:          ANTHROPIC_API_KEY billing; a 429 blocks only this job.
//   bedrock:      Amazon Bedrock through the instance's AWS credentials; same policy as api.
export const NAME = 'claude';
export const BIN = 'claude';
export const BILLING_MODES = ['subscription', 'api', 'bedrock'];
export const DEFAULT_BILLING = 'subscription';
export const DEFAULT_MODEL = undefined;
export const NEEDS_SYSTEM_PROMPT_FILE = true;
export const API_KEY_VARIABLE = 'ANTHROPIC_API_KEY';
export const KEYED_BILLING = ['api'];
export const BILLING_DESCRIPTIONS = { subscription: 'the claude.ai account logged in on the worker', api: 'an Anthropic API key, metered', bedrock: 'Amazon Bedrock through AWS credentials' };

const ROLE_WRITERS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
// Prefix rules approximating the shared bash deny globs; deterministic delivery owns merges.
// The SCM adapter contributes its own merge-command denials at invocation time.
const DENIED = ['Bash(git push --force:*)', 'Bash(git push --force)', 'Bash(git push --force-with-lease:*)',
  'Bash(git push -f:*)', 'Bash(git push -f)', 'Bash(git reset --hard:*)',
  'Bash(npm run deploy:*)', 'Bash(npm run test:live:*)', 'Bash(npm run db:reset:*)'];

export function rateLimitPolicy(billing = DEFAULT_BILLING) {
  return billing === 'subscription' ? 'quarantine' : 'job';
}

// Subscription workers must never inherit API-key, third-party provider, proxy or
// nested-session variables: any of them can silently switch Claude Code away from
// the logged-in claude.ai account. Metered modes keep the variable that selects them.
export function claudeEnvironment(env, billing = DEFAULT_BILLING) {
  const filtered = { ...env };
  for (const key of Object.keys(filtered)) {
    const providerKey = /^ANTHROPIC_/.test(key) || /^CLAUDE_CODE_/.test(key);
    const nested = ['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT'].includes(key);
    if (nested) delete filtered[key];
    else if (providerKey && billing === 'subscription') delete filtered[key];
    else if (providerKey && billing === 'api' && !['ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL'].includes(key)) delete filtered[key];
    else if (providerKey && billing === 'bedrock' && !/^(?:CLAUDE_CODE_USE_BEDROCK|ANTHROPIC_MODEL|ANTHROPIC_SMALL_FAST_MODEL|CLAUDE_CODE_SKIP_BEDROCK_AUTH|CLAUDE_CODE_MAX_OUTPUT_TOKENS)$/.test(key)) delete filtered[key];
  }
  if (billing === 'bedrock') filtered.CLAUDE_CODE_USE_BEDROCK = '1';
  // Print mode otherwise abandons a cycle after 600 s of background subagent work; the runner's
  // own timeout is the only deadline.
  filtered.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS = '0';
  return filtered;
}

export function environment(env, { billing = DEFAULT_BILLING } = {}) {
  return claudeEnvironment(env, billing);
}

export function claudeAuth(statusOutput) {
  let status;
  try { status = JSON.parse(statusOutput); } catch { throw new Error('Unreadable claude auth status'); }
  if (status?.loggedIn !== true || status.authMethod !== 'claude.ai' || status.apiProvider !== 'firstParty') {
    throw new Error('Claude engine requires a logged-in claude.ai subscription; API keys and third-party providers are not permitted');
  }
  // Only non-identifying facts reach journals.
  return { authMethod: status.authMethod, subscriptionType: typeof status.subscriptionType === 'string' ? status.subscriptionType : 'unknown' };
}

// Versions and credentials are checked before any model call. `command` runs a binary and
// returns trimmed stdout, throwing on failure.
export function preflight({ command, cwd, env, billing = DEFAULT_BILLING }) {
  const versions = { claude: command(BIN, ['--version'], cwd, env) };
  if (billing === 'subscription') versions.claudeAuth = claudeAuth(command(BIN, ['auth', 'status'], cwd, env));
  else if (billing === 'api' && !env.ANTHROPIC_API_KEY) throw new Error('Claude api billing requires ANTHROPIC_API_KEY in the worker environment');
  else if (billing === 'bedrock' && !(env.AWS_REGION || env.AWS_DEFAULT_REGION)) throw new Error('Claude bedrock billing requires AWS_REGION in the worker environment');
  versions.billing = billing;
  return versions;
}

// Shared subagent permissions translate to Claude tool restrictions.
// `access` maps an MCP server name to the roles allowed to use it (null: any role).
export function claudeAgents(shared, mcpNames = ['tracker'], access = {}) {
  const agents = {};
  for (const [name, agent] of Object.entries(shared.agent)) {
    if (agent.mode !== 'subagent') continue;
    const permission = agent.permission ?? {};
    const disallowedTools = [];
    if (permission.edit === 'deny') disallowedTools.push(...ROLE_WRITERS);
    if (permission.bash === 'deny') disallowedTools.push('Bash');
    if (permission.task === 'deny') disallowedTools.push('Agent');
    if (permission['tracker_*'] === 'deny') disallowedTools.push(...mcpNames.map(name => `mcp__${name}`));
    else for (const server of mcpNames) if (Array.isArray(access[server]) && !access[server].includes(name)) disallowedTools.push(`mcp__${server}`);
    agents[name] = { description: agent.description ?? name, prompt: agent.prompt, ...(disallowedTools.length ? { disallowedTools } : {}) };
  }
  return agents;
}

export function claudeSystemPrompt({ shared, role, instructions, memory = '' }) {
  const parts = shared.instructions.map(file => fs.readFileSync(file, 'utf8'));
  parts.push(shared.agent[role].prompt);
  if (role === 'team-coordinator' && Object.values(shared.agent).some(agent => agent.mode === 'subagent')) {
    parts.push(`Engine notes: delegate each role session with the Agent tool using only the subagent names ${Object.keys(claudeAgents(shared)).join(', ')}; never use built-in or other agent types for role work or approvals, and never run them in the background: wait for each role to return before continuing. Treat "Task tool" in role instructions as the Agent tool. Use each returned agent identifier as that role's sessionId. The issue tracker is available through the tracker MCP tools.`);
  }
  if (instructions.length) {
    parts.push('# Project instructions\n\nThe following files from the assigned worktree are binding project instructions.');
    for (const { file, content } of instructions) parts.push(`## ${file}\n\n${content}`);
  }
  if (memory) parts.push(memory);
  return parts.join('\n\n');
}

export const systemPrompt = claudeSystemPrompt;

// `mcp` is the tracker MCP server map supplied by the tracker adapter (empty for read-only runs);
// `denied` are extra Bash prefix rules, typically the SCM adapter's merge command.
export function claudeInvocation({ ideate, prompt, model, systemPromptFile, shared, mcp = {}, denied = [], access = {} }) {
  const args = [prompt, '--print', '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
    '--setting-sources', 'user', '--strict-mcp-config', '--mcp-config', JSON.stringify(ideate ? { mcpServers: {} } : { mcpServers: mcp }),
    '--permission-mode', 'acceptEdits', '--permission-prompts', 'none',
    '--append-system-prompt-file', systemPromptFile];
  const mcpNames = Object.keys(mcp);
  // The coordinator itself keeps a server only when access is open or names it.
  const coordinatorServers = mcpNames.filter(name => !Array.isArray(access[name]) || access[name].includes('team-coordinator'));
  if (ideate) args.push('--restricted', '--tools', 'Read,Grep,Glob,Write');
  else args.push('--allowedTools', 'Bash', ...coordinatorServers.map(name => `mcp__${name}`), '--disallowedTools', ...DENIED, ...denied.map(rule => `Bash(${rule}:*)`), ...mcpNames.filter(name => !coordinatorServers.includes(name)).map(name => `mcp__${name}`), '--agents', JSON.stringify(claudeAgents(shared, mcpNames, access)));
  if (model) args.push('--model', model);
  return { bin: BIN, args };
}

export function invocation({ ideate, prompt, model, systemPromptFile, shared, mcp, denied, access }) {
  return claudeInvocation({ ideate, prompt, model, systemPromptFile, shared, mcp, denied, access });
}

const LIMIT = /rate.?limit|usage limit|limit reached|hit your limit|out of (?:extra )?usage|too many requests|\b429\b/i;

// Usage limits end the cycle; whether that quarantines the project is the billing mode's policy.
export function claudeStopReason({ eventsFile, stderrFile }) {
  const tail = file => {
    try {
      const size = fs.statSync(file).size;
      const fd = fs.openSync(file, 'r');
      try {
        const length = Math.min(size, 65536);
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, size - length);
        return buffer.toString('utf8');
      } finally { fs.closeSync(fd); }
    } catch { return ''; }
  };
  for (const line of tail(eventsFile).split('\n')) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type === 'rate_limit_event' && event.rate_limit_info?.status === 'rejected') return 'rate-limited';
    if (event?.type === 'result' && event.is_error === true && LIMIT.test(String(event.result ?? ''))) return 'rate-limited';
  }
  return LIMIT.test(tail(stderrFile)) ? 'rate-limited' : null;
}

export const stopReason = claudeStopReason;

// Stream-json events: assistant text and tool calls, tool results, rate-limit windows and the
// final result. Subagent events carry the Agent call id that named the role.
export function parseEvent(event, context) {
  const { push, handoffs, results } = context;
  const scope = event.parent_tool_use_id ? 'subagent' : 'coordinator';
  const member = event.parent_tool_use_id ? handoffs[event.parent_tool_use_id] ?? 'subagent' : null;
  if (event.type === 'assistant') {
    for (const block of event.message?.content ?? []) {
      if (block.type === 'text' && block.text?.trim()) push(scope, 'text', block.text, member);
      else if (block.type === 'tool_use') {
        const input = block.input ?? {};
        if (block.name === 'Agent' && typeof input.subagent_type === 'string' && block.id) handoffs[block.id] = input.subagent_type;
        const detail = input.description ?? input.command ?? input.file_path ?? input.pattern ?? input.prompt ?? input.query ?? '';
        push(scope, 'tool', `${block.name}${input.subagent_type ? ` → ${input.subagent_type}` : ''}${detail ? `: ${detail}` : ''}`, member);
      }
    }
    return true;
  }
  if (event.type === 'user' && Array.isArray(event.message?.content)) {
    if (results) for (const block of event.message.content) {
      if (block.type !== 'tool_result') continue;
      const content = typeof block.content === 'string' ? block.content : Array.isArray(block.content) ? block.content.map(part => part.text ?? '').join(' ') : '';
      if (content.trim()) push(scope, 'result', content, member);
    }
    return true;
  }
  if (event.type === 'rate_limit_event' && event.rate_limit_info) {
    const windows = event.rate_limit_info.unifiedWindows ?? {};
    context.usage = { status: event.rate_limit_info.status, fiveHour: windows.five_hour ?? null, sevenDay: windows.seven_day ?? null };
    return true;
  }
  if (event.type === 'result' && !Object.hasOwn(event, 'item')) {
    context.engineResult = { subtype: event.subtype, isError: event.is_error === true, durationMs: event.duration_ms, turns: event.num_turns };
    if (Number.isFinite(event.total_cost_usd)) context.costUsd = (context.costUsd ?? 0) + event.total_cost_usd;
    return true;
  }
  return false;
}

// A bounded read-only session that answers a prompt and streams assistant text as deltas.
// Used by the resident PM and owner chat; no tools beyond reading the working directory,
// except the MCP servers the caller passes (the tracker, the memory service).
export function ask({ systemPromptFile, prompt, cwd, timeoutMs = 240_000, env = process.env, signal, onDelta = () => {}, onUsage = () => {}, billing = DEFAULT_BILLING, tools = ['Read', 'Grep', 'Glob'], mcp = {}, model, maxChars = 4000 }) {
  return new Promise((resolve, reject) => {
    const filtered = claudeEnvironment(env, billing);
    for (const key of Object.keys(filtered)) if (key.startsWith('AGENT_TEAM_') || /_API_KEY$/.test(key) && key !== 'ANTHROPIC_API_KEY') delete filtered[key];
    const mcpNames = Object.keys(mcp).map(name => `mcp__${name}`);
    const args = [prompt, '--print', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--no-session-persistence', '--setting-sources', 'user', '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: mcp }),
      ...(mcpNames.length ? ['--allowedTools', ...mcpNames] : ['--restricted']), '--tools', [...tools, ...mcpNames].join(','), '--permission-mode', 'default', '--permission-prompts', 'none', '--append-system-prompt-file', systemPromptFile];
    if (model) args.push('--model', model);
    const child = spawnCommand(BIN, args, { cwd, env: filtered, stdio: ['ignore', 'pipe', 'pipe'] });
    let buffer = ''; let stderr = ''; let reply = ''; let streamed = '';
    const kill = () => child.kill('SIGKILL');
    const timer = setTimeout(kill, timeoutMs);
    signal?.addEventListener('abort', kill, { once: true });
    const handle = line => {
      let event; try { event = JSON.parse(line); } catch { return; }
      if (event.type === 'stream_event' && event.event?.type === 'content_block_delta' && event.event.delta?.type === 'text_delta' && !event.parent_tool_use_id) { streamed += event.event.delta.text; onDelta(event.event.delta.text); }
      else if (event.type === 'assistant' && !event.parent_tool_use_id) for (const block of event.message?.content ?? []) if (block.type === 'text' && block.text) reply += (reply ? '\n\n' : '') + block.text;
      else if (event.type === 'result') {
        if (event.is_error && /limit/i.test(String(event.result ?? ''))) stderr += ' usage limit';
        if (Number.isFinite(event.total_cost_usd)) onUsage({ costUsd: event.total_cost_usd, turns: event.num_turns ?? null, durationMs: event.duration_ms ?? null });
      }
    };
    child.stdout.on('data', chunk => { buffer += chunk; const lines = buffer.split('\n'); buffer = lines.pop(); lines.forEach(handle); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', kill);
      if (buffer) handle(buffer);
      if (signal?.aborted) return reject(new Error('Reply interrupted'));
      if (code !== 0) return reject(new Error(/limit/i.test(stderr) ? 'Engine usage limit reached' : `Engine exited with ${code}`));
      const text = (reply || streamed).trim();
      if (!text) return reject(new Error('Engine returned no usable reply'));
      resolve(text.slice(0, maxChars));
    });
  });
}
