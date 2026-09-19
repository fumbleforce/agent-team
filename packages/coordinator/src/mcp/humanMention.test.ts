import test from 'node:test';
import assert from 'node:assert/strict';
import { seedDemo } from '../demo/seed.ts';
import { startCoordinator } from '../server.ts';

test('@agent in a message a person posts wakes that agent once; without a name it goes to the PM', async () => {
  const coordinator = await startCoordinator({ port: 0, storage: { kind: 'sqlite', path: ':memory:' }, machineToken: 'x'.repeat(24), webRoot: null });
  try {
    await seedDemo(coordinator.context);
    const db = coordinator.context.storage.db;
    const login = await fetch(`${coordinator.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'demo@example.com', password: 'demo-password-1234' }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const project = await db.selectFrom('projects').select('id').where('slug', '=', 'checkout-v2').executeTakeFirstOrThrow();
    const thread = await db.selectFrom('threads').select('id').where('project_id', '=', project.id).where('kind', '=', 'discussion').executeTakeFirstOrThrow();
    const say = async (body: string) => (await fetch(`${coordinator.url}/api/threads/${thread.id}/messages`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ body }) })).status;
    const queued = async () => (await db.selectFrom('work_items').innerJoin('agents', 'agents.id', 'work_items.agent_id').select(['agents.name', 'work_items.kind']).where('work_items.thread_id', '=', thread.id).where('work_items.state', '=', 'queued').execute()).map(item => `${item.name}:${item.kind}`).sort();

    assert.equal(await say('@Ada is staging up?'), 200);
    assert.deepEqual(await queued(), ['Ada:reply']);
    const mention = await db.selectFrom('mentions').select(['author_kind', 'target_type', 'state', 'depth']).executeTakeFirstOrThrow();
    assert.deepEqual({ ...mention }, { author_kind: 'user', target_type: 'agent', state: 'woken', depth: 1 });
    assert.equal(await say('Anyone know why the build is red?'), 200);
    assert.deepEqual(await queued(), ['Ada:reply', 'Maren:triage']);
  } finally { await coordinator.close(); }
});
