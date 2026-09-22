import test from 'node:test';
import assert from 'node:assert/strict';
import { seedDemo } from '../demo/seed.ts';
import { startCoordinator } from '../server.ts';
import { checkInvariants } from './invariants.ts';

test('sound data breaks no rule; each kind of breach is named with the rows that show it', async () => {
  const coordinator = await startCoordinator({ port: 0, storage: { kind: 'sqlite', path: ':memory:' }, machineToken: 'x'.repeat(24), webRoot: null });
  try {
    await seedDemo(coordinator.context, { activity: true });
    const { context } = coordinator, db = context.storage.db, now = context.now();
    // The demo's running turns are illustrations with old leases; they are settled so only what this test adds is judged.
    await db.updateTable('turns').set({ state: 'completed', finished_at: now }).where('state', '=', 'running').execute();
    assert.deepEqual(await checkInvariants(context), []);

    const project = await db.selectFrom('projects').select('id').where('slug', '=', 'checkout-v2').executeTakeFirstOrThrow();
    const agent = await db.selectFrom('agents').select('id').executeTakeFirstOrThrow();
    const task = await db.selectFrom('tasks').select(['id', 'assignee_agent_id']).where('project_id', '=', project.id).where('assignee_agent_id', 'is not', null).executeTakeFirstOrThrow();
    await db.insertInto('workers').values({ id: 'inv-worker', name: 'inv', lanes: '{}', isolation: 'isolated', providers: '[]', projects: '[]', last_seen_at: now }).execute();
    const item = (id: string) => ({ id, agent_id: agent.id, project_id: project.id, kind: 'work', lane: 'work', task_id: task.id, thread_id: null, priority_class: 5, state: 'leased', defer_reason: null, not_before: null, dedupe_key: id, cause_event_id: null, created_at: now });
    const turn = (id: string, state: string, startedAt: number, leaseUntil: number, workItem = `wi-${id}`) => ({ id, work_item_id: workItem, agent_id: agent.id, project_id: project.id, task_id: task.id, kind: 'work', lane: 'work', access: 'write', state, stop_reason: null, worker_id: 'inv-worker', lease_token_hash: 'h', lease_until: leaseUntil, grants: '{}', summary: null, tokens_in: 0, tokens_out: 0, cost_minor: 0, started_at: startedAt, finished_at: null, provider_id: null, model: null, session_id: null, context_mode: 'packet', git_admin: false });

    // Two writers on one task, or two turns of one agent in one lane, cannot even be written: the database refuses them.
    await db.insertInto('work_items').values([item('wi-a'), item('wi-b')] as never).execute();
    await db.insertInto('turns').values(turn('b', 'running', now - 3600_000, now - 3000_000) as never).execute();
    await assert.rejects(db.insertInto('turns').values(turn('a', 'running', now - 1000, now + 60_000) as never).execute(), /unique constraint/i);
    assert.deepEqual((await checkInvariants(context)).map(entry => entry.rule), ['an expired lease is swept']);

    // An uncertain turn whose work item ran again.
    await db.updateTable('turns').set({ state: 'uncertain' }).where('id', '=', 'b').execute();
    await db.insertInto('turns').values(turn('a', 'completed', now - 1000, now + 60_000, 'wi-b') as never).execute();
    assert.deepEqual((await checkInvariants(context)).map(entry => entry.rule), ['an uncertain turn is never retried']);
    await db.updateTable('turns').set({ work_item_id: 'wi-a' }).where('id', '=', 'a').execute();

    // A merge with no approval at that revision, and an author approving their own work.
    await db.insertInto('merge_queue').values({ id: 'mq-x', project_id: project.id, task_id: task.id, head_sha: 'abc123', state: 'merged', reason: null, created_at: now, finished_at: now } as never).execute();
    assert.deepEqual((await checkInvariants(context)).map(entry => entry.rule), ['nothing merges without approval at that revision']);
    await db.insertInto('approvals').values({ id: 'ap-x', task_id: task.id, kind: 'review', agent_id: task.assignee_agent_id, turn_id: 'a', head_sha: 'abc123', verdict: 'pass', findings: '[]', summary: '', state: 'valid', created_at: now } as never).execute();
    assert.deepEqual((await checkInvariants(context)).map(entry => entry.rule), ['an author does not approve their own work']);
  } finally { await coordinator.close(); }
});
