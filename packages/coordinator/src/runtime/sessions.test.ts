import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '@agent-team/storage';
import { createContext } from '../context.ts';
import { seedDemo } from '../demo/seed.ts';
import { createSessions, ROTATE_AT_TOKENS } from './sessions.ts';
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
  const turns = createTurns(context), sessions = createSessions(context);
  const claim = (workerId = 'w1') => { clock += 1000; return turns.claim({ workerId, free: { work: 1, bounded: 1, deliver: 1 }, projects: [project.id] }); };
  const work = () => turns.enqueue({ agentId: agent.id, projectId: project.id, kind: 'work', taskId: task.id });
  // What a worker does for a turn: name the engine session at once, then report the outcome.
  const runTurn = async (claimed: NonNullable<Awaited<ReturnType<typeof claim>>>, outcome: Parameters<typeof turns.finish>[3], engineSession: string | null = 'engine-1', workerId = 'w1') => {
    if (engineSession) await storage.transaction(async tx => sessions.record(tx, await turns.leased(tx, claimed.turnId, workerId, claimed.leaseToken), { sessionId: engineSession, baseSha: 'a'.repeat(40) }));
    clock += 1000;
    await turns.finish(claimed.turnId, workerId, claimed.leaseToken, outcome);
  };
  return { storage, db, turns, projectId: project.id, taskId: task.id, agent, claim, work, runTurn, tick: (ms: number) => { clock += ms; }, now: () => clock };
}
const DONE = { state: 'completed', summary: 'Wrote the handler; tests are left.', tokensIn: 1000, tokensOut: 100, contextTokens: 1000 } as const;

test('the next work turn of the same agent and task on the same worker resumes the session with a delta', async () => {
  const { storage, db, claim, work, runTurn, projectId, taskId, agent, now } = await boot();
  try {
    await work();
    const first = (await claim())!;
    assert.equal(first.resume, null);
    assert.deepEqual({ ...await db.selectFrom('turns').select(['context_mode']).where('id', '=', first.turnId).executeTakeFirstOrThrow() }, { context_mode: 'packet' });
    await runTurn(first, DONE);

    // What happened in between is all the resumed session is told.
    await db.insertInto('threads').values({ id: 'th-s', project_id: projectId, kind: 'topic', subject_type: null, subject_id: null, title: 'Notes', visibility: 'team', owner_user_id: null, created_at: now() }).execute();
    await db.insertInto('messages').values({ id: 'm-s', thread_id: 'th-s', author_kind: 'user', author_id: null, kind: 'note', body: `@${agent.name} please keep the old endpoint alive`, payload: '{}', created_at: now() + 1 }).execute();
    await db.insertInto('decisions').values({ id: 'dec-s', project_id: projectId, thread_id: 'th-s', message_id: 'm-s', deliberation_id: null, kind: 'decision', outcome: 'accepted', summary: 'Use the queue, not cron', needs_human: false, resolved_by_user: null, resolved_at: null, created_at: now() + 1 }).execute();
    await db.insertInto('approvals').values({ id: 'ap-s', task_id: taskId, kind: 'reviewer', agent_id: agent.id, turn_id: first.turnId, head_sha: 'b'.repeat(40), verdict: 'changes', findings: JSON.stringify([{ severity: 'major', path: 'src/pay.ts', note: 'Retries are unbounded' }]), summary: 'One problem', state: 'valid', created_at: now() + 1 }).execute();

    // The task itself changed, and a person wrote on it: both must reach a session that is only told what is new.
    await db.updateTable('tasks').set({ brief: 'Also cover the retry path.', updated_at: now() + 5 }).where('id', '=', taskId).execute();
    await db.insertInto('threads').values({ id: 'th-task', project_id: projectId, kind: 'task', subject_type: 'task', subject_id: taskId, title: 'Task thread', visibility: 'team', owner_user_id: null, created_at: now() }).execute();
    await db.insertInto('messages').values({ id: 'm-task', thread_id: 'th-task', author_kind: 'user', author_id: null, kind: 'note', body: 'Billing wants this behind a flag.', payload: '{}', created_at: now() + 6 }).execute();

    await work();
    const second = (await claim())!;
    assert.equal(second.resume?.sessionId, 'engine-1');
    assert.equal(second.resume?.baseSha, 'a'.repeat(40));
    for (const expected of ['Use the queue, not cron', 'Retries are unbounded', 'keep the old endpoint alive', 'task.update', 'Also cover the retry path.', 'Billing wants this behind a flag.']) assert.ok(second.resume!.prompt.includes(expected), expected);
    assert.ok(!second.resume!.prompt.includes('(no brief)'), 'a delta does not repeat the packet');
    // An engine that cannot resume starts from this packet instead, which carries the agent's own summaries.
    assert.ok(second.packet.prompt.includes('Wrote the handler; tests are left.'));
    const rows = await db.selectFrom('agent_sessions').select(['state', 'turn_count', 'context_tokens']).execute();
    assert.deepEqual(rows.map(row => ({ ...row })), [{ state: 'active', turn_count: 1, context_tokens: 1000 }]);
    assert.equal((await db.selectFrom('turns').select('context_mode').where('id', '=', second.turnId).executeTakeFirstOrThrow()).context_mode, 'resume');
  } finally { await storage.close(); }
});

