import test from 'node:test';
import assert from 'node:assert/strict';
import { newId } from '@agent-team/protocol';
import { boot } from '../http/testing.ts';
import { seedDemo } from '../demo/seed.ts';
import { createTurns } from './turns.ts';

test('an unknown outcome reaches the queue and only someone who may decide releases it; nothing is retried on its own', async () => {
  const { coordinator, db, call, owner, person } = await boot();
  try {
    const cookie = await owner();
    await seedDemo(coordinator.context);
    const project = await db.selectFrom('projects').select(['id', 'parent_id']).where('slug', '=', 'checkout-v2').executeTakeFirstOrThrow();
    const task = await db.selectFrom('tasks').select(['id', 'key', 'assignee_agent_id']).where('project_id', '=', project.id).where('assignee_agent_id', 'is not', null).executeTakeFirstOrThrow();
    const member = await person('mia', 'member', { [project.parent_id ?? project.id]: 'member' });

    // A write turn whose lease ran out: the task is quarantined by the expiry sweep.
    const turns = createTurns(coordinator.context);
    await db.updateTable('work_items').set({ state: 'done' }).execute();
    await turns.enqueue({ agentId: task.assignee_agent_id!, projectId: project.id, kind: 'work', taskId: task.id });
    const claimed = await turns.claim({ workerId: 'w1', free: { work: 1 }, projects: [project.id] });
    assert.ok(claimed);
    await db.updateTable('turns').set({ lease_until: 1 }).where('id', '=', claimed!.turnId).execute();
    await turns.sweep();
    assert.equal((await db.selectFrom('tasks').select('state').where('id', '=', task.id).executeTakeFirstOrThrow()).state, 'quarantined');
    assert.equal((await db.selectFrom('work_items').select('id').where('state', '=', 'queued').execute()).length, 0, 'never queued again by itself');

    const queue = (await call('/api/needs-you', { cookie })).json.items as { kind: string; id: string; title: string; detail: string; canDecide: boolean; about: { taskHref: string; taskTitle: string; who: string | null } }[];
    const item = queue.find(entry => entry.kind === 'quarantine')!;
    // The card says what it is about in the task's own words, who was on it, and leads to the task.
    assert.match(item.title, new RegExp(`^${task.key} · `));
    assert.match(item.detail, /was working on it when the worker lost contact/);
    assert.match(item.about.taskHref, /\/tasks\/[0-9a-f-]{36}$/);
    const seen = (await call('/api/needs-you', { cookie: member.cookie })).json.items as { kind: string; canDecide: boolean }[];
    assert.equal(seen.find(entry => entry.kind === 'quarantine')?.canDecide, false);
    assert.equal((await call(`/api/quarantines/${item.id}/release`, { cookie: member.cookie, body: { resolution: 'continue', note: 'looks fine' } })).status, 403);
    // A note is welcome and not demanded: the person's click is the decision.

    assert.equal((await call(`/api/quarantines/${item.id}/release`, { cookie, body: { resolution: 'continue', note: 'Two clean commits on the branch; tests pass.' } })).status, 200);
    assert.equal((await db.selectFrom('tasks').select('state').where('id', '=', task.id).executeTakeFirstOrThrow()).state, 'in_progress');
    assert.equal((await db.selectFrom('work_items').select('id').where('state', '=', 'queued').where('task_id', '=', task.id).execute()).length, 1, 'one fresh turn, asked for by a person');
    assert.equal((await call(`/api/quarantines/${item.id}/release`, { cookie, body: { resolution: 'stop', note: 'again' } })).status, 404);
    const audit = await db.selectFrom('events').select('payload').where('type', '=', 'quarantine.released').executeTakeFirstOrThrow();
    assert.match(audit.payload, /Two clean commits/);

    // A delivery cut off mid-merge freezes the project's queue until a person says which way it went.
    const entry = newId();
    await db.insertInto('merge_queue').values({ id: entry, project_id: project.id, task_id: task.id, head_sha: 'a'.repeat(40), state: 'uncertain', reason: null, created_at: 5, finished_at: null }).execute();
    assert.ok(((await call('/api/needs-you', { cookie })).json.items as { kind: string }[]).some(row => row.kind === 'delivery'));
    assert.equal((await call(`/api/deliveries/${entry}/reconcile`, { cookie, body: { merged: true } })).status, 200);
    assert.deepEqual([(await db.selectFrom('merge_queue').select('state').where('id', '=', entry).executeTakeFirstOrThrow()).state, (await db.selectFrom('tasks').select('state').where('id', '=', task.id).executeTakeFirstOrThrow()).state], ['merged', 'done']);
  } finally { await coordinator.close(); }
});
