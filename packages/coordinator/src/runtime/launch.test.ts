import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '@agent-team/storage';
import { createContext } from '../context.ts';
import { seedDemo } from '../demo/seed.ts';
import { createLaunches } from './launch.ts';
import { createTurns } from './turns.ts';

test('waiting work with no worker starts one disposable worker; a seen worker or no launcher starts none', async () => {
  const storage = await createStorage({ kind: 'sqlite', path: ':memory:' });
  await storage.migrate();
  let clock = Date.now();
  const context = createContext({ storage, machineToken: 'x'.repeat(24), now: () => clock });
  await seedDemo(context);
  const db = storage.db;
  const project = await db.selectFrom('projects').select(['id', 'manifest']).where('slug', '=', 'checkout-v2').executeTakeFirstOrThrow();
  const agent = await db.selectFrom('agents').select('id').where('name', '=', 'Bram').executeTakeFirstOrThrow();
  const task = await db.selectFrom('tasks').select('id').where('key', '=', 'CK-31').executeTakeFirstOrThrow();
  await db.updateTable('work_items').set({ state: 'done' }).execute();
  await createTurns(context).enqueue({ agentId: agent.id, projectId: project.id, kind: 'work', taskId: task.id });

  const started: string[] = [], stopped: string[] = [];
  const launches = createLaunches(context, kind => ({
    start: async job => { started.push(`${kind}:${job.projectId}`); return { kind, jobId: job.id, startedAt: clock }; },
    stop: async handle => { stopped.push(handle.jobId); },
  }));

  // No launcher named in the manifest: nothing starts, however long the work waits.
  clock += 5 * 60_000;
  assert.equal(await launches.sweep(), 0);
  await db.updateTable('projects').set({ manifest: JSON.stringify({ ...JSON.parse(project.manifest), worker: { launcher: 'ec2' } }) }).where('id', '=', project.id).execute();

  // A worker that serves the project was just seen: it will claim the work itself.
  await db.insertInto('workers').values({ id: 'w1', name: 'w1', lanes: '{}', isolation: 'isolated', providers: '[]', projects: JSON.stringify([project.id]), last_seen_at: clock }).execute();
  assert.equal(await launches.sweep(), 0);

  clock += 10 * 60_000;
  assert.equal(await launches.sweep(), 1);
  assert.equal(await launches.sweep(), 0, 'one launch per project at a time');
  assert.deepEqual(started, [`ec2:${project.id}`]);

  // Once nothing is waiting, the launched worker is stopped.
  await db.updateTable('work_items').set({ state: 'done' }).execute();
  await launches.sweep();
  assert.equal(stopped.length, 1);
  await storage.close();
});

test('a launched worker that has finished makes room for the next at once; each launch has a token of its own, taken back when it ends', async () => {
  const storage = await createStorage({ kind: 'sqlite', path: ':memory:' });
  await storage.migrate();
  let clock = Date.now();
  const context = createContext({ storage, machineToken: 'x'.repeat(24), now: () => clock });
  await seedDemo(context);
  const db = storage.db;
  const project = await db.selectFrom('projects').select(['id', 'manifest']).where('slug', '=', 'checkout-v2').executeTakeFirstOrThrow();
  await db.updateTable('projects').set({ manifest: JSON.stringify({ ...JSON.parse(project.manifest), worker: { launcher: 'ec2' } }) }).where('id', '=', project.id).execute();
  const agent = await db.selectFrom('agents').select('id').where('name', '=', 'Bram').executeTakeFirstOrThrow();
  await db.updateTable('work_items').set({ state: 'done' }).execute();
  const turns = createTurns(context);
  await turns.enqueue({ agentId: agent.id, projectId: project.id, kind: 'reply', dedupeKey: 'one' });
  await turns.enqueue({ agentId: agent.id, projectId: project.id, kind: 'retro', dedupeKey: 'two' });

  const tokens: string[] = [], states = new Map<string, string>();
  let stops = 0;
  const launches = createLaunches(context, kind => ({
    start: async job => { tokens.push(job.token!); const id = `launch-${tokens.length}`; states.set(id, 'running'); return { kind, jobId: id, startedAt: clock }; },
    stop: async handle => { states.set(handle.jobId, 'stopped'); stops++; },
    status: async handle => ({ state: states.get(handle.jobId) ?? 'unknown' }),
  }));
  clock += 2 * 60_000;
  assert.equal(await launches.sweep(), 1);
  assert.ok(tokens[0] && tokens[0] !== 'x'.repeat(24), 'the launch is given a token of its own, not the root token');
  // The worker ran one turn and exited: the next queued work starts another launch in the same sweep.
  await db.updateTable('work_items').set({ state: 'done' }).where('dedupe_key', '=', 'one').execute();
  states.set('launch-1', 'terminated');
  assert.equal(await launches.sweep(), 1);
  assert.notEqual(tokens[1], tokens[0]);
  const revoked = await db.selectFrom('machine_tokens').select('revoked_at').orderBy('created_at').execute();
  assert.deepEqual(revoked.map(row => row.revoked_at !== null), [true, false], 'the first launch\'s token is taken back');
  // A launch that has run past its time is stopped; the work still waiting starts a fresh one.
  clock += 61 * 60_000;
  await launches.sweep();
  assert.deepEqual([states.get('launch-2'), stops], ['stopped', 1], 'an ended launch is not stopped again; an overdue one is');
  assert.equal([...states.values()].filter(state => state === 'running').length, 1);
  await storage.close();
});
