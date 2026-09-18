import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeAgents, claudeAuth, claudeEnvironment, claudeInvocation, claudeStopReason, claudeSystemPrompt } from './claude.mjs';
import { validateEngine } from './index.mjs';

const shared = { instructions: [], agent: {
  'team-coordinator': { mode: 'primary', prompt: 'Coordinate' },
  'team-pm': { mode: 'subagent', description: 'PM', prompt: 'Plan', permission: { edit: 'deny', bash: 'deny', task: 'deny' } },
  'team-dev': { mode: 'subagent', description: 'Dev', prompt: 'Build', permission: { task: 'deny', 'tracker_*': 'deny' } },
  'team-tester': { mode: 'subagent', description: 'Test', prompt: 'Verify' },
} };

test('engine names are validated', () => {
  assert.equal(validateEngine(), 'opencode');
  assert.equal(validateEngine('claude'), 'claude');
  assert.throws(() => validateEngine('unknown-engine'), /Unknown engine/);
});

test('subscription environment drops API-key, provider and nested-session variables only', () => {
  const env = claudeEnvironment({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_BASE_URL: 'u', CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's', CLAUDE_PID: '1', CLAUDE_EFFORT: 'high', HOME: '/h', PATH: '/bin', OPENAI_API_KEY: 'keep' });
  assert.deepEqual(env, { HOME: '/h', PATH: '/bin', OPENAI_API_KEY: 'keep', CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0' });
});

test('auth status must be a first-party claude.ai login and yields no identifying data', () => {
  const status = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max', email: 'private@example.invalid', orgId: 'org' };
  assert.deepEqual(claudeAuth(JSON.stringify(status)), { authMethod: 'claude.ai', subscriptionType: 'max' });
  for (const change of [{ loggedIn: false }, { authMethod: 'console' }, { apiProvider: 'bedrock' }]) assert.throws(() => claudeAuth(JSON.stringify({ ...status, ...change })), /claude\.ai subscription/);
  assert.throws(() => claudeAuth('not json'), /Unreadable/);
});

test('shared subagent permissions map to Claude tool restrictions', () => {
  const agents = claudeAgents(shared);
  assert.deepEqual(Object.keys(agents), ['team-pm', 'team-dev', 'team-tester']);
  assert.deepEqual(agents['team-pm'], { description: 'PM', prompt: 'Plan', disallowedTools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'Agent'] });
  assert.deepEqual(agents['team-dev'].disallowedTools, ['Agent', 'mcp__tracker']);
  assert.equal(agents['team-tester'].disallowedTools, undefined);
});

test('coordinator and ideation invocations differ in tools, MCP exposure and agents', () => {
  const coordinator = claudeInvocation({ ideate: false, prompt: 'cycle', model: 'sonnet', systemPromptFile: '/run/system-prompt.md', shared, mcp: { tracker: { type: 'http', url: 'https://mcp.linear.app/mcp' } }, denied: ['gh pr merge'] });
  assert.equal(coordinator.bin, 'claude');
  assert.equal(coordinator.args[0], 'cycle');
  assert.ok(coordinator.args.includes('--print') && coordinator.args.includes('--strict-mcp-config') && coordinator.args.includes('--no-session-persistence'));
  assert.deepEqual(JSON.parse(coordinator.args[coordinator.args.indexOf('--mcp-config') + 1]).mcpServers.tracker.url, 'https://mcp.linear.app/mcp');
  assert.deepEqual(coordinator.args.slice(coordinator.args.indexOf('--setting-sources'), coordinator.args.indexOf('--setting-sources') + 2), ['--setting-sources', 'user']);
  assert.ok(coordinator.args.includes('Bash(gh pr merge:*)') && coordinator.args.includes('mcp__tracker'));
  assert.equal(JSON.parse(coordinator.args[coordinator.args.indexOf('--agents') + 1])['team-pm'].prompt, 'Plan');
  assert.deepEqual(coordinator.args.slice(-2), ['--model', 'sonnet']);
  assert.ok(!coordinator.args.some(arg => /max-budget|fallback-model|dangerously|bare/.test(arg)));
  const ideation = claudeInvocation({ ideate: true, prompt: 'ideas', systemPromptFile: '/run/system-prompt.md', shared });
  assert.ok(ideation.args.includes('--restricted'));
  assert.deepEqual(ideation.args.slice(ideation.args.indexOf('--tools'), ideation.args.indexOf('--tools') + 2), ['--tools', 'Read,Grep,Glob,Write']);
  assert.deepEqual(JSON.parse(ideation.args[ideation.args.indexOf('--mcp-config') + 1]), { mcpServers: {} });
  assert.ok(!ideation.args.includes('--agents') && !ideation.args.includes('--model'));
});

test('system prompt inlines shared instructions, role and project instruction files', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'engines-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'prefs.md'), 'Owner preferences');
  const text = claudeSystemPrompt({ shared: { ...shared, instructions: [path.join(dir, 'prefs.md')] }, role: 'team-coordinator',
    instructions: [{ file: 'docs/CHARTER.md', content: 'Product scope' }] });
  for (const part of ['Owner preferences', 'Coordinate', 'Agent tool', 'team-pm, team-dev, team-tester', '## docs/CHARTER.md', 'Product scope']) assert.ok(text.includes(part), part);
  assert.ok(!claudeSystemPrompt({ shared: { ...shared, instructions: [], agent: { ...shared.agent, 'team-ideation': { mode: 'primary', prompt: 'Ideate' } } }, role: 'team-ideation', instructions: [] }).includes('Agent tool'));
});

