import * as fs from 'node:fs';

export const ENGINES = ['opencode', 'claude'];
const LINEAR_MCP = { mcpServers: { linear: { type: 'http', url: 'https://mcp.linear.app/mcp' } } };
const ROLE_WRITERS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
// Prefix rules approximating the shared OpenCode bash deny globs; deterministic delivery owns merges.
const CLAUDE_DENIED = ['Bash(git push --force:*)', 'Bash(git push --force)', 'Bash(git push --force-with-lease:*)',
  'Bash(git push -f:*)', 'Bash(git push -f)', 'Bash(git reset --hard:*)', 'Bash(gh pr merge:*)',
  'Bash(npm run deploy:*)', 'Bash(npm run test:live:*)', 'Bash(npm run db:reset:*)'];

export function validateEngine(engine = 'opencode') {
  if (!ENGINES.includes(engine)) throw new Error(`Unknown engine: ${engine}. Use ${ENGINES.join(' or ')}`);
  return engine;
}

// Subscription workers must never inherit API-key, third-party provider, proxy or
// nested-session variables: any of them can silently switch Claude Code away from
// the logged-in claude.ai account.
export function claudeEnvironment(env) {
  const filtered = { ...env };
  for (const key of Object.keys(filtered)) {
    if (/^ANTHROPIC_/.test(key) || /^CLAUDE_CODE_/.test(key) || ['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT'].includes(key)) delete filtered[key];
  }
  return filtered;
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

// Shared OpenCode subagent permissions translate to Claude tool restrictions.
export function claudeAgents(shared) {
  const agents = {};
  for (const [name, agent] of Object.entries(shared.agent)) {
    if (agent.mode !== 'subagent') continue;
    const permission = agent.permission ?? {};
    const disallowedTools = [];
    if (permission.edit === 'deny') disallowedTools.push(...ROLE_WRITERS);
    if (permission.bash === 'deny') disallowedTools.push('Bash');
    if (permission.task === 'deny') disallowedTools.push('Agent');
    if (permission['linear_*'] === 'deny') disallowedTools.push('mcp__linear');
    agents[name] = { description: agent.description ?? name, prompt: agent.prompt, ...(disallowedTools.length ? { disallowedTools } : {}) };
  }
  return agents;
}

export function claudeSystemPrompt({ shared, role, instructions }) {
  const parts = shared.instructions.map(file => fs.readFileSync(file, 'utf8'));
  parts.push(shared.agent[role].prompt);
  if (role === 'team-coordinator') {
    parts.push(`Engine notes: delegate each role session with the Agent tool using only the subagent names ${Object.keys(claudeAgents(shared)).join(', ')}; never use built-in or other agent types for role work or approvals. Treat "Task tool" in role instructions as the Agent tool. Use each returned agent identifier as that role's sessionId. Linear is available through the linear MCP tools.`);
  }
  if (instructions.length) {
    parts.push('# Project instructions\n\nThe following files from the assigned worktree are binding project instructions.');
    for (const { file, content } of instructions) parts.push(`## ${file}\n\n${content}`);
  }
  return parts.join('\n\n');
}

export function claudeInvocation({ ideate, prompt, model, systemPromptFile, shared }) {
  const args = [prompt, '--print', '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
    '--setting-sources', 'user', '--strict-mcp-config', '--mcp-config', JSON.stringify(ideate ? { mcpServers: {} } : LINEAR_MCP),
    '--permission-mode', 'acceptEdits', '--permission-prompts', 'none',
    '--append-system-prompt-file', systemPromptFile];
  if (ideate) args.push('--restricted', '--tools', 'Read,Grep,Glob,Write');
  else args.push('--allowedTools', 'Bash', 'mcp__linear', '--disallowedTools', ...CLAUDE_DENIED, '--agents', JSON.stringify(claudeAgents(shared)));
  if (model) args.push('--model', model);
  return { bin: 'claude', args };
}

const LIMIT = /rate.?limit|usage limit|limit reached|hit your limit|out of (?:extra )?usage|too many requests|\b429\b/i;

// Subscription limits stop the cycle; the runner never retries or falls back to API billing.
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
