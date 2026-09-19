import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '@agent-team/storage';
import { newId, type TurnKind } from '@agent-team/protocol';
import { createContext } from '../context.ts';
import { seedDemo } from '../demo/seed.ts';
import { WORKER_FRESH_MS } from './scheduler.ts';
import { createTurns, LEASE_MS, type Claimed } from './turns.ts';

// A seeded long run of the real claim path on a virtual clock: two workers, two providers, caps, a budget, pauses,
// usage limits, crashes and lost leases. After every claim the invariants of spec 9.2 are read back from the database;
// at the end every task is terminal or explicitly quarantined. Reproduce a failure with SIM_SEED=<n>.
const SEEDS = process.env.SIM_SEED ? [Number(process.env.SIM_SEED)] : [1, 7, 20260919];
const STEPS = Number(process.env.SIM_STEPS ?? 4000), TASKS = 40, BUDGET = 25_000;

function mulberry(seed: number) {
  let state = seed >>> 0;
  return () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

for (const seed of SEEDS) test(`seeded run ${seed}: invariants hold and every task ends terminal or quarantined`, async () => {
  const random = mulberry(seed), chance = (p: number) => random() < p, oneOf = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
  const storage = await createStorage({ kind: 'sqlite', path: ':memory:' });
  try {
    await storage.migrate();
    let clock = Date.UTC(2026, 2, 2, 8);
    const context = createContext({ storage, machineToken: 'x'.repeat(24), now: () => clock });
    await seedDemo(context);
    const db = storage.db, turns = createTurns(context);
    const project = await db.selectFrom('projects').select(['id', 'parent_id']).where('slug', '=', 'checkout-v2').executeTakeFirstOrThrow();
    // The seats of the project's own team: the demo has other teams, and their agents take no work here.
    const team = await db.selectFrom('projects').select('team_id').where('id', '=', project.parent_id).executeTakeFirstOrThrow();
    const agents = (await db.selectFrom('agents').select('id').where('team_id', '=', team.team_id).execute()).map(row => row.id);
    await db.deleteFrom('cost_daily').execute();
    await db.deleteFrom('cost_entries').execute();
    await db.deleteFrom('budgets').execute();
    for (const [id, limits] of [['alpha', { maxConcurrentTurns: 2 }], ['beta', { maxConcurrentTurns: 1, windowTokens: 400_000, windowMs: 3600_000 }]] as const)
      await db.insertInto('providers').values({ id, name: id, kind: 'metered', engine: 'fake', billing: 'metered', engine_config: '{}', models: JSON.stringify([`${id}-model`]), limits: JSON.stringify(limits), status: 'connected', status_detail: null }).execute();
    for (const [index, id] of agents.entries()) await db.updateTable('agents').set({ provider_id: index % 2 ? 'beta' : 'alpha', model: null, daily_cap_minor: index % 3 === 0 ? 9000 : null }).where('id', '=', id).execute();
    await db.insertInto('budgets').values({ scope: 'project', scope_id: project.id, period: 'month', amount_minor: BUDGET, warned_period: null }).execute();
    await db.insertInto('versioned_docs').values({ kind: 'cost_rules', slug: 'default', scope_type: 'org', scope_id: '', version: 1, doc: JSON.stringify({ dailyCap: { fallbackProvider: 'beta' } }), author: 'sim', updated_at: clock }).execute();
    await db.insertInto('versioned_docs').values({ kind: 'routing_rules', slug: 'default', scope_type: 'org', scope_id: '', version: 1, doc: JSON.stringify({ routes: [{ id: 'reviews', kinds: ['review'], provider: 'beta' }] }), author: 'sim', updated_at: clock }).execute();

    const tasks: string[] = [];
    for (let n = 0; n < TASKS; n += 1) {
      const id = newId(clock), owner = oneOf(agents);
      tasks.push(id);
      await db.insertInto('tasks').values({ id, project_id: project.id, key: `SIM-${n}`, source: 'internal', title: `Simulated ${n}`, brief: '', tag: oneOf(['billing', 'docs', null]), priority: n, milestone_id: null, state: 'assigned', assignee_agent_id: owner, author_agent_id: null, branch: null, head_sha: null, pr_url: null, blocked_reason: null, created_at: clock, updated_at: clock }).execute();
      await turns.enqueue({ agentId: owner, projectId: project.id, kind: 'work', taskId: id, dedupeKey: `work:${id}` });
    }

    const workers = ['w1', 'w2'], live = new Map<string, Claimed & { workerId: string }>();
    const spent = async () => Number((await db.selectFrom('cost_daily').select(eb => eb.fn.sum<number>('amount_minor').as('total')).where('project_id', '=', project.id).where('day', '>=', `${new Date(clock).toISOString().slice(0, 7)}-01`).executeTakeFirst())?.total ?? 0);
    const budget = async () => (await db.selectFrom('budgets').select('amount_minor').executeTakeFirst())?.amount_minor ?? null;
    let started = 0, uncertain = 0, overBudgetStarts = 0, raises = 0;

    async function claim(workerId: string) {
      await db.insertInto('workers').values({ id: workerId, name: workerId, lanes: '{}', isolation: 'isolated', providers: '[]', projects: JSON.stringify([project.id]), last_seen_at: clock }).onConflict(oc => oc.column('id').doUpdateSet({ last_seen_at: clock })).execute();
      const before = await spent(), cap = await budget();
      const limitedBefore = new Set((await db.selectFrom('providers').select('id').where('limited_until', '>', clock).execute()).map(row => row.id));
      const fresh = new Set((await db.selectFrom('workers').select('id').where('last_seen_at', '>', clock - WORKER_FRESH_MS).execute()).map(row => row.id));
      const holders = new Map((await db.selectFrom('turns').select(['task_id', 'worker_id']).where('access', '=', 'write').where('task_id', 'is not', null).orderBy('started_at').orderBy('id').execute()).map(row => [row.task_id, row.worker_id]));
      const claimed = await turns.claim({ workerId, free: { work: 2, bounded: 2 }, projects: [project.id] });
      if (!claimed) return null;
      started += 1;
      live.set(claimed.turnId, { ...claimed, workerId });
      const turn = await db.selectFrom('turns').innerJoin('work_items', 'work_items.id', 'turns.work_item_id').select(['turns.provider_id', 'turns.access', 'work_items.priority_class', 'work_items.state']).where('turns.id', '=', claimed.turnId).executeTakeFirstOrThrow();
      assert.equal(turn.state, 'leased');

      // 9.2, read back from the database after every claim.
      const running = await db.selectFrom('turns').select(['id', 'agent_id', 'lane', 'task_id', 'access', 'provider_id', 'lease_until']).where('state', '=', 'running').execute();
      const unique = (keys: string[], what: string) => assert.equal(new Set(keys).size, keys.length, `${what} (seed ${seed}, step clock ${clock})`);
      unique(running.map(row => `${row.agent_id}/${row.lane}`), 'one running turn per agent and lane');
      unique(running.filter(row => row.access === 'write' && row.task_id).map(row => row.task_id!), 'one writer per task');
      for (const [id, max] of [['alpha', 2], ['beta', 1]] as const) assert.ok(running.filter(row => row.provider_id === id).length <= max, `provider ${id} over its concurrency`);
      assert.ok(turn.provider_id !== null && !limitedBefore.has(turn.provider_id), 'a turn started on a limited provider');
      if (claimed.taskId) {
        assert.equal(await db.selectFrom('quarantines').select('id').where('ref_id', '=', claimed.taskId).where('released_at', 'is', null).executeTakeFirst(), undefined, 'a turn started on a quarantined task');
        const holder = holders.get(claimed.taskId);
        if (turn.access === 'write' && holder && fresh.has(holder)) assert.equal(holder, workerId, 'a write turn left the worker that holds its worktree');
      }
      if (cap !== null && before >= cap) { overBudgetStarts += 1; assert.ok(turn.priority_class <= 2, `class ${turn.priority_class} started over budget`); }
      return claimed;
    }

    async function settle(turnId: string, faults: boolean) {
      const turn = live.get(turnId)!;
      live.delete(turnId);
      const cost = { tokensIn: 2000 + Math.floor(random() * 30_000), tokensOut: Math.floor(random() * 4000), costMinor: Math.floor(random() * 900) };
      const roll = faults ? random() : 1;
      if (roll < 0.04) { uncertain += 1; return; } // The worker dies silently: the lease runs out and nobody ever finishes the turn.
      if (roll < 0.05) await assert.rejects(turns.finish(turnId, turn.workerId, 'not-the-token', { state: 'completed' }), /Lease/);
      if (roll < 0.12) return void await turns.finish(turnId, turn.workerId, turn.leaseToken, { state: 'deferred', stopReason: 'rate-limited', ...(chance(0.5) ? { resetAt: clock + 10 * 60_000 } : {}) });
      if (roll < 0.17) {
        await turns.finish(turnId, turn.workerId, turn.leaseToken, { state: chance(0.5) ? 'failed' : 'timed_out', stopReason: 'crashed', ...cost });
        // The PM's triage, compressed: a blocked task goes back to its owner.
        if (turn.taskId) {
          await db.updateTable('tasks').set({ state: 'assigned', blocked_reason: null }).where('id', '=', turn.taskId).where('state', '=', 'blocked').execute();
          const task = await db.selectFrom('tasks').select(['state', 'assignee_agent_id']).where('id', '=', turn.taskId).executeTakeFirstOrThrow();
          if (task.state !== 'done' && task.state !== 'quarantined') await turns.enqueue({ agentId: task.assignee_agent_id!, projectId: project.id, kind: 'work', taskId: turn.taskId, dedupeKey: `work:${turn.taskId}` });
        }
        return;
      }
      await turns.finish(turnId, turn.workerId, turn.leaseToken, { state: 'completed', summary: 'Reported.', ...cost });
      if (turn.kind !== 'work' || !turn.taskId) return;
      // Work either finishes the task (delivery is not simulated) or asks for a review and continues.
      if (chance(0.55)) await db.updateTable('tasks').set({ state: 'done', updated_at: clock }).where('id', '=', turn.taskId).execute();
      else {
        await turns.enqueue({ agentId: oneOf(agents.filter(id => id !== turn.agentId)), projectId: project.id, kind: 'review', taskId: turn.taskId, dedupeKey: `review:${turn.taskId}` });
        await turns.enqueue({ agentId: turn.agentId, projectId: project.id, kind: 'work', taskId: turn.taskId, dedupeKey: `work:${turn.taskId}` });
      }
    }

    for (let step = 0; step < STEPS; step += 1) {
      clock += 5_000 + Math.floor(random() * 60_000);
      const roll = random();
      if (roll < 0.45) await claim(oneOf(workers));
      else if (roll < 0.8 && live.size) { const id = oneOf([...live.keys()]); await turns.heartbeat(id, live.get(id)!.workerId, live.get(id)!.leaseToken).then(() => settle(id, true), () => { live.delete(id); }); }
      else if (roll < 0.9) await turns.enqueue({ agentId: oneOf(agents), projectId: project.id, kind: oneOf<TurnKind>(['reply', 'feedback', 'conclude', 'retro', 'triage']), dedupeKey: `bounded:${step % 40}` });
      else if (roll < 0.94) await db.updateTable('agents').set({ status: chance(0.5) ? 'paused' : 'active' }).where('id', '=', oneOf(agents)).execute();
      else if (roll < 0.96) await db.updateTable('projects').set({ status: chance(0.5) ? 'paused' : 'active' }).where('id', '=', project.id).execute();
      else if (roll < 0.965 && await spent() >= (await budget() ?? Infinity)) { raises += 1; await db.updateTable('budgets').set({ amount_minor: await spent() + 15_000, warned_period: null }).execute(); } // The owner raises a spent budget, which re-arms its warning.
      else await turns.sweep();
      // Turns whose worker is alive keep their lease; the ones abandoned above are left to expire.
      for (const [id, turn] of live) await turns.heartbeat(id, turn.workerId, turn.leaseToken).catch(() => live.delete(id));
    }

    // Drain: people lift what people control (pauses, caps, the budget); nothing is retried or released for them.
    await db.updateTable('agents').set({ status: 'active', daily_cap_minor: null }).execute();
    await db.updateTable('projects').set({ status: 'active' }).where('id', '=', project.id).execute();
    await db.deleteFrom('budgets').execute();
    const open = () => db.selectFrom('work_items').leftJoin('tasks', 'tasks.id', 'work_items.task_id').select(['work_items.id', 'work_items.defer_reason', 'tasks.state as task_state']).where('work_items.state', 'in', ['queued', 'leased']).execute();
    for (let round = 0; round < 4000; round += 1) {
      for (const [id, turn] of [...live]) await turns.heartbeat(id, turn.workerId, turn.leaseToken).then(() => settle(id, false));
      clock += LEASE_MS + 60_000;
      await turns.sweep();
      for (const workerId of workers) while (await claim(workerId)) { /* take everything that may start */ }
      if (live.size === 0 && (await open()).every(item => item.task_state === 'quarantined')) break;
    }

    const left = await open();
    assert.deepEqual(left.filter(item => item.task_state !== 'quarantined'), [], 'work is still queued for tasks that could run');
    const end = await db.selectFrom('tasks').select(['id', 'key', 'state']).where('id', 'in', tasks).execute();
    const quarantined = new Set((await db.selectFrom('quarantines').select('ref_id').where('released_at', 'is', null).execute()).map(row => row.ref_id));
    for (const task of end) assert.ok(task.state === 'done' || task.state === 'canceled' || (task.state === 'quarantined' && quarantined.has(task.id)), `${task.key} ended ${task.state}`);
    assert.equal((await db.selectFrom('turns').select('id').where('state', '=', 'running').execute()).length, 0);

    // Never retried, never reassigned: an uncertain turn is the last turn of its item, and a written task stays quarantined.
    const lost = await db.selectFrom('turns').select(['id', 'work_item_id', 'task_id', 'access', 'started_at']).where('state', '=', 'uncertain').execute();
    assert.equal(lost.length, uncertain);
    for (const turn of lost) {
      const item = await db.selectFrom('work_items').select('state').where('id', '=', turn.work_item_id).executeTakeFirstOrThrow();
      const later = await db.selectFrom('turns').select('id').where('work_item_id', '=', turn.work_item_id).where('id', '!=', turn.id).where('started_at', '>=', turn.started_at).execute();
      assert.deepEqual([item.state, later.length], ['expired', 0]);
      if (turn.access === 'write' && turn.task_id) assert.equal(end.find(task => task.id === turn.task_id)?.state ?? 'quarantined', 'quarantined');
    }
    assert.equal((await db.selectFrom('events').select('seq').where('type', '=', 'budget.threshold').execute()).length <= 1 + raises, true, 'the budget warned more than once per amount');
    assert.ok(started > TASKS, `only ${started} turns started`);
    console.log(`seed ${seed}: ${started} turns, ${uncertain} uncertain, ${overBudgetStarts} started over budget (${raises} raises), ${end.filter(task => task.state === 'quarantined').length}/${TASKS} tasks quarantined`);
  } finally { await storage.close(); }
});
