import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { packageRoot } from '@agent-team/protocol';
import { createStorage } from '@agent-team/storage';
import { createContext } from '../context.ts';
import { seedDemo } from '../demo/seed.ts';
import { createVersionedDocs } from '../repos/versionedDocs.ts';
import { buildPacket, journalPart } from './packet.ts';
import { CHECK_IN_EVERY, STALLED_AFTER } from './sessions.ts';
import { createTurns } from './turns.ts';

async function boot() {
  const storage = await createStorage({ kind: 'sqlite', path: ':memory:' });
  await storage.migrate();
  let clock = 1_000_000;
  const context = createContext({ storage, machineToken: 'x'.repeat(24), now: () => clock });
  await seedDemo(context);
  const db = storage.db;
  const project = await db.selectFrom('projects').select('id').where('slug', '=', 'checkout-v2').executeTakeFirstOrThrow();
  const task = await db.selectFrom('tasks').select('id').where('key', '=', 'CK-31').executeTakeFirstOrThrow();
  const agent = await db.selectFrom('agents').select(['id', 'name']).where('name', '=', 'Bram').executeTakeFirstOrThrow();
  await db.updateTable('tasks').set({ state: 'in_progress', assignee_agent_id: agent.id, blocked_reason: null }).where('id', '=', task.id).execute();
  const turns = createTurns(context);
  const claim = (workerId = 'w1') => { clock += 1000; return turns.claim({ workerId, free: { work: 1, bounded: 1, deliver: 1 }, projects: [project.id] }); };
  const queuedWork = () => db.selectFrom('work_items').select(['id', 'dedupe_key']).where('task_id', '=', task.id).where('kind', '=', 'work').where('state', '=', 'queued').execute();
  // A turn as a worker runs it: steps first, then the outcome.
  const run = async (claimed: NonNullable<Awaited<ReturnType<typeof claim>>>, outcome: Parameters<typeof turns.finish>[3], options: { edited?: boolean; workerId?: string } = {}) => {
    if (options.edited) await db.insertInto('trace_steps').values({ turn_id: claimed.turnId, seq: 0, at: clock, kind: 'edit', title: 'Edit src/x.ts', detail: null, status: 'ok', artifact_id: null } as never).execute();
    clock += 60_000;
    await turns.finish(claimed.turnId, options.workerId ?? 'w1', claimed.leaseToken, outcome);
  };
  return { storage, db, context, turns, projectId: project.id, taskId: task.id, agent, claim, run, queuedWork, now: () => clock };
}
const CHECKPOINT = { state: 'completed', summary: 'Part one is in; part two is next.', tokensIn: 1000, tokensOut: 100, contextTokens: 1000 } as const;

test('an owner whose turn ends with the task still in progress is given its next turn at once, not after the PM notices', async () => {
  const { storage, db, turns, projectId, taskId, agent, claim, run, queuedWork, now } = await boot();
  try {
    await turns.enqueue({ agentId: agent.id, projectId, kind: 'work', taskId });
    const first = (await claim())!;
    await run(first, CHECKPOINT, { edited: true });
    const next = await queuedWork();
    assert.equal(next.length, 1);
    assert.match(next[0]!.dedupe_key!, /^carry:/);
    // The gap the scorecard measures: the next turn can be claimed straight away.
    const finishedAt = now();
    const second = (await claim())!;
    assert.equal(second.taskId, taskId);
    const started = await db.selectFrom('turns').select('started_at').where('id', '=', second.turnId).executeTakeFirstOrThrow();
    assert.ok(Number(started.started_at) - finishedAt < 30_000, 'well inside the target for P3');
  } finally { await storage.close(); }
});

test('nothing is queued when the work is not the owner\'s to continue: in review, blocked, held, or someone else\'s task', async () => {
  for (const change of [{ state: 'in_review' }, { blocked_reason: 'waiting for a key' }, { assignee_agent_id: null }] as const) {
    const { storage, db, turns, projectId, taskId, agent, claim, run, queuedWork } = await boot();
    try {
      await turns.enqueue({ agentId: agent.id, projectId, kind: 'work', taskId });
      const first = (await claim())!;
      await db.updateTable('tasks').set(change as never).where('id', '=', taskId).execute();
      await run(first, CHECKPOINT, { edited: true });
      assert.deepEqual(await queuedWork(), [], JSON.stringify(change));
    } finally { await storage.close(); }
  }
});

test('turn after turn that changes nothing stops the carrying on and puts the task in front of the PM, once', async () => {
  const { storage, db, turns, projectId, taskId, agent, claim, run, queuedWork } = await boot();
  try {
    await turns.enqueue({ agentId: agent.id, projectId, kind: 'work', taskId });
    for (let round = 1; round <= STALLED_AFTER; round++) {
      const claimed = (await claim())!;
      assert.equal(claimed.taskId, taskId, `round ${round}`);
      await run(claimed, CHECKPOINT);
    }
    assert.deepEqual(await queuedWork(), [], 'no fourth turn');
    const pm = await db.selectFrom('agents').select('id').where('is_pm', '=', true).executeTakeFirstOrThrow();
    const triage = await db.selectFrom('work_items').select(['agent_id', 'dedupe_key']).where('kind', '=', 'triage').where('state', '=', 'queued').where('dedupe_key', '=', `stalled:${taskId}`).execute();
    assert.deepEqual(triage.map(item => item.agent_id), [pm.id]);
    const note = await db.selectFrom('messages').select('body').where('payload', 'like', `%stalled%`).executeTakeFirstOrThrow();
    assert.match(note.body, /Bram has taken 3 turns in a row on CK-31 .* without changing anything/);
    assert.equal((await db.selectFrom('events').select('seq').where('type', '=', 'task.stalled').execute()).length, 1);
  } finally { await storage.close(); }
});

