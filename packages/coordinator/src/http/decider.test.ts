import test from 'node:test';
import assert from 'node:assert/strict';
import { environmentDecider } from '../../../../adapters/decider/index.ts';
import { boot } from './testing.ts';

test('the integrations page says whether the decision model is on, on which key, and what it has read; the TypeSafe key is entered there', async () => {
  const env: NodeJS.ProcessEnv = {}, request = (async () => { throw new Error('no network under test'); }) as unknown as typeof fetch;
  const { coordinator, db, call, owner, person } = await boot({ env, fetch: request, decider: environmentDecider(env, request) });
  try {
    const cookie = await owner(), member = await person('mia', 'member');
    await call('/api/projects', { cookie, body: { name: 'Shop' } });
    const state = async (who = cookie) => (await call('/api/decider?project=shop', { cookie: who })).json;

    // No key anywhere: off, and the page says where a key would go.
    assert.deepEqual([(await state()).on, (await state()).name, (await state()).source, (await state()).reads.count, (await state(member.cookie)).canEdit], [false, 'Jev', null, 0, false]);
    assert.deepEqual((await state()).keys, [{ label: 'TypeSafe key', own: true, saved: false, inEnvironment: false, active: false }, { label: 'OpenRouter key', own: false, saved: false, inEnvironment: false, active: false }]);
    assert.equal((await call('/api/decider?project=nowhere', { cookie })).status, 404);

    // The OpenRouter provider's key turns it on too, since OpenRouter serves the same API.
    env.OPENROUTER_API_KEY = 'sk-or-from-the-environment';
    assert.deepEqual([(await state()).on, (await state()).source, (await state()).keys[1]], [true, 'OpenRouter key', { label: 'OpenRouter key', own: false, saved: false, inEnvironment: true, active: true }]);

    // Only admins enter the TypeSafe key; once saved it is preferred, sealed, and never shown back.
    assert.equal((await call('/api/decider/key', { cookie: member.cookie, body: { key: 'ts-live-1234567890' } })).status, 403);
    assert.match((await call('/api/decider/key', { cookie, body: { key: 'two words' } })).json.error.fields.key, /does not look like a key/);
    assert.equal((await call('/api/decider/key', { cookie, body: { key: 'ts-live-1234567890' } })).status, 200);
    assert.deepEqual([(await state()).source, (await state()).keys[0], env.TYPESAFE_API_KEY], ['TypeSafe key', { label: 'TypeSafe key', own: true, saved: true, inEnvironment: false, active: true }, 'ts-live-1234567890']);
    assert.ok(!(await call('/api/decider?project=shop', { cookie })).text.includes('ts-live'), 'the key is never sent back');
    assert.deepEqual((await db.selectFrom('secrets').select('name').execute()).map(row => row.name), ['TYPESAFE_API_KEY']);

    // What was read is counted for the project, with its cost and the model that answered.
    const project = await db.selectFrom('projects').select('id').where('slug', '=', 'shop').executeTakeFirstOrThrow();
    await db.insertInto('machine_decisions').values({ id: 'read-1', project_id: project.id, task_id: null, thread_id: null, purpose: 'triage', model: 'typesafe/jev', questions: '{}', answers: '{}', confidence: 0.9, input_tokens: 400, usd_micro: 17, applied: false, judged_at: null, overturned_at: null, overturned_by: null, created_at: 5 }).execute();
    assert.deepEqual((await state()).reads, { count: 1, usdMicro: 17, lastAt: 5, model: 'typesafe/jev' });

    // Forgetting the key falls back to the OpenRouter one.
    assert.equal((await call('/api/decider/key/remove', { cookie, body: {} })).status, 200);
    assert.deepEqual([(await state()).source, env.TYPESAFE_API_KEY], ['OpenRouter key', undefined]);
    delete env.OPENROUTER_API_KEY;
    assert.equal((await state()).on, false);
  } finally { await coordinator.close(); }
});
