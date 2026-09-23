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

  // A connected tool's token is read from its private file into the engine's own config file, never argv, the environment or the prompt.
  test(`${name}: a connected tool reaches the engine only through its MCP config, with its token`, () => {
    const { spec: turn, dir } = spec();
    const toolToken = path.join(dir, 'tool-crm-token');
    writeFileSync(toolToken, 'crm-secret-value');
    const prepared = adapter.prepare({ ...turn, tools: [{ name: 'crm', url: 'http://127.0.0.1:9/mcp', tokenFile: toolToken }] }, dir, adapter.environment(HOSTILE));
    assert.ok(![...prepared.args, prepared.input ?? '', ...Object.values(prepared.env).map(String)].some(text => text.includes('crm-secret-value')));
    const config = prepared.files.find(file => file.content.includes('http://127.0.0.1:9/mcp'));
    if (adapter.capabilities.mcp === 'http') {
      assert.ok(config?.content.includes('Bearer crm-secret-value'), 'the server carries its bearer header');
      assert.ok(config!.content.includes(SECRET), 'the platform is still there');
    } else assert.equal(config, undefined);
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

test('claude: a connected tool is in mcp.json beside the platform and allowed by its server name', () => {
  const { spec: turn, dir } = spec({ toolProfile: 'read-only' });
  writeFileSync(path.join(dir, 'tool-crm-token'), 'crm-secret-value');
  const prepared = engineAdapter('claude').prepare({ ...turn, tools: [{ name: 'crm', url: 'http://127.0.0.1:9/mcp', tokenFile: path.join(dir, 'tool-crm-token') }, { name: 'docs', url: 'https://docs.example/mcp', tokenFile: null }] }, dir, {});
  const config = JSON.parse(prepared.files.find(file => file.path.endsWith('mcp.json'))!.content) as { mcpServers: Record<string, { type: string; url: string; headers?: Record<string, string> }> };
  assert.deepEqual(config.mcpServers.crm, { type: 'http', url: 'http://127.0.0.1:9/mcp', headers: { Authorization: 'Bearer crm-secret-value' } });
  assert.deepEqual(config.mcpServers.docs, { type: 'http', url: 'https://docs.example/mcp' });
  assert.equal(config.mcpServers.platform!.headers!.Authorization, `Bearer ${SECRET}`);
  const allowed = prepared.args.slice(prepared.args.indexOf('--allowedTools') + 1, prepared.args.indexOf('--disallowedTools'));
  assert.deepEqual(allowed, ['mcp__platform', 'mcp__crm', 'mcp__docs']);
});

test('claude: the context size is what the latest model call carried, not the sum over the turn; tool lookups are not steps', () => {
  const claude = engineAdapter('claude'), state = newParseState();
  const call = (input: number, cached: number, output: number, content: unknown[]) => JSON.stringify({ type: 'assistant', message: { content, usage: { input_tokens: input, cache_read_input_tokens: cached, cache_creation_input_tokens: 0, output_tokens: output } } });
  const steps = [call(10, 40_000, 200, [{ type: 'tool_use', name: 'ToolSearch', input: { query: 'select:x' } }]), call(12, 41_000, 300, [{ type: 'text', text: 'Done.' }])].flatMap(line => claude.parse(line, state));
  claude.parse(JSON.stringify({ type: 'result', total_cost_usd: 0.4, usage: { input_tokens: 22, cache_read_input_tokens: 81_000, output_tokens: 500 }, result: 'Done.' }), state);
  assert.deepEqual(steps.map(step => step.kind), ['think']);
  assert.equal(state.contextTokens, 41_312);
  assert.equal(state.tokensIn, 81_022);
});

test('what a tool offers is read from the tool itself: codex from the list it keeps, with the effort levels of each model; claude from its handshake, else its help text', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const home = mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'model-next', display_name: 'Model Next', description: 'The newest one', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] }, { slug: 'internal-review', visibility: 'hide' }] }));
  assert.deepEqual(await engineAdapter('codex').discover?.({ env: { CODEX_HOME: home }, run: async () => '' }), { models: [{ id: 'model-next', name: 'Model Next', note: 'The newest one', efforts: ['low', 'high'] }], efforts: ['low', 'high'] });
  assert.deepEqual(await engineAdapter('codex').discover?.({ env: { CODEX_HOME: path.join(home, 'missing') }, run: async () => '' }), { models: [], efforts: [] });

  // The help text as the tool prints it, wrapped over lines.
  const help = `  --effort <level>                      Effort level for the current session
                                        (quick, steady, deep)
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'newest', 'middle', or 'small') or a
                                        model's full name (e.g.
                                        'vendor-model-1-2').`;
  const helpOnly = async (args: string[]) => (args[0] === '--help' ? help : '');
  assert.deepEqual(await engineAdapter('claude').discover?.({ env: {}, run: helpOnly }), { models: ['newest', 'middle', 'small'].map(id => ({ id, name: id, note: 'always the newest of its family' })), efforts: ['quick', 'steady', 'deep'] });
  // A tool that says nothing yields nothing; nothing is made up in its place.
  assert.deepEqual(await engineAdapter('claude').discover?.({ env: {}, run: async () => '' }), { models: [], efforts: [] });

  // The handshake's answer is the sign-in's own list, with names, notes and the effort levels of each model. It is asked on stdin.
  const asked: { args: string[]; input?: string }[] = [];
  const answer = [
    JSON.stringify({ type: 'system', subtype: 'noise' }),
    JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'models', response: { models: [
      { value: 'default', displayName: 'Default (recommended)', description: 'Whatever the tool picks' },
      { value: 'big[1m]', displayName: 'Big (1M context)', description: 'For hard work', supportedEffortLevels: ['low', 'high', 'x y'] },
      { value: 'small', displayName: 'Small' },
      { value: 'has space', displayName: 'Refused' },
    ] } } }),
  ].join('\n');
  const handshake = async (args: string[], input?: string) => { asked.push({ args, ...(input === undefined ? {} : { input }) }); return args.includes('--input-format') ? answer : help; };
  assert.deepEqual(await engineAdapter('claude').discover?.({ env: {}, run: handshake }), { models: [{ id: 'big[1m]', name: 'Big (1M context)', note: 'For hard work', efforts: ['low', 'high'] }, { id: 'small', name: 'Small' }], efforts: ['low', 'high'] });
  assert.equal(asked.length, 1, 'the help text is not read when the handshake answers');
  assert.equal(JSON.parse(asked[0]!.input!).request.subtype, 'initialize');

  // Cursor and opencode list what their sign-in or configuration may use.
  const cursorList = '\x1b[2KLoading models…\nAvailable models\n\nauto - Auto  (current)\nfast-one - Fast One\nTip: use --model <id> to switch.\n';
  assert.deepEqual(await engineAdapter('cursor').discover?.({ env: {}, run: async args => (args[0] === 'models' ? cursorList : '') }), { models: [{ id: 'auto', name: 'Auto' }, { id: 'fast-one', name: 'Fast One' }], efforts: [] });
  assert.deepEqual(await engineAdapter('opencode').discover?.({ env: {}, run: async args => (args[0] === 'models' ? 'vendor/model-a\nlocal/model-b:7b\nsome log line\nvendor/model-a\n' : '') }), { models: [{ id: 'vendor/model-a', name: 'vendor/model-a' }, { id: 'local/model-b:7b', name: 'local/model-b:7b' }], efforts: [] });
});

