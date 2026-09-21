import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createStorage } from '@agent-team/storage';
import { createContext } from '../context.ts';
import { seedDemo } from '../demo/seed.ts';
import { createTraceStore } from './traceStore.ts';
import { createTurns } from './turns.ts';

const DAY = 24 * 3600 * 1000;

async function boot(options: { traceRetentionDays?: number } = {}) {
  const storage = await createStorage({ kind: 'sqlite', path: ':memory:' });
  await storage.migrate();
  let clock = 1_000_000;
  const context = createContext({ storage, machineToken: 'x'.repeat(24), now: () => clock, ...options });
  await seedDemo(context);
  const db = storage.db;
  const project = await db.selectFrom('projects').select('id').where('slug', '=', 'checkout-v2').executeTakeFirstOrThrow();
  const agent = await db.selectFrom('agents').select('id').where('name', '=', 'Bram').executeTakeFirstOrThrow();
  const tasks = await db.selectFrom('tasks').select('id').where('project_id', '=', project.id).limit(2).execute();
  const turns = createTurns(context), traceStore = createTraceStore(context);
  // One finished work turn for a task, with a step, a small artifact in its row and a large one in the store.
  const traced = async (taskId: string) => {
    await turns.enqueue({ agentId: agent.id, projectId: project.id, kind: 'work', taskId });
    clock += 1000;
    const claimed = (await turns.claim({ workerId: 'w1', free: { work: 1, bounded: 0, deliver: 0 }, projects: [project.id] }))!;
    await turns.steps(claimed.turnId, 'w1', claimed.leaseToken, [{ seq: 0, kind: 'run', title: 'npm test', status: 'ok' }, { seq: 1, kind: 'run', title: 'npm run build', status: 'ok' }]);
    const leased = (tx: Parameters<typeof turns.leased>[0]) => turns.leased(tx, claimed.turnId, 'w1', claimed.leaseToken);
    await traceStore.put(leased, claimed.turnId, { seq: 0, kind: 'output', bytes: new TextEncoder().encode('12 passed'), mime: 'text/plain', truncated: false });
    await traceStore.put(leased, claimed.turnId, { seq: 1, kind: 'output', bytes: new Uint8Array(40_000).fill(97), mime: 'text/plain', truncated: false });
    clock += 1000;
    await turns.finish(claimed.turnId, 'w1', claimed.leaseToken, { state: 'completed', summary: 'Done.', tokensIn: 10, tokensOut: 5, costMinor: 3 });
    // This test is about one turn per task; the turn its owner would carry on with is not wanted here.
    await db.updateTable('work_items').set({ state: 'done' }).where('task_id', '=', taskId).where('state', '=', 'queued').execute();
    const key = (await db.selectFrom('step_artifacts').select('storage_key').where('turn_id', '=', claimed.turnId).where('seq', '=', 1).executeTakeFirstOrThrow()).storage_key!;
    return { turnId: claimed.turnId, file: path.join(context.dataDir, 'artifacts', ...key.split('/')) };
  };
  const end = async (taskId: string) => { await db.updateTable('tasks').set({ state: 'done', updated_at: clock }).where('id', '=', taskId).execute(); };
  const counts = async (turnId: string) => [(await db.selectFrom('trace_steps').select('seq').where('turn_id', '=', turnId).execute()).length, (await db.selectFrom('step_artifacts').select('seq').where('turn_id', '=', turnId).execute()).length];
  return { storage, db, context, traceStore, traced, end, counts, tasks, tick: (ms: number) => { clock += ms; } };
}

test('small text stays in its row, large text goes to the store, and both read back the same way', async () => {
  const { storage, db, traceStore, traced, tasks } = await boot();
  try {
    const { turnId, file } = await traced(tasks[0]!.id);
    const rows = await db.selectFrom('step_artifacts').select(['seq', 'body', 'bytes', 'storage_key']).where('turn_id', '=', turnId).orderBy('seq').execute();
    assert.deepEqual(rows.map(row => [row.seq, row.body, Number(row.bytes), row.storage_key !== null]), [[0, '12 passed', 9, false], [1, '', 40_000, true]]);
    assert.ok(existsSync(file));
    assert.equal(new TextDecoder().decode((await traceStore.read(turnId, 0))!.data), '12 passed');
    assert.equal((await traceStore.read(turnId, 1))!.data.length, 40_000);
    assert.equal(await traceStore.read(turnId, 2), null);
  } finally { await storage.close(); }
});

test('retention: a trace and its stored artifacts go 30 days after the task is terminal, and nothing else does', async () => {
  const { storage, db, traceStore, traced, end, counts, tasks, tick } = await boot();
  try {
    const finished = await traced(tasks[0]!.id), open = await traced(tasks[1]!.id);
    const kept = async () => ({ events: (await db.selectFrom('events').select('seq').where('category', 'in', ['domain', 'audit']).execute()).length, turns: (await db.selectFrom('turns').select('id').execute()).length, costs: (await db.selectFrom('cost_entries').select('id').execute()).length });
    const before = await kept();

    // A task that is still open keeps its trace however old it is.
    tick(90 * DAY);
    assert.deepEqual(await traceStore.sweep(), { turns: 0, steps: 0, artifacts: 0 });

    await end(tasks[0]!.id);
    tick(30 * DAY - 1000);
    assert.deepEqual(await traceStore.sweep(), { turns: 0, steps: 0, artifacts: 0 }, 'a day short of the period nothing goes');
    assert.deepEqual(await counts(finished.turnId), [2, 2]);

    tick(2000);
    assert.deepEqual(await traceStore.sweep(), { turns: 1, steps: 2, artifacts: 2 });
    assert.deepEqual(await counts(finished.turnId), [0, 0]);
    assert.ok(!existsSync(finished.file), 'the stored body went with its row');
    assert.deepEqual(await counts(open.turnId), [2, 2]);
    assert.ok(existsSync(open.file));
    assert.deepEqual(await kept(), before, 'domain and audit events, turns and costs are never removed');
    assert.ok(before.events > 0 && before.turns === 2);
    assert.deepEqual(await traceStore.sweep(), { turns: 0, steps: 0, artifacts: 0 }, 'a second sweep finds nothing');
  } finally { await storage.close(); }
});

test('retention: the period is configurable', async () => {
  const { storage, traceStore, traced, end, counts, tasks, tick } = await boot({ traceRetentionDays: 2 });
  try {
    const { turnId } = await traced(tasks[0]!.id);
    await end(tasks[0]!.id);
    tick(DAY);
    assert.equal((await traceStore.sweep()).turns, 0);
    tick(DAY + 1000);
    assert.equal((await traceStore.sweep()).turns, 1);
    assert.deepEqual(await counts(turnId), [0, 0]);
  } finally { await storage.close(); }
});
