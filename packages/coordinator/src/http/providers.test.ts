import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './testing.ts';

test('a model provider is added through the guided flow, in plain words, and readiness is what the workers report', async () => {
  const { coordinator, db, call, owner, person, machine } = await boot();
  try {
    const cookie = await owner(), member = await person('mia', 'member');
    const catalog = (await call('/api/providers/catalog', { cookie })).json.entries as { kind: string; title: string; summary: string; billing: string; engine: string; install: string; signIn?: string; key?: { variable: string; optional?: boolean }; keySaved: boolean; listModels?: unknown; readiness: { state: string; message: string } }[];
    assert.ok(catalog.length >= 6 && catalog.every(entry => entry.title && entry.install && entry.listModels === undefined));
    // Few words: nothing a person has to read runs past one line.
    assert.ok(catalog.every(entry => entry.summary.length <= 80), 'summaries stay short');
    // A subscription login is never offered with a key: that is how it would quietly become metered.
    assert.ok(catalog.filter(entry => entry.billing === 'subscription').every(entry => entry.signIn && (!entry.key || entry.key.optional)), 'a subscription signs in; a key it takes is only for machines nobody signs in on');
    assert.match(catalog[0]!.readiness.message, /No worker is running yet/);

    // Only the organization's admins set providers up; what was typed is checked field by field.
    assert.equal((await call('/api/providers/setup', { cookie: member.cookie, body: { kind: 'openrouter', values: { models: 'a/b' } } })).status, 403);
    assert.equal((await call('/api/providers/setup', { cookie, body: { kind: 'nothing', values: {} } })).status, 404);
    const bad = await call('/api/providers/setup', { cookie, body: { kind: 'openrouter', values: { models: 'two words', concurrency: 'many', windowHours: '5' } } });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error.fields.models, /a model name has no spaces/);
    assert.match(bad.json.error.fields.concurrency, /Turns at once should be a whole number between 1 and 64/);
    assert.match(bad.json.error.fields.windowTokens, /Set the allowance too/);
    assert.match((await call('/api/providers/setup', { cookie, body: { kind: 'openrouter', values: { models: ' \n ' } } })).json.error.fields.models, /at least one model/);
    assert.match((await call('/api/providers/setup', { cookie, body: { kind: 'openai-compatible', values: { models: 'gateway/m' } } })).json.error.fields.name, /Give it a name/);

    const made = await call('/api/providers/setup', { cookie, body: { kind: 'openrouter', values: { models: 'openrouter/vendor/model-a\nopenrouter/vendor/model-b, openrouter/vendor/model-a', concurrency: '3', windowTokens: '2,000,000', windowHours: '4' } } });
    assert.equal(made.status, 200);
    const row = await db.selectFrom('providers').selectAll().where('id', '=', made.json.id).executeTakeFirstOrThrow();
    assert.deepEqual([row.name, row.kind, row.billing, row.engine, JSON.parse(row.models)], ['OpenRouter', 'metered', 'metered', 'opencode', ['openrouter/vendor/model-a', 'openrouter/vendor/model-b']]);
    // The limits land where the scheduler's concurrency and window gates read them.
    assert.deepEqual(JSON.parse(row.limits), { maxConcurrentTurns: 3, windowTokens: 2_000_000, windowMs: 4 * 3600_000 });

    // Setting the same one up again edits it; it never makes a second, and how it bills never changes.
    const again = await call('/api/providers/setup', { cookie, body: { kind: 'openrouter', values: { models: 'openrouter/vendor/model-c' } } });
    assert.equal(again.json.id, made.json.id);
    assert.deepEqual(JSON.parse((await db.selectFrom('providers').select('limits').where('id', '=', made.json.id).executeTakeFirstOrThrow()).limits), { maxConcurrentTurns: 2 });
    const plain = await call('/api/providers', { cookie, body: { name: 'Plain', kind: 'subscription', engine: 'fake', models: ['m'], limits: { concurrency: 1, windowTokens: 5000 } } });
    assert.deepEqual(JSON.parse((await db.selectFrom('providers').select('limits').where('id', '=', plain.json.id).executeTakeFirstOrThrow()).limits), { maxConcurrentTurns: 1, windowTokens: 5000, windowMs: 5 * 3600_000 });
    assert.deepEqual((await db.selectFrom('events').select('type').where('type', 'like', 'provider.%').where('category', '=', 'audit').orderBy('seq').execute()).map(event => event.type), ['provider.added', 'provider.updated', 'provider.added']);

    // Workers say what they can run: the tool alone is not enough when a variable is needed. Names only ever travel.
    const claim = (workerId: string, ready?: unknown) => call('/worker/claim', { headers: machine, body: { workerId, free: {}, projects: [], ...(ready ? { ready } : {}) } });
    const state = async () => ((await call('/api/providers', { cookie })).json.providers as { id: string; readiness: { state: string; message: string } }[]).find(item => item.id === made.json.id)!.readiness;
    await claim('old-worker');
    assert.match((await state()).message, /Update and restart old-worker/);
    await claim('atlas', { engines: ['opencode'], variables: [] });
    assert.deepEqual([(await state()).state, /Add the OpenRouter key/.test((await state()).message)], ['waiting', true]);
    await claim('atlas', { engines: ['opencode'], variables: ['OPENROUTER_API_KEY'] });
    assert.deepEqual(await state(), { state: 'ready', need: null, workers: ['atlas'], message: 'Ready on atlas' });
    assert.equal((await claim('atlas', { engines: [], variables: ['not a name'] })).status, 400);
    const entries = (await call('/api/providers/catalog', { cookie })).json.entries as typeof catalog;
    assert.match(entries.find(entry => entry.kind === 'claude-subscription')!.readiness.message, /atlas and old-worker still need the tool installed/);
    assert.match(entries.find(entry => entry.kind === 'openai-compatible')!.readiness.message, /Ready on atlas/);

    // Changed in place from its own row: the models alone, with the limits left as they were; a model an agent runs on stays.
    const limitsBefore = (await db.selectFrom('providers').select('limits').where('id', '=', made.json.id).executeTakeFirstOrThrow()).limits;
    assert.equal((await call(`/api/providers/${made.json.id}/change`, { cookie: member.cookie, body: { models: ['x/y'] } })).status, 403);
    assert.equal((await call(`/api/providers/${made.json.id}/change`, { cookie, body: { models: [] } })).status, 400);
    assert.equal((await call(`/api/providers/${made.json.id}/change`, { cookie, body: { models: ['openrouter/vendor/model-c', 'openrouter/vendor/model-d'] } })).status, 200);
    const changedRow = await db.selectFrom('providers').select(['models', 'limits']).where('id', '=', made.json.id).executeTakeFirstOrThrow();
    assert.deepEqual([JSON.parse(changedRow.models), changedRow.limits], [['openrouter/vendor/model-c', 'openrouter/vendor/model-d'], limitsBefore]);
    await call(`/api/providers/${made.json.id}/change`, { cookie, body: { concurrency: 5 } });
    assert.equal(JSON.parse((await db.selectFrom('providers').select('limits').where('id', '=', made.json.id).executeTakeFirstOrThrow()).limits).maxConcurrentTurns, 5);

    // A provider in use is not removed from under its agents.
    await call('/api/projects', { cookie, body: { name: 'Shop' } });
    const agent = (await call('/api/projects/shop', { cookie })).json.roster[0];
    await call(`/api/agents/${agent.id}/provider`, { cookie, body: { providerId: made.json.id, model: 'openrouter/vendor/model-c' } });
    const stranded = await call(`/api/providers/${made.json.id}/change`, { cookie, body: { models: ['openrouter/vendor/model-d'] } });
    assert.deepEqual([stranded.status, new RegExp(`${agent.name} still runs on openrouter/vendor/model-c`).test(stranded.json.error.message)], [409, true]);
    const refused = await call(`/api/providers/${made.json.id}/remove`, { cookie, body: {} });
    assert.deepEqual([refused.status, new RegExp(`${agent.name} still runs on OpenRouter`).test(refused.json.error.message)], [409, true]);
    await call(`/api/agents/${agent.id}/provider`, { cookie, body: { providerId: null, model: null } });
    assert.equal((await call(`/api/providers/${made.json.id}/remove`, { cookie: member.cookie, body: {} })).status, 403);
    assert.equal((await call(`/api/providers/${made.json.id}/remove`, { cookie, body: {} })).status, 200);
    assert.deepEqual(((await call('/api/providers', { cookie })).json.providers as { name: string }[]).map(item => item.name), ['Plain']);
  } finally { await coordinator.close(); }
});

