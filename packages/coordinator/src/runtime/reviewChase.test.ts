import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publishTarget } from '../../../../adapters/hosting/local/up.ts';
import { seedDemo } from '../demo/seed.ts';
import { startCoordinator } from '../server.ts';
import { createReviews } from './reviews.ts';
import { createTurns } from './turns.ts';

const SHA = 'a'.repeat(40);

test('a task does not sit in review because a review was lost: whoever still owes a verdict is asked again, and a queued merge nobody is about to run is started', async () => {
  const coordinator = await startCoordinator({ port: 0, storage: { kind: 'sqlite', path: ':memory:' }, machineToken: 'x'.repeat(24), webRoot: null });
  try {
    await seedDemo(coordinator.context);
    const db = coordinator.context.storage.db, turns = createTurns(coordinator.context), reviews = createReviews(coordinator.context, turns);
    const task = await db.selectFrom('tasks').select(['id', 'project_id']).where('key', '=', 'CK-31').executeTakeFirstOrThrow();
    // Three teammates who may give a verdict; none of them wrote the change.
    const names = Object.fromEntries((await db.selectFrom('agents').select(['id', 'name']).execute()).map(row => [row.name, row.id])) as Record<string, string>;
    for (const [name, role] of [['Maren', 'pm'], ['Cleo', 'tester'], ['Ada', 'reviewer']] as const) await db.insertInto('agent_roles').values({ agent_id: names[name]!, role_slug: role }).onConflict(oc => oc.doNothing()).execute();
    const asked = await reviews.request(task.id, SHA);
    assert.ok(asked.length >= 2, 'several kinds of review are asked for');
    const live = async () => (await db.selectFrom('work_items').select(['agent_id', 'kind']).where('task_id', '=', task.id).where('state', 'in', ['queued', 'leased']).execute()).map(item => `${item.kind}:${item.agent_id}`).sort();
    const all = await live();
    // Nothing is missing, so nothing is asked twice.
    assert.deepEqual(await reviews.chase(), { reviews: 0, merges: 0 });

    // One review is lost, as when a worker is restarted under it and its lease runs out.
    const lost = asked[0]!;
    await db.updateTable('work_items').set({ state: 'expired' }).where('task_id', '=', task.id).where('agent_id', '=', lost.agentId).execute();
    assert.equal((await live()).length, all.length - 1);
    assert.deepEqual(await reviews.chase(), { reviews: 1, merges: 0 });
    assert.deepEqual(await live(), all);
    assert.deepEqual(await reviews.chase(), { reviews: 0, merges: 0 }, 'one waiting review is enough');

    // Approved with its merge queued and nobody about to run it (after "it was not merged: try again", say): the merge is started.
    await db.updateTable('work_items').set({ state: 'done' }).where('task_id', '=', task.id).execute();
    await db.updateTable('tasks').set({ state: 'approved' }).where('id', '=', task.id).execute();
    await db.insertInto('merge_queue').values({ id: 'queued-again', project_id: task.project_id, task_id: task.id, head_sha: SHA, state: 'queued', reason: null, created_at: 1, finished_at: null }).execute();
    assert.deepEqual(await reviews.chase(), { reviews: 0, merges: 1 });
    assert.deepEqual((await live()).map(item => item.split(':')[0]), ['deliver']);
  } finally { await coordinator.close(); }
});

test('a worker on this machine publishes only where the project\'s own manifest authorizes it', () => {
  const checkout = mkdtempSync(path.join(os.tmpdir(), 'checkout-'));
  assert.equal(publishTarget(checkout), null);
  const manifest = { scm: { kind: 'github' }, delivery: { repository: 'acme/shop', baseBranch: 'trunk' } };
  writeFileSync(path.join(checkout, '.agent-team.json'), JSON.stringify(manifest));
  assert.equal(publishTarget(checkout), null, 'a repository alone authorizes nothing');
  writeFileSync(path.join(checkout, '.agent-team.json'), JSON.stringify({ ...manifest, delivery: { ...manifest.delivery, publishAuthorized: true } }));
  assert.deepEqual(publishTarget(checkout), { scm: 'github', repository: 'acme/shop', base: 'trunk' });
});