test('a turn that edits something resets the count', async () => {
  const { storage, turns, projectId, taskId, agent, claim, run, queuedWork } = await boot();
  try {
    await turns.enqueue({ agentId: agent.id, projectId, kind: 'work', taskId });
    for (let round = 1; round <= STALLED_AFTER + 2; round++) await run((await claim())!, CHECKPOINT, { edited: round % 2 === 0 });
    assert.equal((await queuedWork()).length, 1, 'still carrying on');
  } finally { await storage.close(); }
});

test('running out of time continues from the journal once instead of blocking the task; twice in a row is a person\'s to see', async () => {
  const { storage, db, turns, projectId, taskId, agent, claim, run, queuedWork } = await boot();
  try {
    await turns.enqueue({ agentId: agent.id, projectId, kind: 'work', taskId });
    await run((await claim())!, { state: 'timed_out', stopReason: 'timeout' });
    assert.equal((await db.selectFrom('tasks').select(['state', 'blocked_reason']).where('id', '=', taskId).executeTakeFirstOrThrow()).state, 'in_progress');
    assert.match((await queuedWork())[0]!.dedupe_key!, /^carry:timeout:/);
    await run((await claim())!, { state: 'timed_out', stopReason: 'timeout' });
    const task = await db.selectFrom('tasks').select(['state', 'blocked_reason']).where('id', '=', taskId).executeTakeFirstOrThrow();
    assert.deepEqual([task.state, task.blocked_reason], ['blocked', 'The work ran out of time before it reported']);
    assert.deepEqual(await queuedWork(), []);
  } finally { await storage.close(); }
});

test('the journal reads as the owner wrote it, and nothing reads as nothing', () => {
  assert.equal(journalPart(null), null);
  assert.equal(journalPart('not json'), null);
  assert.equal(journalPart(JSON.stringify({ standing: 'Two of five parts are in.', next: 'Part three: reservations.', open: 'Should release() of more than is reserved throw?' })),
    '# Your journal of this task\n- Where it stands: Two of five parts are in.\n- What you said comes next: Part three: reservations.\n- Still open: Should release() of more than is reserved throw?');
});

test('carrying on is not endless: after a dozen turns on one task the PM looks at it before it takes more', async () => {
  const { storage, db, turns, projectId, taskId, agent, claim, run, queuedWork } = await boot();
  try {
    await turns.enqueue({ agentId: agent.id, projectId, kind: 'work', taskId });
    for (let round = 1; round <= CHECK_IN_EVERY; round++) await run((await claim())!, CHECKPOINT, { edited: true });
    assert.deepEqual(await queuedWork(), [], 'no thirteenth turn by itself');
    const note = await db.selectFrom('messages').select('body').where('payload', 'like', `%stalled%`).executeTakeFirstOrThrow();
    assert.match(note.body, /Bram has taken 12 turns on CK-31 .* and says there is more to do/);
  } finally { await storage.close(); }
});

test('what a seat\'s roles look for, and leave to others, is in front of the model in every turn, and so is the expectation to think', async () => {
  const { storage, db, context, agent, projectId, taskId } = await boot();
  try {
    // A coordinator loads the shipped roles when it starts; this test starts none.
    await createVersionedDocs(context).seed('role', { type: 'library', id: '' }, JSON.parse(readFileSync(path.join(packageRoot(), 'blueprints', 'roles.json'), 'utf8')) as Record<string, unknown>);
    const tester = await db.selectFrom('agents').select('id').where('name', '=', 'Cleo').executeTakeFirstOrThrow();
    await db.insertInto('agent_roles').values([{ agent_id: tester.id, role_slug: 'tester' }, { agent_id: agent.id, role_slug: 'developer' }]).execute();
    const asTester = await storage.transaction(tx => buildPacket(tx, { kind: 'review', agentId: tester.id, projectId, taskId, threadId: null }));
    assert.match(asTester.system, /What you look for, which is not what your colleagues look for:\n- As tester: What breaks\./);
    assert.match(asTester.system, /Does not comment on style, naming or design, which are the reviewer's\./);
    assert.match(asTester.system, /You are expected to think, not to comply/);
    const asDeveloper = await storage.transaction(tx => buildPacket(tx, { kind: 'work', agentId: agent.id, projectId, taskId, threadId: null }));
    assert.doesNotMatch(asDeveloper.system, /As tester:/);
    assert.match(asDeveloper.prompt, /if it is wrong, contradicts itself, rests on something that is not true, or asks for what already exists, do not build it/);
  } finally { await storage.close(); }
});