test('a team is edited by hand: create, change, reorder, one PM, pause and retire, each in the audit log', async () => {
  const { coordinator, db, call, owner } = await boot();
  try {
    const cookie = await owner();
    await call('/api/projects', { cookie, body: { name: 'Shop' } });
    const team = async () => (await call('/api/projects/shop/team', { cookie })).json as { seats: { id: string; name: string; isPm: boolean; status: string; roles: string[]; title: string; providerId: string | null; model: string | null }[]; roles: { slug: string; summary: string }[]; canEdit: boolean };
    const before = await team();
    assert.ok(before.canEdit && before.roles.length > 0 && before.roles.every(role => role.summary), 'roles come with their one-line summary');
    assert.equal(before.seats.filter(seat => seat.isPm).length, 1);
    const provider = (await call('/api/providers', { cookie, body: { name: 'Local', kind: 'local', engine: 'fake', models: ['small'] } })).json.id;

    const role = before.roles[0]!.slug;
    assert.match((await call('/api/projects/shop/team/agents', { cookie, body: { name: 'Noor', roles: ['no-such-role'] } })).json.error.fields.roles, /no-such-role is not in the role library/);
    assert.match((await call('/api/projects/shop/team/agents', { cookie, body: { name: 'Noor', providerId: provider, model: 'huge' } })).json.error.fields.provider, /Local does not offer huge/);
    const noor = (await call('/api/projects/shop/team/agents', { cookie, body: { name: 'Noor Hale', title: 'Tester', persona: 'Careful.', roles: [role], providerId: provider, model: 'small' } })).json.id;
    const made = (await team()).seats.at(-1)!;
    assert.deepEqual([made.id, made.name, made.isPm, made.roles, made.providerId, made.model], [noor, 'Noor Hale', false, [role], provider, 'small']);

    // Editing leaves what was not named alone.
    assert.equal((await call(`/api/agents/${noor}`, { cookie, body: { title: 'Test lead', roles: [] } })).status, 200);
    const edited = (await team()).seats.at(-1)!;
    assert.deepEqual([edited.name, edited.title, edited.roles, edited.model], ['Noor Hale', 'Test lead', [], 'small']);

    // Order is the list that was sent; a list that is not the whole team is refused.
    const ids = (await team()).seats.map(seat => seat.id);
    assert.equal((await call('/api/projects/shop/team/order', { cookie, body: { agentIds: ids.slice(1) } })).status, 409);
    assert.equal((await call('/api/projects/shop/team/order', { cookie, body: { agentIds: [noor, ...ids.slice(0, -1)] } })).status, 200);
    assert.equal((await team()).seats[0]!.id, noor);
    assert.equal((await call('/api/projects/shop', { cookie })).json.roster[0].id, noor);

    // Exactly one PM, moved on purpose; the PM cannot be retired, and a paused seat cannot take the flag.
    const pm = before.seats.find(seat => seat.isPm)!;
    assert.match((await call(`/api/agents/${pm.id}`, { cookie, body: { status: 'retired' } })).json.error.message, /Make someone else the PM first/);
    await call(`/api/agents/${noor}`, { cookie, body: { status: 'paused' } });
    assert.equal((await call(`/api/agents/${noor}/pm`, { cookie, body: {} })).status, 409);
    await call(`/api/agents/${noor}`, { cookie, body: { status: 'active' } });
    assert.equal((await call(`/api/agents/${noor}/pm`, { cookie, body: {} })).status, 200);
    assert.deepEqual((await team()).seats.filter(seat => seat.isPm).map(seat => seat.id), [noor]);
    assert.equal((await call(`/api/agents/${pm.id}`, { cookie, body: { status: 'retired' } })).status, 200);
    assert.ok(!(await team()).seats.some(seat => seat.id === pm.id));
    assert.equal((await call(`/api/agents/${pm.id}`, { cookie, body: { title: 'Back' } })).status, 404);

    const audit = (await db.selectFrom('events').select(['type', 'user_id']).where('category', '=', 'audit').where(eb => eb.or([eb('type', 'like', 'agent.%'), eb('type', 'like', 'team.%')])).orderBy('seq').execute());
    assert.deepEqual(audit.map(event => event.type), ['agent.created', 'agent.updated', 'team.reordered', 'agent.paused', 'agent.resumed', 'team.pm_changed', 'agent.retired']);
    assert.ok(audit.every(event => event.user_id));
  } finally { await coordinator.close(); }
});