test('every engine reaches the platform: codex through the bridge, cursor through the call command, and neither is handed the token', () => {
  const { spec: turn, dir } = spec();
  const codexTurn = engineAdapter('codex').prepare(turn, dir, {});
  const bridged = codexTurn.args.find(arg => arg.startsWith('mcp_servers.platform.args='))!;
  assert.deepEqual(JSON.parse(bridged.slice('mcp_servers.platform.args='.length)).slice(1), ['mcp-bridge', 'http://127.0.0.1:4310/mcp', turn.platform!.tokenFile]);
  const cursorTurn = engineAdapter('cursor').prepare(turn, dir, {});
  assert.deepEqual([cursorTurn.env.AGENT_TEAM_PLATFORM_URL, cursorTurn.env.AGENT_TEAM_TURN_TOKEN_FILE], ['http://127.0.0.1:4310/mcp', turn.platform!.tokenFile]);
  assert.match(cursorTurn.input ?? '', /# The platform's tools[\s\S]*call --list/);
  for (const prepared of [codexTurn, cursorTurn]) assert.ok(![...prepared.args, prepared.input ?? '', ...Object.values(prepared.env).map(String)].some(text => text.includes(SECRET)));
});

test('claude: the usage window is read from the service\'s own figures, and a rejection is a limit', () => {
  const state = newParseState();
  engineAdapter('claude').parse(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', utilization: 0.92, resetsAt: 1_800_000_000 } }), state);
  assert.deepEqual([state.window, state.limited], [{ used: 0.92, resetsAt: 1_800_000_000_000 }, false]);
  engineAdapter('claude').parse(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', utilization: 1.01, resetsAt: 1_800_000_600 } }), state);
  assert.deepEqual([state.window, state.limited], [{ used: 1.01, resetsAt: 1_800_000_600_000 }, true]);
});

test('what is known about a model is looked up by the name a provider gives it, and nothing is made up where the list is silent', async () => {
  const { factsOf, publishedModels } = await import('./models.ts');
  const listed = await publishedModels((async () => new Response(JSON.stringify({ data: [{ id: 'openai/gpt-5.5', context_length: 400_000, pricing: { prompt: '0.00000125', completion: '0.00001' } }, { id: 'qwen/qwen3-coder', context_length: 262_144, pricing: { prompt: '0', completion: '0' } }] }))) as typeof fetch);
  assert.deepEqual(factsOf(listed, 'gpt-5.5'), { contextTokens: 400_000, inputUsd: 0.00000125, outputUsd: 0.00001, family: 'gpt', openWeight: false });
  assert.deepEqual(factsOf(listed, 'openrouter/qwen/qwen3-coder').contextTokens, 262_144);
  assert.equal(factsOf(listed, 'openrouter/qwen/qwen3-coder').openWeight, true);
  assert.deepEqual(factsOf(listed, 'someone/unknown-model'), { contextTokens: null, inputUsd: null, outputUsd: null, family: 'unknown', openWeight: false });
});
