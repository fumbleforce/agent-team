import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newParseState, type TurnSpec } from './contract.ts';
import { ENGINES, engineAdapter } from './index.ts';

const SECRET = 'turn.secret-token-value';
const HOSTILE = { PATH: '/bin', HOME: '/home/w', ANTHROPIC_API_KEY: 'k', AWS_SECRET_ACCESS_KEY: 'k', GH_TOKEN: 'k', AGENT_TEAM_TOKEN: 'k', DATABASE_URL: 'k', SOME_UNKNOWN_SECRET: 'k' };

function spec(overrides: Partial<TurnSpec> = {}): { spec: TurnSpec; dir: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'engine-contract-'));
  const tokenFile = path.join(dir, 'platform-token');
  writeFileSync(tokenFile, SECRET);
  return { dir, spec: { turnId: '01900000-0000-7000-8000-000000000001', kind: 'work', cwd: dir, prompt: 'Do the task', systemPrompt: 'You are Ada.', model: null, sessionId: null, toolProfile: 'write', platform: { url: 'http://127.0.0.1:4310/mcp', tokenFile }, ...overrides } };
}

// Every engine adapter passes the same suite.
for (const name of ENGINES) {
  const adapter = engineAdapter(name);

  test(`${name}: the model process inherits no secret, known or unknown`, () => {
    const env = adapter.environment(HOSTILE);
    assert.equal(env.PATH, '/bin');
    for (const key of Object.keys(HOSTILE).filter(item => item !== 'PATH' && item !== 'HOME')) assert.equal(env[key], undefined, key);
  });

  test(`${name}: secrets and prompts never appear in argv`, () => {
    const { spec: turn, dir } = spec();
    const prepared = adapter.prepare(turn, dir, adapter.environment(HOSTILE));
    assert.ok(!prepared.args.join(' ').includes(SECRET));
    assert.ok(!Object.values(prepared.env).some(value => value?.includes(SECRET)));
    assert.ok(!(prepared.input ?? '').includes(SECRET));
    assert.ok(!prepared.args.includes(turn.prompt));
  });

  test(`${name}: capability flags are honest`, () => {
    const { spec: turn, dir } = spec({ sessionId: 'session-1', toolProfile: 'read-only', kind: 'review' });
    const prepared = adapter.prepare(turn, dir, {});
    if (name !== 'fake' && adapter.capabilities.resume === 'id') assert.ok(prepared.args.includes('session-1'));
    // A bounded turn never carries the flag that grants writes on that engine.
    if (adapter.capabilities.bounded) for (const flag of ['acceptEdits', 'workspace-write', '--force']) assert.ok(!prepared.args.includes(flag), flag);
  });

  test(`${name}: garbage lines are ignored and exits are classified`, () => {
    const state = newParseState();
    assert.deepEqual(adapter.parse('not json', state), []);
    assert.equal(adapter.classifyExit({ code: 0, signal: null }, state, ''), 'completed');
    assert.equal(adapter.classifyExit({ code: 1, signal: null }, state, ''), 'crashed');
    state.limited = true;
    assert.equal(adapter.classifyExit({ code: 1, signal: null }, state, ''), 'rate-limited');
  });
}

test('claude: stream events become typed trace steps, usage and a session id', () => {
  const adapter = engineAdapter('claude'), state = newParseState();
  const lines = [
    { type: 'system', subtype: 'init', session_id: 'abc' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Reading the handler first.' }, { type: 'tool_use', name: 'Read', input: { file_path: 'src/pay.ts' } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/pay.ts' } }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }, { type: 'tool_use', name: 'mcp__platform__task_update', input: {} }] } },
    { type: 'result', total_cost_usd: 0.12, usage: { input_tokens: 900, output_tokens: 120 }, result: 'Done.' },
  ];
  const steps = lines.flatMap(line => adapter.parse(JSON.stringify(line), state));
  assert.deepEqual(steps.map(step => [step.seq, step.kind]), [[0, 'think'], [1, 'read'], [2, 'edit'], [3, 'run']]);
  assert.equal(steps[3]!.title, 'Bash: npm test');
  assert.deepEqual([state.sessionId, state.costUsd, state.tokensIn, state.summary], ['abc', 0.12, 900, 'Done.']);
  assert.equal(adapter.classifyExit({ code: 1, signal: null }, newParseState(), 'Error: No conversation found with session ID'), 'resume-missing');
});
