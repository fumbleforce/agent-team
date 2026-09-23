import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '@agent-team/storage';
import { createContext } from '../context.ts';
import { seedDemo } from '../demo/seed.ts';
import { createWorkspace } from '../repos/workspace.ts';
import { createReviews } from './reviews.ts';
import { maxWritersOf } from './scheduler.ts';
import { checkoutRef, createTurns, LEASE_MS } from './turns.ts';

const SHA1 = 'a'.repeat(40), SHA2 = 'b'.repeat(40);

async function seeded() {
  const storage = await createStorage({ kind: 'sqlite', path: ':memory:' });
  await storage.migrate();
  let clock = 1_000_000;
  const context = createContext({ storage, machineToken: 'x'.repeat(24), now: () => clock });
  await seedDemo(context);
  const db = storage.db;
  const project = await db.selectFrom('projects').select(['id', 'manifest']).where('slug', '=', 'checkout-v2').executeTakeFirstOrThrow();
  const agents = await db.selectFrom('agents').select(['id', 'name']).execute();
  const taskOf = async (key: string) => (await db.selectFrom('tasks').select('id').where('key', '=', key).executeTakeFirstOrThrow()).id;
  const turns = createTurns(context);
  return { storage, db, turns, reviews: createReviews(context, turns), projectId: project.id, manifest: JSON.parse(project.manifest) as Record<string, unknown>, taskOf, agent: (name: string) => agents.find(item => item.name === name)!.id, tick: (ms: number) => { clock += ms; } };
}
const worker = (projectId: string, id = 'w1') => ({ workerId: id, free: { work: 4, bounded: 4, deliver: 1 }, projects: [projectId] });
const reasonOf = async (db: Awaited<ReturnType<typeof seeded>>['db'], agentId: string) => (await db.selectFrom('work_items').select('defer_reason').where('agent_id', '=', agentId).where('state', '=', 'queued').executeTakeFirstOrThrow()).defer_reason;

test('one writer per project unless the manifest’s ceiling raises it, and the wait has its own reason', async () => {
  const { storage, db, turns, projectId, manifest, taskOf, agent } = await seeded();
  try {
    await turns.enqueue({ agentId: agent('Bram'), projectId, kind: 'work', taskId: await taskOf('CK-31') });
    await turns.enqueue({ agentId: agent('Ada'), projectId, kind: 'work', taskId: await taskOf('CK-33') });
    await turns.enqueue({ agentId: agent('Cleo'), projectId, kind: 'work', taskId: await taskOf('CK-30') });
    const first = (await turns.claim(worker(projectId)))!;
    assert.equal(first.kind, 'work');
    // Another task, another agent, a free lane: still the same ports, databases and containers.
    assert.equal(await turns.claim(worker(projectId)), null);
    const waiting = await db.selectFrom('work_items').select('defer_reason').where('state', '=', 'queued').where('kind', '=', 'work').execute();
    assert.deepEqual(waiting.map(row => row.defer_reason), ['writers-busy', 'writers-busy']);
    // Turns that write nothing are not held back.
    await turns.enqueue({ agentId: agent('Maren'), projectId, kind: 'reply' });
    assert.equal((await turns.claim(worker(projectId)))?.kind, 'reply');

    await db.updateTable('projects').set({ manifest: JSON.stringify({ ...manifest, ceiling: { ...(manifest.ceiling as object | undefined), maxConcurrentWriters: 2 } }) }).where('id', '=', projectId).execute();
    assert.equal((await turns.claim(worker(projectId)))?.kind, 'work');
    assert.equal(await turns.claim(worker(projectId)), null);
    await turns.finish(first.turnId, 'w1', first.leaseToken, { state: 'completed' });
    assert.equal((await turns.claim(worker(projectId)))?.kind, 'work');
  } finally { await storage.close(); }
});

test('the writer limit is read from the ceiling only, as a whole number, and capped', () => {
  assert.equal(maxWritersOf({}), 1);
  assert.equal(maxWritersOf(null), 1);
  assert.equal(maxWritersOf({ maxConcurrentWriters: 5 }), 1);
  assert.equal(maxWritersOf({ ceiling: { maxConcurrentWriters: 3 } }), 3);
  for (const bad of [0, -1, 1.5, '4', null]) assert.equal(maxWritersOf({ ceiling: { maxConcurrentWriters: bad } }), 1);
  assert.equal(maxWritersOf({ ceiling: { maxConcurrentWriters: 1000 } }), 16);
});