test('bounded turns never get a session', async () => {
  const { storage, db, turns, claim, projectId, agent } = await boot();
  try {
    await turns.enqueue({ agentId: agent.id, projectId, kind: 'reply' });
    const reply = (await claim())!;
    assert.equal(reply.kind, 'reply');
    assert.equal(reply.resume, null);
    assert.equal((await db.selectFrom('agent_sessions').select('id').execute()).length, 0);
  } finally { await storage.close(); }
});

test('sessions rotate at the context threshold, on a model change and on another worker', async () => {
  for (const cause of ['context', 'model', 'worker'] as const) {
    const { storage, db, claim, work, runTurn, agent } = await boot();
    try {
      await work();
      await runTurn((await claim())!, { ...DONE, tokensIn: 900_000, contextTokens: cause === 'context' ? ROTATE_AT_TOKENS : 1000 });
      if (cause === 'model') await db.updateTable('agents').set({ model: 'another-model' }).where('id', '=', agent.id).execute();
      await work();
      const next = (await claim(cause === 'worker' ? 'w2' : 'w1'))!;
      assert.equal(next.resume, null, cause);
      assert.ok(next.packet.prompt.includes('Your earlier session on this task is not available'), cause);
      const rows = await db.selectFrom('agent_sessions').select(['id', 'state', 'rotated_from']).orderBy('created_at').execute();
      assert.deepEqual(rows.map(row => row.state), ['rotated', 'active'], cause);
      assert.equal(rows[1]!.rotated_from, rows[0]!.id, cause);
    } finally { await storage.close(); }
  }
});

test('a resume that finds no session before any output is requeued once, in packet mode', async () => {
  const { storage, db, claim, work, runTurn, taskId } = await boot();
  try {
    await work();
    await runTurn((await claim())!, DONE);
    await work();
    const resumed = (await claim())!;
    assert.ok(resumed.resume);
    await runTurn(resumed, { state: 'failed', stopReason: 'resume-missing' }, null);
    assert.equal((await db.selectFrom('tasks').select('state').where('id', '=', taskId).executeTakeFirstOrThrow()).state, 'in_progress');
    assert.equal((await db.selectFrom('agent_sessions').select('state').orderBy('created_at').executeTakeFirstOrThrow()).state, 'lost');

    const again = (await claim())!;
    assert.equal(again.kind, 'work');
    assert.equal(again.resume, null);
    assert.ok(again.packet.prompt.includes('Wrote the handler; tests are left.'));
    // The requeued turn has no session to miss; if it fails the same way it is an ordinary failure.
    await runTurn(again, { state: 'failed', stopReason: 'resume-missing' }, null);
    assert.equal((await db.selectFrom('tasks').select('state').where('id', '=', taskId).executeTakeFirstOrThrow()).state, 'blocked');
    assert.equal(await claim(), null);
  } finally { await storage.close(); }
});

test('a resume-missing after output is a plain failure', async () => {
  const { storage, db, claim, work, runTurn, taskId } = await boot();
  try {
    await work();
    await runTurn((await claim())!, DONE);
    await work();
    await runTurn((await claim())!, { state: 'failed', stopReason: 'resume-missing', tokensOut: 40 }, null);
    assert.equal((await db.selectFrom('tasks').select('state').where('id', '=', taskId).executeTakeFirstOrThrow()).state, 'blocked');
    assert.equal(await claim(), null);
  } finally { await storage.close(); }
});

test('a work turn without a report gets one continuation, then the task is blocked(no-report)', async () => {
  const { storage, db, claim, work, runTurn, taskId } = await boot();
  try {
    await work();
    await runTurn((await claim())!, { state: 'completed' });
    const continuation = (await claim())!;
    assert.equal(continuation.kind, 'work');
    assert.ok(continuation.resume?.prompt.includes('ended without a report'));
    assert.ok(continuation.packet.prompt.includes('ended without a report'));
    await runTurn(continuation, { state: 'completed' });
    assert.deepEqual({ ...await db.selectFrom('tasks').select(['state', 'blocked_reason']).where('id', '=', taskId).executeTakeFirstOrThrow() }, { state: 'blocked', blocked_reason: 'no-report' });
    assert.equal(await claim(), null);
  } finally { await storage.close(); }
});

test('a continuation is whoever holds the task now: a task reassigned mid-turn is not requeued for the old owner', async () => {
  const { storage, db, claim, work, runTurn, taskId } = await boot();
  try {
    await work();
    const hung = (await claim())!;
    const other = (await db.selectFrom('agents').select('id').where('name', '=', 'Cleo').executeTakeFirstOrThrow()).id;
    await db.updateTable('tasks').set({ assignee_agent_id: other }).where('id', '=', taskId).execute();
    await runTurn(hung, { state: 'timed_out' });
    assert.equal((await db.selectFrom('work_items').select('id').where('task_id', '=', taskId).where('state', '=', 'queued').execute()).length, 0);
  } finally { await storage.close(); }
});

test('a lost bounded turn is never retried', async () => {
  const { storage, db, turns, claim, projectId, agent, tick } = await boot();
  try {
    await turns.enqueue({ agentId: agent.id, projectId, kind: 'reply' });
    const reply = (await claim())!;
    tick(10 * 60_000);
    await turns.sweep();
    assert.equal((await db.selectFrom('turns').select('state').where('id', '=', reply.turnId).executeTakeFirstOrThrow()).state, 'uncertain');
    assert.equal(await claim(), null);
    assert.deepEqual((await db.selectFrom('work_items').select('state').execute()).map(row => row.state), ['expired']);
  } finally { await storage.close(); }
});
