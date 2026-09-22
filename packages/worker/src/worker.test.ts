import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTurns, seedDemo, startCoordinator } from '@agent-team/coordinator';
import { fake } from '../../../adapters/engine/fake.ts';
import { createWorker, finishSummary } from './worker.ts';

const TOKEN = 'machine-token-for-tests-0123456789';

async function boot(scenario: string) {
  const coordinator = await startCoordinator({ port: 0, storage: { kind: 'sqlite', path: ':memory:' }, machineToken: TOKEN, webRoot: null });
  await seedDemo(coordinator.context);
  const db = coordinator.context.storage.db;
  const project = await db.selectFrom('projects').select('id').where('slug', '=', 'checkout-v2').executeTakeFirstOrThrow();
  const task = await db.selectFrom('tasks').select('id').where('key', '=', 'CK-31').executeTakeFirstOrThrow();
  const agent = await db.selectFrom('agents').select('id').where('name', '=', 'Bram').executeTakeFirstOrThrow();
  await createTurns(coordinator.context).enqueue({ agentId: agent.id, projectId: project.id, kind: 'work', taskId: task.id });
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'agent-team-worker-'));
  const worker = createWorker({ coordinatorUrl: coordinator.url, token: TOKEN, workerId: 'w1', stateDir, lanes: { work: 1, bounded: 1, deliver: 1 }, projects: { [project.id]: stateDir }, engine: fake, env: { ...process.env, FAKE_SCENARIO: scenario }, timeoutMs: 1500 });
  return { coordinator, db, worker, taskId: task.id, agentId: agent.id };
}

test('a turn runs through the engine: steps are traced, usage recorded, the agent is idle again', async () => {
  const { coordinator, db, worker, agentId } = await boot('ok');
  assert.equal(await worker.tick(), true);
  await worker.idle();
  const turn = await db.selectFrom('turns').selectAll().orderBy('started_at').executeTakeFirstOrThrow();
  assert.equal(turn.state, 'completed');
  assert.equal(turn.summary, 'Implemented and tested.');
  assert.equal(turn.cost_minor, 2);
  const steps = await db.selectFrom('trace_steps').select(['kind']).orderBy('seq').execute();
  assert.deepEqual(steps.map(step => step.kind), ['think', 'read', 'edit', 'run']);
  assert.equal((await db.selectFrom('agents').select('doing').where('id', '=', agentId).executeTakeFirstOrThrow()).doing, null);
  // The task is still in progress and nothing blocks it, so its owner's next turn is there to be claimed at once.
  assert.equal(await worker.tick(), true);
  await worker.idle();
  assert.equal((await db.selectFrom('turns').select('id').execute()).length, 2);
  await coordinator.close();
});

// A turn that ran out of time is a known state: the task stays with its owner, who carries on from the journal.
test('a usage limit defers the turn, a crash blocks the task, a hang times out and the owner carries on', async () => {
  for (const [scenario, state, taskState] of [['limit', 'deferred', 'in_progress'], ['crash', 'failed', 'blocked'], ['hang', 'timed_out', 'in_progress']] as const) {
    const { coordinator, db, worker, taskId } = await boot(scenario);
    await worker.tick();
    await worker.idle();
    assert.equal((await db.selectFrom('turns').select('state').executeTakeFirstOrThrow()).state, state, scenario);
    assert.equal((await db.selectFrom('tasks').select('state').where('id', '=', taskId).executeTakeFirstOrThrow()).state, taskState, scenario);
    await coordinator.close();
  }
});

// Redaction can grow a short secret into its mark, so whatever reaches the finish body is capped on the final text: a failure keeps its tail, a completion its headline.
test('the summary a turn finishes with fits the coordinator\'s cap, whatever redaction did to it', () => {
  assert.equal(finishSummary('r'.repeat(2100), 'completed')!.length, 2000);
  const failed = `${'e'.repeat(2100)}stderr tail`;
  const kept = finishSummary(failed, 'failed');
  assert.equal(kept!.length, 2000);
  assert.ok(kept!.endsWith('stderr tail'), 'the diagnosis lives at the end of a failure');
  assert.equal(finishSummary(null, 'failed'), null);
  assert.equal(finishSummary('short', 'deferred'), 'short');
});