test('a merge that was cut off does not freeze the project or wait for a person: it is queued to run again, and whatever set the task aside for it is lifted', async () => {
  const coordinator = await startCoordinator({ port: 0, storage: { kind: 'sqlite', path: ':memory:' }, machineToken: 'x'.repeat(24), webRoot: null });
  try {
    await seedDemo(coordinator.context);
    const db = coordinator.context.storage.db, turns = createTurns(coordinator.context), reviews = createReviews(coordinator.context, turns);
    const names = Object.fromEntries((await db.selectFrom('agents').select(['id', 'name']).execute()).map(row => [row.name, row.id])) as Record<string, string>;
    for (const [name, role] of [['Maren', 'pm'], ['Cleo', 'tester'], ['Ada', 'reviewer']] as const) await db.insertInto('agent_roles').values({ agent_id: names[name]!, role_slug: role }).onConflict(oc => oc.doNothing()).execute();
    const task = await db.selectFrom('tasks').select(['id', 'project_id']).where('key', '=', 'CK-31').executeTakeFirstOrThrow();
    // As an earlier version left it: the task set aside, its merge entry unknown, and two more approved tasks waiting behind it.
    await db.updateTable('tasks').set({ state: 'quarantined', head_sha: SHA }).where('id', '=', task.id).execute();
    await db.insertInto('merge_queue').values({ id: 'cut-off', project_id: task.project_id, task_id: task.id, head_sha: SHA, state: 'uncertain', reason: 'Lease expired during delivery', created_at: 1, finished_at: 2 }).execute();

    assert.deepEqual(await reviews.chase(), { reviews: 0, merges: 1 });
    assert.deepEqual([(await db.selectFrom('tasks').select('state').where('id', '=', task.id).executeTakeFirstOrThrow()).state, (await db.selectFrom('merge_queue').select('state').where('id', '=', 'cut-off').executeTakeFirstOrThrow()).state], ['approved', 'queued']);
    assert.equal((await db.selectFrom('merge_queue').select('id').where('state', '=', 'uncertain').execute()).length, 0, 'nothing freezes the project any more');
    assert.deepEqual((await db.selectFrom('work_items').select('kind').where('task_id', '=', task.id).where('state', '=', 'queued').execute()).map(item => item.kind), ['deliver']);
  } finally { await coordinator.close(); }
});

test('a task that an earlier version queued for merging more than once is merged once: claiming its delivery does not fail, and the extra entries are closed', async () => {
  const coordinator = await startCoordinator({ port: 0, storage: { kind: 'sqlite', path: ':memory:' }, machineToken: 'x'.repeat(24), webRoot: null });
  try {
    await seedDemo(coordinator.context);
    const db = coordinator.context.storage.db, turns = createTurns(coordinator.context), reviews = createReviews(coordinator.context, turns);
    const names = Object.fromEntries((await db.selectFrom('agents').select(['id', 'name']).execute()).map(row => [row.name, row.id])) as Record<string, string>;
    const task = await db.selectFrom('tasks').select(['id', 'project_id']).where('key', '=', 'CK-31').executeTakeFirstOrThrow();
    await db.updateTable('tasks').set({ state: 'approved', head_sha: SHA }).where('id', '=', task.id).execute();
    for (const [index, id] of ['first', 'second', 'third'].entries()) await db.insertInto('merge_queue').values({ id, project_id: task.project_id, task_id: task.id, head_sha: SHA, state: 'queued', reason: null, created_at: index + 1, finished_at: null }).execute();

    // Straight to a claim, as when the worker asks before anything tidied up: one entry runs, the others are closed, and the claim succeeds.
    await turns.enqueue({ agentId: names.Maren!, projectId: task.project_id, kind: 'deliver', taskId: task.id, dedupeKey: `deliver:${task.id}:${SHA}` });
    const claimed = await turns.claim({ workerId: 'w1', free: { work: 0, bounded: 0, deliver: 1 }, projects: [task.project_id] });
    assert.equal(claimed?.kind, 'deliver');
    assert.deepEqual((await db.selectFrom('merge_queue').select(['id', 'state']).where('task_id', '=', task.id).orderBy('created_at').execute()).map(row => [row.id, row.state]), [['first', 'blocked'], ['second', 'blocked'], ['third', 'running']]);

    // And the tidy-up alone does the same for entries nobody has claimed yet.
    const other = await db.selectFrom('tasks').select(['id', 'project_id']).where('key', '=', 'CK-32').executeTakeFirstOrThrow();
    for (const [index, id] of ['a', 'b'].entries()) await db.insertInto('merge_queue').values({ id, project_id: other.project_id, task_id: other.id, head_sha: SHA, state: 'queued', reason: null, created_at: index + 1, finished_at: null }).execute();
    await reviews.chase();
    assert.deepEqual((await db.selectFrom('merge_queue').select(['id', 'state']).where('task_id', '=', other.id).orderBy('created_at').execute()).map(row => [row.id, row.state]), [['a', 'blocked'], ['b', 'queued']]);
  } finally { await coordinator.close(); }
});
