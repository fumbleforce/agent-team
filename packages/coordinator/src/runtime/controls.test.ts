import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from '../http/testing.ts';
import { seedDemo } from '../demo/seed.ts';
import { createTurns } from './turns.ts';

test('a 1:1 is read by its owner and by the reply it causes, and by nobody and nothing else', async () => {
  const { coordinator, db, call, owner, person } = await boot();
  try {
    const cookie = await owner();
    await seedDemo(coordinator.context);
    const project = await db.selectFrom('projects').select(['id', 'parent_id']).where('slug', '=', 'checkout-v2').executeTakeFirstOrThrow();
    const root = project.parent_id ?? project.id;
    const ada = await db.selectFrom('agents').select('id').where('name', '=', 'Ada').executeTakeFirstOrThrow();
    const other = await person('olga', 'admin');
    assert.equal((await call(`/api/agents/${ada.id}/dm`, { cookie: (await person('vera', 'viewer', { [root]: 'viewer' })).cookie, body: { body: 'hi' } })).status, 403);

    await db.updateTable('work_items').set({ state: 'done' }).execute();
    assert.equal((await call(`/api/agents/${ada.id}/dm`, { cookie, body: { body: 'Between us: is the v2 cut-over realistic for Thursday?' } })).status, 200);
    const mine = (await call(`/api/agents/${ada.id}/dm`, { cookie })).json as { threadId: string; messages: { body: string }[] };
    assert.deepEqual(mine.messages.map(message => message.body), ['Between us: is the v2 cut-over realistic for Thursday?']);

    // Another person, even an admin, gets their own empty thread and cannot open mine.
    assert.deepEqual(((await call(`/api/agents/${ada.id}/dm`, { cookie: other.cookie })).json as { messages: unknown[] }).messages, []);
    assert.equal((await call(`/api/threads/${mine.threadId}/messages`, { cookie: other.cookie })).status, 403);
    // It is not searchable and not in the discussion.
    assert.doesNotMatch(JSON.stringify((await call('/api/projects/checkout-v2/search?q=cut-over', { cookie: other.cookie })).json), /Between us/);

    // The message queued exactly one reply turn for that agent, on that thread; its packet carries the private text.
    const turns = createTurns(coordinator.context);
    const claimed = await turns.claim({ workerId: 'w1', free: { bounded: 1 }, projects: [project.id, root] });
    assert.deepEqual([claimed?.kind, claimed?.agentId, claimed?.threadId], ['reply', ada.id, mine.threadId]);
    assert.match(JSON.stringify(claimed?.packet), /cut-over realistic/);
  } finally { await coordinator.close(); }
});

test('stop now voids the running turn at once, pauses the agent and keeps the task; stopping a task parks it', async () => {
  const { coordinator, db, call, owner } = await boot();
  try {
    const cookie = await owner();
    await seedDemo(coordinator.context);
    const project = await db.selectFrom('projects').select('id').where('slug', '=', 'checkout-v2').executeTakeFirstOrThrow();
    const task = await db.selectFrom('tasks').select(['id', 'assignee_agent_id']).where('key', '=', 'CK-27').executeTakeFirstOrThrow();
    const turns = createTurns(coordinator.context);
    await db.updateTable('work_items').set({ state: 'done' }).execute();
    await turns.enqueue({ agentId: task.assignee_agent_id!, projectId: project.id, kind: 'work', taskId: task.id });
    const claimed = (await turns.claim({ workerId: 'w1', free: { work: 1 }, projects: [project.id] }))!;

    assert.deepEqual((await call(`/api/agents/${task.assignee_agent_id}/stop`, { cookie, body: {} })).json, { interrupted: 1 });
    assert.equal((await db.selectFrom('turns').select('state').where('id', '=', claimed.turnId).executeTakeFirstOrThrow()).state, 'interrupted');
    assert.equal((await db.selectFrom('agents').select('status').where('id', '=', task.assignee_agent_id!).executeTakeFirstOrThrow()).status, 'paused');
    // The worker's next heartbeat is refused, which is what makes it kill the engine; a late report is refused too.
    await assert.rejects(turns.heartbeat(claimed.turnId, 'w1', claimed.leaseToken), /lease/i);
    assert.notEqual((await db.selectFrom('tasks').select('state').where('id', '=', task.id).executeTakeFirstOrThrow()).state, 'quarantined');

    assert.equal((await call(`/api/tasks/${task.id}/stop`, { cookie, body: {} })).status, 200);
    assert.equal((await db.selectFrom('tasks').select('state').where('id', '=', task.id).executeTakeFirstOrThrow()).state, 'stopped');
    assert.equal((await call(`/api/tasks/${task.id}/stop`, { cookie, body: {} })).status, 200, 'stopping twice is harmless');
  } finally { await coordinator.close(); }
});
