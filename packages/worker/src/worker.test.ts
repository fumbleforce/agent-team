import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTurns, seedDemo, startCoordinator } from '@agent-team/coordinator';
import { fake } from '../../../adapters/engine/fake.ts';
import { createWorker } from './worker.ts';

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
  const turn = await db.selectFrom('turns').selectAll().executeTakeFirstOrThrow();
  assert.equal(turn.state, 'completed');
  assert.equal(turn.summary, 'Implemented and tested.');
  assert.equal(turn.cost_minor, 2);
  const steps = await db.selectFrom('trace_steps').select(['kind']).orderBy('seq').execute();
  assert.deepEqual(steps.map(step => step.kind), ['think', 'read', 'edit', 'run']);
  assert.equal((await db.selectFrom('agents').select('doing').where('id', '=', agentId).executeTakeFirstOrThrow()).doing, null);
  assert.equal(await worker.tick(), false);
  await coordinator.close();
});

test('a usage limit defers the turn, a crash blocks the task, a hang times out', async () => {
  for (const [scenario, state, taskState] of [['limit', 'deferred', 'in_progress'], ['crash', 'failed', 'blocked'], ['hang', 'timed_out', 'blocked']] as const) {
    const { coordinator, db, worker, taskId } = await boot(scenario);
    await worker.tick();
    await worker.idle();
    assert.equal((await db.selectFrom('turns').select('state').executeTakeFirstOrThrow()).state, state, scenario);
    assert.equal((await db.selectFrom('tasks').select('state').where('id', '=', taskId).executeTakeFirstOrThrow()).state, taskState, scenario);
    await coordinator.close();
  }
});