test('the database itself refuses a second running delivery in a project and a second running turn in a session', async () => {
  const { storage, db, turns, projectId, agent } = await seeded();
  try {
    await turns.enqueue({ agentId: agent('Bram'), projectId, kind: 'reply' });
    const claimed = (await turns.claim(worker(projectId)))!;
    const template = await db.selectFrom('turns').selectAll().where('id', '=', claimed.turnId).executeTakeFirstOrThrow();
    const row = (id: string, agentId: string, extra: Partial<typeof template>) => ({ ...template, id, agent_id: agentId, task_id: null, git_admin: null, ...extra });
    await db.insertInto('turns').values(row('d1', agent('Ada'), { kind: 'deliver', lane: 'deliver', access: 'write' })).execute();
    await assert.rejects(db.insertInto('turns').values(row('d2', agent('Cleo'), { kind: 'deliver', lane: 'deliver', access: 'write' })).execute());
    // A delivery that is over does not count.
    await db.insertInto('turns').values(row('d3', agent('Cleo'), { kind: 'deliver', lane: 'deliver', access: 'write', state: 'completed' })).execute();

    await db.insertInto('turns').values(row('s1', agent('Ada'), { session_id: 'session-1' })).execute();
    await assert.rejects(db.insertInto('turns').values(row('s2', agent('Finn'), { session_id: 'session-1' })).execute());
    await db.insertInto('turns').values(row('s3', agent('Finn'), { session_id: 'session-2' })).execute();
    // Turns without a session are as many as the other rules allow.
    await db.insertInto('turns').values(row('s4', agent('Maren'), { session_id: null })).execute();
  } finally { await storage.close(); }
});

test('a lease lost during a git-admin operation quarantines that worker’s checkout, and only a lost one', async () => {
  const { storage, db, turns, projectId, taskOf, agent, tick } = await seeded();
  try {
    await turns.enqueue({ agentId: agent('Bram'), projectId, kind: 'work', taskId: await taskOf('CK-31') });
    const first = (await turns.claim(worker(projectId)))!;
    await assert.rejects(turns.gitAdmin(first.turnId, 'w2', first.leaseToken, 'begin'), /Lease/);
    // Announced and finished: the lease lost afterwards says nothing about the checkout.
    await turns.gitAdmin(first.turnId, 'w1', first.leaseToken, 'begin');
    await turns.gitAdmin(first.turnId, 'w1', first.leaseToken, 'end');
    tick(LEASE_MS + 1);
    await turns.sweep();
    assert.deepEqual((await db.selectFrom('quarantines').select('scope').execute()).map(row => row.scope), ['task']);

    await turns.enqueue({ agentId: agent('Ada'), projectId, kind: 'work', taskId: await taskOf('CK-33') });
    const second = (await turns.claim(worker(projectId)))!;
    await turns.gitAdmin(second.turnId, 'w1', second.leaseToken, 'begin');
    tick(LEASE_MS + 1);
    await turns.sweep();
    const quarantine = await db.selectFrom('quarantines').select(['scope', 'ref_id', 'turn_id']).where('scope', '=', 'checkout').executeTakeFirstOrThrow();
    assert.deepEqual({ ...quarantine }, { scope: 'checkout', ref_id: checkoutRef('w1', projectId), turn_id: second.turnId });
    assert.equal((await db.selectFrom('turns').select('state').where('id', '=', second.turnId).executeTakeFirstOrThrow()).state, 'uncertain');

    // That worker gets nothing that needs the repository; another worker, with its own checkout, does.
    await turns.enqueue({ agentId: agent('Cleo'), projectId, kind: 'reply' });
    assert.equal(await turns.claim(worker(projectId, 'w1')), null);
    assert.equal(await reasonOf(db, agent('Cleo')), 'checkout-quarantined');
    assert.equal((await turns.claim(worker(projectId, 'w2')))?.kind, 'reply');
  } finally { await storage.close(); }
});

async function reviewing() {
  const storage = await createStorage({ kind: 'sqlite', path: ':memory:' });
  await storage.migrate();
  let clock = 1_000_000;
  const context = createContext({ storage, machineToken: 'x'.repeat(24), now: () => clock });
  const db = storage.db;
  const projectId = await createWorkspace(context).registerProject({ slug: 'shop', name: 'Shop', kind: 'repo', manifest: {} });
  const agents = Object.fromEntries((await db.selectFrom('agents').select(['id', 'name']).execute()).map(agent => [agent.name, agent.id])) as Record<string, string>;
  const taskId = 'task-1';
  await db.insertInto('tasks').values({ id: taskId, project_id: projectId, key: 'GH-1', source: 'tracker', title: 'T', brief: '', tag: null, priority: 0, milestone_id: null, state: 'in_progress', assignee_agent_id: agents.Ada!, author_agent_id: null, branch: null, head_sha: null, pr_url: null, blocked_reason: null, created_at: 1, updated_at: 1 }).execute();
  const turns = createTurns(context), reviews = createReviews(context, turns);
  const turn = (name: string) => ({ id: `turn-${name}`, agent_id: agents[name]!, task_id: taskId, kind: 'review' });
  const pass = (headSha = SHA1) => ({ verdict: 'pass' as const, headSha, summary: 'ok', findings: [] });
  const stateOf = async (name: string) => (await db.selectFrom('approvals').select('state').where('turn_id', '=', `turn-${name}`).orderBy('created_at', 'desc').executeTakeFirst())?.state;
  return { storage, db, turns, reviews, agents, projectId, taskId, turn, pass, stateOf, tick: (ms: number) => { clock += ms; } };
}