test('usage limits are recognized from stream events or stderr and nothing else', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'engines-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const eventsFile = path.join(dir, 'events.jsonl'); const stderrFile = path.join(dir, 'stderr.log');
  const check = (events, stderr) => { writeFileSync(eventsFile, events); writeFileSync(stderrFile, stderr); return claudeStopReason({ eventsFile, stderrFile }); };
  assert.equal(check('{"type":"result","is_error":false,"result":"done"}\n', 'ordinary failure'), null);
  assert.equal(check('{"type":"rate_limit_event","rate_limit_info":{"status":"rejected"}}\n', ''), 'rate-limited');
  assert.equal(check('{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning"}}\n', ''), null);
  assert.equal(check('{"type":"result","is_error":true,"result":"You have hit your usage limit"}\n', ''), 'rate-limited');
  assert.equal(check('x'.repeat(70000) + '\n{"type":"result","is_error":true,"result":"Rate limit reached"}\n', ''), 'rate-limited');
  assert.equal(check('', 'API Error: 429 too many requests'), 'rate-limited');
  assert.equal(claudeStopReason({ eventsFile: path.join(dir, 'missing'), stderrFile: path.join(dir, 'missing') }), null);
});

test('integration servers granted to named roles are withheld from every other agent', () => {
  const access = { slack: ['team-dev'], crm: ['team-coordinator'] };
  const agents = claudeAgents(shared, ['tracker', 'slack', 'crm'], access);
  assert.deepEqual(agents['team-tester'].disallowedTools, ['mcp__slack', 'mcp__crm']);
  assert.deepEqual(agents['team-dev'].disallowedTools, ['Agent', 'mcp__tracker', 'mcp__slack', 'mcp__crm'], 'a tracker denial still denies every server');
  assert.deepEqual(agents['team-pm'].disallowedTools, ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'Agent', 'mcp__slack', 'mcp__crm']);
  const { args } = claudeInvocation({ prompt: 'go', systemPromptFile: '/tmp/p.md', shared, mcp: { tracker: { type: 'http', url: 'https://t.example/' }, slack: { type: 'http', url: 'https://s.example/', headers: { Authorization: 'Bearer x' } }, crm: { type: 'http', url: 'https://c.example/' } }, access });
  const allowed = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools'));
  assert.deepEqual(allowed, ['Bash', 'mcp__tracker', 'mcp__crm'], 'the coordinator keeps open servers and those naming it');
  const disallowed = args.slice(args.indexOf('--disallowedTools') + 1, args.indexOf('--agents'));
  assert.ok(disallowed.includes('mcp__slack'));
  assert.equal(JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers.slack.headers.Authorization, 'Bearer x');
});