test('a provider names where its work goes when it cannot take it, from the other providers and their models', async () => {
  const { coordinator, call, owner } = await boot();
  try {
    const cookie = await owner();
    const add = async (name: string, models: string[]) => (await call('/api/providers', { cookie, body: { name, kind: 'metered', engine: 'opencode', models, maxConcurrentTurns: 2, limits: {} } })).json.id as string;
    const main = await add('Main', ['m1']), spare = await add('Spare', ['s1', 's2']);
    assert.equal((await call(`/api/providers/${main}/change`, { cookie, body: { fallbacks: [{ providerId: main, model: null }] } })).status, 400, 'not itself');
    assert.equal((await call(`/api/providers/${main}/change`, { cookie, body: { fallbacks: [{ providerId: spare, model: 'nope' }] } })).status, 400, 'only a model it has');
    assert.equal((await call(`/api/providers/${main}/change`, { cookie, body: { fallbacks: [{ providerId: spare, model: 's2' }] } })).status, 200);
    const listed = ((await call('/api/providers', { cookie })).json.providers as { id: string; fallbacks: unknown }[]).find(item => item.id === main)!;
    assert.deepEqual(listed.fallbacks, [{ providerId: spare, model: 's2' }]);
  } finally { await coordinator.close(); }
});

test('a subscription may be given its sign-in token for machines started for a job; a worker signed in by hand needs none', async () => {
  const { coordinator, db, call, owner } = await boot();
  try {
    const cookie = await owner();
    await db.insertInto('workers').values({ id: 'laptop', name: 'laptop', lanes: '{}', isolation: 'isolated', providers: JSON.stringify({ engines: ['claude'], variables: [] }), projects: '[]', last_seen_at: Date.now() }).execute();
    const entry = async () => ((await call('/api/providers/catalog', { cookie })).json.entries as { kind: string; readiness: { state: string }; keySaved: boolean; key: { optional?: boolean } }[]).find(item => item.kind === 'claude-subscription')!;
    assert.deepEqual([(await entry()).readiness.state, (await entry()).key.optional], ['ready', true], 'signed in on the worker is enough');
    assert.equal((await call('/api/providers/setup', { cookie, body: { kind: 'claude-subscription', key: 'sk-ant-oat01-abcdefgh', values: { models: 'sonnet' } } })).status, 200);
    assert.equal((await entry()).keySaved, true);
  } finally { await coordinator.close(); }
});
