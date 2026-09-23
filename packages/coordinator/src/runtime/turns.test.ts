import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '@agent-team/storage';
import { createContext } from '../context.ts';
import { seedDemo } from '../demo/seed.ts';
import { createTurns, LEASE_MS } from './turns.ts';

async function boot() {
  const storage = await createStorage({ kind: 'sqlite', path: ':memory:' });
  await storage.migrate();
  let clock = 1_000_000;
  const context = createContext({ storage, machineToken: 'x'.repeat(24), now: () => clock });
  await seedDemo(context);
  const db = storage.db;
  const project = await db.selectFrom('projects').select('id').where('slug', '=', 'checkout-v2').executeTakeFirstOrThrow();
  const agents = await db.selectFrom('agents').select(['id', 'name']).execute();
  const task = await db.selectFrom('tasks').select('id').where('key', '=', 'CK-31').executeTakeFirstOrThrow();
  const agent = (name: string) => agents.find(item => item.name === name)!.id;
  return { storage, turns: createTurns(context), projectId: project.id, taskId: task.id, agent, tick: (ms: number) => { clock += ms; } };
}
const worker = (projectId: string, id = 'w1') => ({ workerId: id, free: { work: 2, bounded: 2 }, projects: [projectId] });

test('claim is ordered by class, one running turn per agent and lane, one writer per task', async () => {
  const { storage, turns, projectId, taskId, agent } = await boot();
  await turns.enqueue({ agentId: agent('Bram'), projectId, kind: 'work', taskId });
  await turns.enqueue({ agentId: agent('Ada'), projectId, kind: 'work', taskId });
  await turns.enqueue({ agentId: agent('Bram'), projectId, kind: 'reply' });
  assert.equal(await turns.enqueue({ agentId: agent('Cleo'), projectId, kind: 'feedback', dedupeKey: 'd1' }) !== null, true);
  assert.equal(await turns.enqueue({ agentId: agent('Cleo'), projectId, kind: 'feedback', dedupeKey: 'd1' }), null);

  const first = await turns.claim(worker(projectId));
  assert.equal(first?.kind, 'reply');
  const kinds = [(await turns.claim(worker(projectId)))?.kind, (await turns.claim(worker(projectId)))?.kind];
  assert.deepEqual(kinds.sort(), ['feedback', 'work']);
  // Ada's work on the same task waits for Bram's write turn.
  assert.equal(await turns.claim(worker(projectId)), null);
  assert.equal((await storage.db.selectFrom('tasks').select('state').where('id', '=', taskId).executeTakeFirstOrThrow()).state, 'in_progress');
  // Starting work is a move like any other, and is said, with where the task came from.
  const started = await storage.db.selectFrom('events').select(['payload', 'agent_id']).where('task_id', '=', taskId).where('type', '=', 'task.state_changed').execute();
  assert.deepEqual(started.map(row => JSON.parse(row.payload).to), ['in_progress']);
  assert.ok(['backlog', 'assigned'].includes(JSON.parse(started[0]!.payload).from) && [agent('Bram'), agent('Ada')].includes(started[0]!.agent_id!));
  await storage.close();
});

test('heartbeat renews; a wrong token or worker is refused', async () => {
  const { storage, turns, projectId, taskId, agent, tick } = await boot();
  await turns.enqueue({ agentId: agent('Bram'), projectId, kind: 'work', taskId });
  const claimed = (await turns.claim(worker(projectId)))!;
  tick(LEASE_MS - 1000);
  await turns.heartbeat(claimed.turnId, 'w1', claimed.leaseToken);
  tick(LEASE_MS - 1000);
  await turns.heartbeat(claimed.turnId, 'w1', claimed.leaseToken);
  await assert.rejects(turns.heartbeat(claimed.turnId, 'w2', claimed.leaseToken), /Lease/);
  await assert.rejects(turns.heartbeat(claimed.turnId, 'w1', 'nope'), /Lease/);
  await storage.close();
});

test('an expired write turn is uncertain, quarantines its task and is never handed out again', async () => {
  const { storage, turns, projectId, taskId, agent, tick } = await boot();
  await turns.enqueue({ agentId: agent('Bram'), projectId, kind: 'work', taskId });
  const claimed = (await turns.claim(worker(projectId)))!;
  tick(LEASE_MS + 1);
  await turns.sweep();
  const turn = await storage.db.selectFrom('turns').select('state').where('id', '=', claimed.turnId).executeTakeFirstOrThrow();
  assert.equal(turn.state, 'uncertain');
  assert.equal((await storage.db.selectFrom('tasks').select('state').where('id', '=', taskId).executeTakeFirstOrThrow()).state, 'quarantined');
  await assert.rejects(turns.finish(claimed.turnId, 'w1', claimed.leaseToken, { state: 'completed' }), /Lease/);
  await turns.enqueue({ agentId: agent('Ada'), projectId, kind: 'work', taskId });
  assert.equal(await turns.claim(worker(projectId, 'w2')), null);
  await storage.close();
});