test('a verdict from a worker’s turn counts only once the worker reports the head it verified, and that head is the task’s', async () => {
  const { storage, db, reviews, agents, taskId, turn, pass, stateOf } = await reviewing();
  try {
    await reviews.request(taskId, SHA1);
    assert.deepEqual(await reviews.record(turn('Rune'), pass(), { verification: 'worker' }), { approved: false });
    assert.equal(await stateOf('Rune'), 'pending-verification');
    // Nothing pending is counted: the task is not approved and the merge gate sees no approval.
    assert.equal((await db.selectFrom('tasks').select('state').where('id', '=', taskId).executeTakeFirstOrThrow()).state, 'in_review');
    assert.deepEqual(await reviews.approvalsFor(taskId, SHA1), {});

    // Another head at the start, a head that moved under the reviewer, and no report at all: each is stale, none is valid.
    await reviews.verify('turn-Rune', { start: SHA2, end: SHA2 });
    assert.equal(await stateOf('Rune'), 'stale');
    await reviews.record(turn('Rune'), pass(), { verification: 'worker' });
    await reviews.verify('turn-Rune', { start: SHA1, end: SHA2 });
    assert.equal(await stateOf('Rune'), 'stale');
    await reviews.record(turn('Rune'), pass(), { verification: 'worker' });
    await reviews.verify('turn-Rune', {});
    assert.equal(await stateOf('Rune'), 'stale');
    assert.equal((await db.selectFrom('merge_queue').select('id').execute()).length, 0);

    // The verification is what approves the task and queues the one merge, under the PM.
    await reviews.record(turn('Rune'), pass(), { verification: 'worker' });
    assert.deepEqual(await reviews.verify('turn-Rune', { start: SHA1, end: SHA1 }), { approved: true });
    assert.equal((await db.selectFrom('tasks').select('state').where('id', '=', taskId).executeTakeFirstOrThrow()).state, 'approved');
    assert.deepEqual((await db.selectFrom('merge_queue').select(['state', 'head_sha']).execute()).map(row => [row.state, row.head_sha]), [['queued', SHA1]]);
    assert.deepEqual((await db.selectFrom('work_items').select('agent_id').where('kind', '=', 'deliver').execute()).map(item => item.agent_id), [agents.Maren]);
    assert.deepEqual(Object.keys(await reviews.approvalsFor(taskId, SHA1)), ['reviewer']);
    // Verifying again changes nothing.
    assert.deepEqual(await reviews.verify('turn-Rune', { start: SHA1, end: SHA1 }), { approved: false });
    assert.equal((await db.selectFrom('merge_queue').select('id').execute()).length, 1);
  } finally { await storage.close(); }
});

test('a head that moves makes a waiting verdict stale, and a verification that arrives afterwards cannot revive it', async () => {
  const { storage, db, reviews, taskId, turn, pass, stateOf } = await reviewing();
  try {
    await reviews.request(taskId, SHA1);
    await reviews.record(turn('Rune'), pass(), { verification: 'worker' });
    await reviews.request(taskId, SHA2);
    assert.equal(await stateOf('Rune'), 'stale');
    await reviews.verify('turn-Rune', { start: SHA1, end: SHA1 });
    assert.equal(await stateOf('Rune'), 'stale');

    // Verified at the old head while the task is already at the new one: stale, even though the worker saw a consistent tree.
    await db.updateTable('approvals').set({ state: 'pending-verification' }).where('turn_id', '=', 'turn-Rune').execute();
    await reviews.verify('turn-Rune', { start: SHA1, end: SHA1 });
    assert.equal(await stateOf('Rune'), 'stale');
    assert.equal((await db.selectFrom('tasks').select('state').where('id', '=', taskId).executeTakeFirstOrThrow()).state, 'in_review');
  } finally { await storage.close(); }
});

test('a review turn that is lost never turns its verdict into an approval, and the claim names the head and the reviewer kind', async () => {
  const { storage, db, turns, reviews, projectId, taskId, agents, pass, tick } = await reviewing();
  try {
    await reviews.request(taskId, SHA1);
    const claimed = [];
    for (let next = await turns.claim(worker(projectId)); next; next = await turns.claim(worker(projectId))) claimed.push(next);
    assert.deepEqual(claimed.map(turn => [turn.kind, turn.agentId]), [['review', agents.Rune]]);
    const mine = claimed[0]!;
    assert.deepEqual(mine.review, { headSha: SHA1, reviewer: 'reviewer' });
    await reviews.record({ id: mine.turnId, agent_id: mine.agentId, task_id: taskId, kind: 'review' }, pass(), { verification: 'worker' });
    tick(LEASE_MS + 1);
    await turns.sweep();
    assert.equal((await db.selectFrom('approvals').select('state').where('turn_id', '=', mine.turnId).executeTakeFirstOrThrow()).state, 'stale');
    // A read turn: nothing it could have written, so no task quarantine.
    assert.equal((await db.selectFrom('quarantines').select('id').execute()).length, 0);
  } finally { await storage.close(); }
});
