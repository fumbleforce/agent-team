import test from 'node:test';
import assert from 'node:assert/strict';
import { seedDemo } from '../demo/seed.ts';
import { startCoordinator } from '../server.ts';
import { createTurns } from './turns.ts';
import { createWorkload } from './workload.ts';

test('work piling up behind one teammate reaches the PM without anyone saying so, once an hour, with who is free; the feed is one stream of what everyone does', async () => {
  const coordinator = await startCoordinator({ port: 0, storage: { kind: 'sqlite', path: ':memory:' }, machineToken: 'x'.repeat(24), webRoot: null });
  try {
    await seedDemo(coordinator.context, { activity: true });
    const db = coordinator.context.storage.db, turns = createTurns(coordinator.context), workload = createWorkload(coordinator.context, turns);
    const names = Object.fromEntries((await db.selectFrom('agents').select(['id', 'name']).execute()).map(row => [row.name, row.id])) as Record<string, string>;
    const project = await db.selectFrom('projects').select('id').where('slug', '=', 'checkout-v2').executeTakeFirstOrThrow();
    const tasks = await db.selectFrom('tasks').select(['id', 'key']).where('project_id', '=', project.id).where('key', 'in', ['CK-31', 'CK-32']).execute();
    await db.updateTable('work_items').set({ state: 'done' }).execute();
    assert.equal(await workload.nudge(), 0, 'nothing waits, nothing is said');

    // Two tasks have waited a quarter of an hour behind Bram's other work.
    for (const task of tasks) await db.insertInto('work_items').values({ id: `w-${task.key}`, agent_id: names.Bram!, project_id: project.id, kind: 'work', lane: 'work', task_id: task.id, thread_id: null, priority_class: 5, state: 'queued', defer_reason: 'lane-busy', not_before: null, dedupe_key: `work:${task.id}`, cause_event_id: null, created_at: Date.now() - 15 * 60_000 }).execute();
    assert.equal(await workload.nudge(), 1);
    const note = await db.selectFrom('messages').select('body').where('kind', '=', 'system').where('payload', 'like', '%workload%').executeTakeFirstOrThrow();
    assert.match(note.body, /Bram has 2 tasks waiting behind the one in hand \(CK-3[12], CK-3[12]\)/);
    assert.match(note.body, /With no work in hand: [^.]*Ada/);
    assert.match(note.body, /task\.assign[\s\S]*proposal\.create/);
    assert.deepEqual((await db.selectFrom('work_items').select(['agent_id', 'kind']).where('kind', '=', 'triage').where('state', '=', 'queued').execute()).map(item => [item.agent_id, item.kind]), [[names.Maren, 'triage']]);
    assert.equal(await workload.nudge(), 0, 'not said again within the hour');

    const feed = await workload.feed(project.id);
    assert.ok(feed.items.length > 0 && feed.items.every((item, index) => index === 0 || feed.items[index - 1]!.at >= item.at), 'newest first');
    assert.ok(feed.items.some(item => item.kind === 'finished' && item.task?.key === 'CK-27' && /v2 payload/.test(item.text)));
  } finally { await coordinator.close(); }
});