test('a deferred turn returns its item to the queue; a failed one runs once more with its failure in hand, then blocks the task', async () => {
  const { storage, turns, projectId, taskId, agent, tick } = await boot();
  const state = async () => (await storage.db.selectFrom('tasks').select('state').where('id', '=', taskId).executeTakeFirstOrThrow()).state;
  await turns.enqueue({ agentId: agent('Bram'), projectId, kind: 'work', taskId });
  const first = (await turns.claim(worker(projectId)))!;
  await turns.finish(first.turnId, 'w1', first.leaseToken, { state: 'deferred', stopReason: 'rate-limited' });
  assert.equal(await turns.claim(worker(projectId)), null);
  tick(5 * 60_000 + 1);
  const second = (await turns.claim(worker(projectId)))!;
  await turns.finish(second.turnId, 'w1', second.leaseToken, { state: 'failed', stopReason: 'crashed', summary: 'engine exited: out of memory' });
  assert.notEqual(await state(), 'blocked', 'one crash is tried again');
  const third = (await turns.claim(worker(projectId)))!;
  assert.match(third.packet.prompt, /# Your last turn on this task failed\nIt stopped with crashed: engine exited: out of memory/);
  await turns.finish(third.turnId, 'w1', third.leaseToken, { state: 'failed', stopReason: 'crashed' });
  assert.equal(await state(), 'blocked', 'a second failure in a row sets the task aside');

  // What trying again cannot change is not tried again.
  await storage.db.updateTable('tasks').set({ state: 'in_progress', blocked_reason: null }).where('id', '=', taskId).execute();
  await turns.enqueue({ agentId: agent('Bram'), projectId, kind: 'work', taskId, dedupeKey: 'again' });
  const signedOut = (await turns.claim(worker(projectId)))!;
  await turns.finish(signedOut.turnId, 'w1', signedOut.leaseToken, { state: 'failed', stopReason: 'auth' });
  assert.equal(await state(), 'blocked');
  await storage.close();
});

test('finishing records cost with a daily rollup, and an agent over its daily cap is not scheduled', async () => {
  const { storage, turns, projectId, taskId, agent } = await boot();
  await storage.db.deleteFrom('cost_daily').execute();
  await storage.db.updateTable('agents').set({ daily_cap_minor: 100 }).where('id', '=', agent('Bram')).execute();
  await turns.enqueue({ agentId: agent('Bram'), projectId, kind: 'work', taskId });
  const first = (await turns.claim(worker(projectId)))!;
  await turns.finish(first.turnId, 'w1', first.leaseToken, { state: 'completed', tokensIn: 1000, tokensOut: 200, costMinor: 150 });
  const daily = await storage.db.selectFrom('cost_daily').selectAll().executeTakeFirstOrThrow();
  assert.deepEqual([daily.amount_minor, daily.tokens, daily.agent_id], [150, 1200, agent('Bram')]);
  await turns.enqueue({ agentId: agent('Bram'), projectId, kind: 'work', taskId });
  assert.equal(await turns.claim(worker(projectId)), null);
  assert.equal((await storage.db.selectFrom('work_items').select('defer_reason').where('state', '=', 'queued').executeTakeFirstOrThrow()).defer_reason, 'over-cap');
  await storage.close();
});

test('a provider serves only as many turns at once as its limit, and the claim carries the agent’s engine and model', async () => {
  const { storage, turns, projectId, agent } = await boot();
  await storage.db.insertInto('providers').values({ id: 'router', name: 'Router', kind: 'metered', engine: 'opencode', billing: 'metered', engine_config: '{}', models: '["vendor/model-a"]', limits: '{"maxConcurrentTurns":1}', status: 'connected', status_detail: null }).execute();
  await storage.db.updateTable('agents').set({ provider_id: 'router', model: 'vendor/model-a' }).where('id', 'in', [agent('Bram'), agent('Cleo')]).execute();
  await turns.enqueue({ agentId: agent('Bram'), projectId, kind: 'reply' });
  await turns.enqueue({ agentId: agent('Cleo'), projectId, kind: 'reply' });
  const first = (await turns.claim(worker(projectId)))!;
  assert.deepEqual([first.engine, first.model], ['opencode', 'vendor/model-a']);
  assert.equal(await turns.claim(worker(projectId)), null);
  assert.equal((await storage.db.selectFrom('work_items').select('defer_reason').where('state', '=', 'queued').executeTakeFirstOrThrow()).defer_reason, 'provider-busy');
  await turns.finish(first.turnId, 'w1', first.leaseToken, { state: 'completed' });
  assert.ok(await turns.claim(worker(projectId)));
  await storage.close();
});