// Rows come back without a prototype; a copy compares as a plain object.
const plain = async <T extends object>(row: Promise<T>): Promise<T> => ({ ...await row });

async function bootCapture(capture: NonNullable<Parameters<typeof createWorker>[0]['capture']>) {
  const coordinator = await startCoordinator({ port: 0, storage: { kind: 'sqlite', path: ':memory:' }, machineToken: TOKEN, webRoot: null });
  await seedDemo(coordinator.context);
  const db = coordinator.context.storage.db;
  const project = await db.selectFrom('projects').select('id').where('slug', '=', 'checkout-v2').executeTakeFirstOrThrow();
  const agent = await db.selectFrom('agents').select('id').where('name', '=', 'Maren').executeTakeFirstOrThrow();
  await db.insertInto('product_envs').values({ id: 'env1', project_id: project.id, name: 'capture-target', branch: null, url: 'https://staging.example.com/', source: 'manual', created_at: 1, last_status: null, last_latency_ms: null }).execute();
  await createTurns(coordinator.context).enqueue({ agentId: agent.id, projectId: project.id, kind: 'capture', prepare: async (tx, workItemId) => {
    await tx.insertInto('snapshots').values({ id: 'snap1', project_id: project.id, env_id: 'env1', url: 'https://staging.example.com/', viewport: 'tablet', state: 'requested', error: null, attachment_id: null, markers: '[]', description: null, issue_id: null, work_item_id: workItemId, requested_by: null, created_at: 1, captured_at: null }).execute();
  } });
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'agent-team-worker-'));
  const worker = createWorker({ coordinatorUrl: coordinator.url, token: TOKEN, workerId: 'w1', stateDir, lanes: { work: 0, bounded: 1, deliver: 0 }, projects: { [project.id]: stateDir }, engine: fake, capture });
  return { coordinator, db, worker };
}

test('a capture turn runs no engine: the image is uploaded under the lease and becomes the snapshot', async () => {
  const asked: { url: string; viewport: string }[] = [];
  const { coordinator, db, worker } = await bootCapture(async input => { asked.push({ url: input.url, viewport: input.viewport }); writeFileSync(input.outFile, Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 9, 9])); return { file: input.outFile, latencyMs: 42 }; });
  assert.equal(await worker.tick(), true);
  await worker.idle();
  assert.deepEqual(asked, [{ url: 'https://staging.example.com/', viewport: 'tablet' }]);
  const turn = await db.selectFrom('turns').select(['kind', 'lane', 'access', 'state']).executeTakeFirstOrThrow();
  assert.deepEqual({ ...turn }, { kind: 'capture', lane: 'bounded', access: 'none', state: 'completed' });
  const snapshot = await db.selectFrom('snapshots').select(['state', 'attachment_id']).where('id', '=', 'snap1').executeTakeFirstOrThrow();
  assert.equal(snapshot.state, 'captured');
  assert.equal((await db.selectFrom('attachments').select('bytes').where('id', '=', snapshot.attachment_id!).executeTakeFirstOrThrow()).bytes, 6);
  assert.deepEqual(await plain(db.selectFrom('product_envs').select(['last_status', 'last_latency_ms']).where('id', '=', 'env1').executeTakeFirstOrThrow()), { last_status: 'ok', last_latency_ms: 42 });
  assert.equal(await db.selectFrom('trace_steps').select('seq').where('turn_id', 'in', db.selectFrom('turns').select('id').where('kind', '=', 'capture')).executeTakeFirst(), undefined);
  await coordinator.close();
});

test('a capture without a browser fails with its reason, not uncertain', async () => {
  const { coordinator, db, worker } = await bootCapture(async () => { throw new Error('No browser found to capture with'); });
  await worker.tick();
  await worker.idle();
  assert.deepEqual(await plain(db.selectFrom('turns').select(['state', 'stop_reason']).executeTakeFirstOrThrow()), { state: 'failed', stop_reason: 'capture' });
  assert.deepEqual(await plain(db.selectFrom('snapshots').select(['state', 'error']).where('id', '=', 'snap1').executeTakeFirstOrThrow()), { state: 'failed', error: 'No browser found to capture with' });
  assert.equal((await db.selectFrom('product_envs').select('last_status').where('id', '=', 'env1').executeTakeFirstOrThrow()).last_status, 'failed');
  await coordinator.close();
});
