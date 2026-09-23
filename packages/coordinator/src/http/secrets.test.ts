import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './testing.ts';

const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef';

test('a key typed into the app is kept sealed, makes the provider ready at once, and reaches a worker only with a turn that needs it', async () => {
  const env: NodeJS.ProcessEnv = { AGENT_TEAM_NO_CLI_LOGIN: '1' };
  // The product's own model list, as its public address answers.
  const listed: string[] = [];
  const request = (async (input: unknown) => {
    listed.push(String(input));
    return new Response(JSON.stringify({ data: [{ id: 'vendor/model-a', name: 'Vendor: Model A', context_length: 200000, pricing: { prompt: '0.000003', completion: '0.000015' } }, { id: 'vendor/free', name: 'Vendor: Free', pricing: { prompt: '0', completion: '0' } }] }), { status: 200 });
  }) as typeof fetch;
  const { coordinator, db, call, owner, machine } = await boot({ env, fetch: request });
  try {
    const cookie = await owner();
    const entry = async () => ((await call('/api/providers/catalog', { cookie })).json.entries as { kind: string; keySaved: boolean; hasList: boolean; readiness: { state: string; need: string | null } }[]).find(item => item.kind === 'openrouter')!;

    // Models are picked from the product's list, with prices, not typed; the list is fetched once and remembered.
    const models = (await call('/api/providers/catalog/openrouter/models', { cookie })).json;
    assert.deepEqual([models.live, models.models[0]], [true, { id: 'openrouter/vendor/model-a', name: 'Vendor: Model A', note: '$3.00 in · $15.00 out per million · 200k context' }]);
    await call('/api/providers/catalog/openrouter/models', { cookie });
    assert.equal(listed.length, 1);
    // A tool that keeps its list on the worker: what the worker reported is what is offered. Until one reports, nothing is made up.
    assert.deepEqual((await call('/api/providers/catalog/codex-subscription/models', { cookie })).json, { models: [], live: false, error: null });
    await call('/worker/claim', { headers: machine, body: { workerId: 'bolt', free: {}, projects: [], ready: { engines: ['codex'], variables: [], models: { codex: [{ id: 'model-next', name: 'Model Next', note: 'The newest one' }] } } } });
    assert.deepEqual((await call('/api/providers/catalog/codex-subscription/models', { cookie })).json, { models: [{ id: 'model-next', name: 'Model Next', note: 'The newest one' }], live: true, error: null });
    // The same for a tool that names its models in its help text: nothing until a worker read it, then exactly that, with the effort levels it takes.
    assert.deepEqual((await call('/api/providers/catalog/claude-subscription/models', { cookie })).json.models, []);
    await call('/worker/claim', { headers: machine, body: { workerId: 'bolt', free: {}, projects: [], ready: { engines: ['claude', 'codex'], variables: [], models: { claude: [{ id: 'newest', name: 'newest' }], codex: [{ id: 'model-next', name: 'Model Next', efforts: ['low', 'high'] }] }, efforts: { claude: ['quick', 'deep'] } } } });
    assert.deepEqual((await call('/api/providers/catalog/claude-subscription/models', { cookie })).json.models.map((model: { id: string }) => model.id), ['newest']);

    // A worker has the tool but no key anywhere: the page asks for the key.
    await call('/worker/claim', { headers: machine, body: { workerId: 'atlas', free: {}, projects: [], ready: { engines: ['opencode'], variables: [] } } });
    assert.deepEqual([(await entry()).readiness.need, (await entry()).keySaved], ['key', false]);
    assert.match((await call('/api/providers/setup', { cookie, body: { kind: 'openrouter', key: 'short', values: { models: 'openrouter/vendor/model-a' } } })).json.error.fields.key, /does not look like a key/);
    assert.match((await call('/api/providers/setup', { cookie, body: { kind: 'claude-subscription', key: KEY, values: { models: 'sonnet' } } })).json.error.fields.key, /takes no key/);

    // Typed once in the app: ready at once, nothing restarted, and the value is nowhere in what the app is told or in the database.
    const made = await call('/api/providers/setup', { cookie, body: { kind: 'openrouter', key: KEY, values: { models: 'openrouter/vendor/model-a' } } });
    assert.equal(made.status, 200);
    assert.deepEqual([(await entry()).readiness.state, (await entry()).keySaved, env.OPENROUTER_API_KEY], ['ready', true, KEY]);
    const stored = await db.selectFrom('secrets').selectAll().execute();
    assert.deepEqual([stored.map(row => row.name), stored[0]!.sealed.includes(KEY)], [['OPENROUTER_API_KEY'], false]);
    for (const path of ['/api/providers', '/api/providers/catalog', '/api/audit']) assert.ok(!(await call(path, { cookie })).text.includes(KEY), `${path} never carries the key`);

    // A turn on that provider carries the key to the worker that claimed it; a turn on anything else carries nothing.
    await call('/api/projects', { cookie, body: { name: 'Shop' } });
    const project = (await call('/api/projects/shop', { cookie })).json, agent = project.roster[0];
    await call(`/api/agents/${agent.id}/provider`, { cookie, body: { providerId: made.json.id, model: 'openrouter/vendor/model-a' } });
    await call(`/api/agents/${agent.id}/dm`, { cookie, body: { body: 'Are you there?' } });
    const claimed = (await call('/worker/claim', { headers: machine, body: { workerId: 'atlas', free: { work: 1, bounded: 1 }, projects: [project.project.id], ready: { engines: ['opencode'], variables: [] } } })).json.turn;
    assert.ok(claimed, 'the reply turn was claimed');
    assert.deepEqual(claimed.secrets, { OPENROUTER_API_KEY: KEY });

    // Removing the provider forgets its key.
    await call(`/api/agents/${agent.id}/provider`, { cookie, body: { providerId: null, model: null } });
    assert.equal((await call(`/api/providers/${made.json.id}/remove`, { cookie, body: {} })).status, 200);
    assert.deepEqual([(await db.selectFrom('secrets').selectAll().execute()).length, env.OPENROUTER_API_KEY], [0, undefined]);
  } finally { await coordinator.close(); }
});

test('a token pasted while connecting something is saved, used for the check, and survives a restart of the coordinator', async () => {
  const env: NodeJS.ProcessEnv = { AGENT_TEAM_NO_CLI_LOGIN: '1' };
  const TEAM = { id: '5f1e7a2b-0000-4000-8000-000000000002', name: 'Web' };
  const seen: string[] = [];
  const request = (async (_input: unknown, init?: { headers?: Record<string, string> }) => { seen.push(init?.headers?.authorization ?? ''); return new Response(JSON.stringify({ data: { project: { name: 'Checkout', teams: { nodes: [TEAM] }, issues: { nodes: [{ id: 'i-1' }] } }, projects: { nodes: [{ id: '9d6c1c2e-0000-4000-8000-000000000001', name: 'Checkout', teams: { nodes: [TEAM] } }] } } }), { status: 200 }); }) as typeof fetch;
  const { coordinator, call, owner } = await boot({ env, fetch: request });
  try {
    const cookie = await owner();
    await call('/api/projects', { cookie, body: { name: 'Shop' } });
    const values = { projectId: '9d6c1c2e-0000-4000-8000-000000000001' };
    assert.match((await call('/api/projects/shop/integrations/test', { cookie, body: { kind: 'linear', values } })).json.message, /Paste the Linear API key first/);
    // An ID is picked from the product's own list with the pasted token, not copied by hand; the list never travels with the catalog.
    const field = ((await call('/api/projects/shop/integrations/catalog', { cookie })).json.entries as { kind: string; fields: { key: string; pickable: boolean; choices?: unknown }[] }[]).find(item => item.kind === 'linear')!.fields[0]!;
    assert.deepEqual([field.pickable, field.choices], [true, undefined]);
    assert.match((await call('/api/projects/shop/integrations/choices', { cookie, body: { kind: 'linear', field: 'projectId' } })).json.message, /Paste the Linear API key first/);
    assert.deepEqual((await call('/api/projects/shop/integrations/choices', { cookie, body: { kind: 'linear', field: 'projectId', token: 'lin_api_0123456789' } })).json.choices, [{ value: values.projectId, label: 'Checkout (Web)', also: { teamId: TEAM.id } }], 'a project of one team fills in its team');
    // The check uses what was pasted, before anything is saved.
    const checkedNow = (await call('/api/projects/shop/integrations/test', { cookie, body: { kind: 'linear', values, token: 'lin_api_0123456789' } })).json;
    assert.deepEqual([checkedNow.ok, seen.at(-1), env.LINEAR_API_KEY], [true, 'lin_api_0123456789', undefined]);
    assert.equal(checkedNow.message, 'Reached the Linear project "Checkout" in the Web team: 1 issue to read.');
    assert.equal((await call('/api/projects/shop/integrations/setup', { cookie, body: { kind: 'linear', values, token: 'lin_api_0123456789' } })).status, 200);
    assert.equal(env.LINEAR_API_KEY, 'lin_api_0123456789');
    const connection = ((await call('/api/projects/shop/integrations', { cookie })).json.connections as { name: string; status: string; statusDetail: string }[]).find(item => item.name === 'Linear')!;
    assert.deepEqual([connection.status, connection.statusDetail], ['connected', 'Linear API key saved']);
    const entry = ((await call('/api/projects/shop/integrations/catalog', { cookie })).json.entries as { kind: string; credentialPresent: boolean; credentialSource: string }[]).find(item => item.kind === 'linear')!;
    assert.deepEqual([entry.credentialPresent, entry.credentialSource], [true, 'saved here']);

    // Another process with the same database and key file opens it again.
    const again: NodeJS.ProcessEnv = {};
    const { createSecretStore } = await import('../auth/secretStore.ts');
    await createSecretStore({ storage: coordinator.context.storage, dataDir: coordinator.context.dataDir, env: again, now: Date.now }).load();
    assert.equal(again.LINEAR_API_KEY, 'lin_api_0123456789');
  } finally { await coordinator.close(); }
});
