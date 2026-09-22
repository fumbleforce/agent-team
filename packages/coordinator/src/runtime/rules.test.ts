import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '@agent-team/storage';
import { CostRules, RoutingRules, type TurnKind } from '@agent-team/protocol';
import { createContext } from '../context.ts';
import { seedDemo } from '../demo/seed.ts';
import { createVersionedDocs } from '../repos/versionedDocs.ts';
import { evaluate } from './rules.ts';
import { laneOf, type Snapshot, type TurnDraft } from './scheduler.ts';
import { createTurns, RULES_SCOPE, RULES_SLUG } from './turns.ts';

const draft = (kind: TurnKind, priorityClass: number, taskId: string | null = 't'): TurnDraft => ({ id: 'i1', agentId: 'a', projectId: 'p', kind, lane: laneOf(kind), taskId, priorityClass, createdAt: 0 });
const provider = (id: string, name = id, windowPct: number | null = null) => ({ id, name, status: 'connected', models: [`${id}-default`], limitedUntil: null, running: 0, maxConcurrent: null, windowPct });
const world = (cost: unknown = {}, routing: unknown = {}, over: Partial<Snapshot> = {}): Snapshot => ({
  now: 0, items: [], running: [], rules: { cost: CostRules.parse(cost), routing: RoutingRules.parse(routing) },
  agents: { a: { status: 'active', providerId: 'main', model: 'seat-model', dailyCapMinor: 100, spentTodayMinor: 0, lastStartedAt: 0 } },
  tasks: { t: { state: 'in_progress', tags: ['billing'], difficulty: null, quarantined: false, writerRunning: false, holder: null, sticky: null } },
  providers: { main: provider('main'), cheap: provider('cheap', 'Cheap lane') }, projects: { p: { status: 'active', budgetPct: null, budget: null, warned: false, deliveryBusy: false } }, ...over,
});
const over = (snapshot: Snapshot): Snapshot => ({ ...snapshot, agents: { a: { ...snapshot.agents.a!, spentTodayMinor: 100 } } });

test('daily cap: defer, fall back to the named provider, or stand aside when switched off', () => {
  assert.deepEqual(evaluate(draft('work', 5), world()), { allow: true, route: { providerId: 'main', model: 'seat-model' }, notices: [] });
  assert.deepEqual(evaluate(draft('work', 5), over(world())), { allow: false, deferReason: 'over-cap', notices: [] });
  const fallen = evaluate(draft('work', 5), over(world({ dailyCap: { fallbackProvider: 'Cheap lane' } })));
  assert.deepEqual([fallen.allow, fallen.route, fallen.notices], [true, { providerId: 'cheap', model: 'cheap-default' }, [{ type: 'cap.fallback', agentId: 'a', projectId: 'p', providerId: 'cheap' }]]);
  assert.equal(evaluate(draft('work', 5), over(world({ dailyCap: { fallbackProvider: 'nowhere' } }))).deferReason, 'over-cap');
  assert.equal(evaluate(draft('work', 5), over(world({ dailyCap: { enabled: false } }))).allow, true);
  assert.equal(evaluate(draft('reply', 1), over(world())).allow, true);
});

test('routing: first enabled match by kind and tag wins; a work turn stays on its task’s route', () => {
  const routes = { routes: [
    { id: 'off', enabled: false, provider: 'cheap' },
    { id: 'reviews', kinds: ['review'], provider: 'cheap', model: 'small' },
    { id: 'billing', kinds: ['work'], tags: ['billing'], provider: 'Cheap lane' },
    { id: 'ghost', provider: 'missing' },
  ] };
  assert.deepEqual(evaluate(draft('review', 3), world({}, routes)).route, { providerId: 'cheap', model: 'small' });
  assert.deepEqual(evaluate(draft('work', 5), world({}, routes)).route, { providerId: 'cheap', model: 'cheap-default' });
  assert.deepEqual(evaluate(draft('feedback', 3), world({}, routes)).route, { providerId: 'main', model: 'seat-model' });
  const untagged = world({}, routes);
  untagged.tasks.t!.tags = ['docs'];
  assert.deepEqual(evaluate(draft('work', 5), untagged).route, { providerId: 'main', model: 'seat-model' });
  const sticky = world({}, routes);
  sticky.tasks.t!.sticky = { providerId: 'main', model: 'started-on' };
  assert.deepEqual(evaluate(draft('work', 5), sticky).route, { providerId: 'main', model: 'started-on' });
  assert.deepEqual(evaluate(draft('review', 3), sticky).route, { providerId: 'cheap', model: 'small' });
});

test('routing: a rule for hard work applies only to a task the decision model read as hard', () => {
  const routes = { routes: [{ id: 'hard', kinds: ['work'], difficulty: ['hard'], provider: 'main', model: 'frontier' }, { id: 'rest', kinds: ['work'], provider: 'cheap' }] };
  assert.deepEqual(evaluate(draft('work', 5), world({}, routes)).route, { providerId: 'cheap', model: 'cheap-default' }, 'unsized: the rule does not apply');
  const hard = world({}, routes);
  hard.tasks.t!.difficulty = 'hard';
  assert.deepEqual(evaluate(draft('work', 5), hard).route, { providerId: 'main', model: 'frontier' });
  const trivial = world({}, routes);
  trivial.tasks.t!.difficulty = 'trivial';
  assert.deepEqual(evaluate(draft('work', 5), trivial).route, { providerId: 'cheap', model: 'cheap-default' });
});

test('budget: one notice at the threshold until warned; at 100 % only classes 1 and 2', () => {
  const at = (budgetPct: number, warned = false) => world({}, {}, { projects: { p: { status: 'active', budgetPct, budget: { scope: 'project', scopeId: 'p' }, warned, deliveryBusy: false } } });
  assert.deepEqual(evaluate(draft('work', 5), at(79)).notices, []);
  assert.deepEqual(evaluate(draft('work', 5), at(80.5)).notices, [{ type: 'budget.threshold', projectId: 'p', scope: 'project', scopeId: 'p', percent: 80, threshold: 80 }]);
  assert.deepEqual(evaluate(draft('work', 5), at(85, true)).notices, []);
  const custom = at(60);
  custom.rules.cost = CostRules.parse({ budgetWarn: { percent: 50 } });
  assert.equal(evaluate(draft('work', 5), custom).notices.length, 1);
  custom.rules.cost = CostRules.parse({ budgetWarn: { enabled: false, percent: 50 } });
  assert.equal(evaluate(draft('work', 5), custom).notices.length, 0);
  for (const [kind, priorityClass, allow] of [['reply', 1, true], ['revise', 2, true], ['review', 3, false], ['work', 4, false], ['retro', 6, false]] as const) assert.equal(evaluate(draft(kind, priorityClass), at(100, true)).allow, allow, kind);
  assert.equal(evaluate(draft('work', 5), at(100, true)).deferReason, 'over-budget');
});

test('a paused project keeps its agents until the provider window reaches the percentage', () => {
  const paused = (windowPct: number | null, status = 'paused') => world({ windowPause: { percent: 70 } }, {}, { providers: { main: provider('main', 'main', windowPct) }, projects: { p: { status, budgetPct: null, budget: null, warned: false, deliveryBusy: false } } });
  assert.equal(evaluate(draft('work', 5), paused(69)).allow, true);
  assert.deepEqual(evaluate(draft('work', 5), paused(70)), { allow: false, deferReason: 'project-paused', notices: [] });
  assert.equal(evaluate(draft('work', 5), paused(95, 'active')).allow, true);
  assert.equal(evaluate(draft('work', 5), paused(null)).allow, true);
});

async function boot() {
  const storage = await createStorage({ kind: 'sqlite', path: ':memory:' });
  await storage.migrate();
  let clock = Date.UTC(2026, 4, 10, 9);
  const context = createContext({ storage, machineToken: 'x'.repeat(24), now: () => clock });
  await seedDemo(context);
  const db = storage.db;
  const project = await db.selectFrom('projects').select('id').where('slug', '=', 'checkout-v2').executeTakeFirstOrThrow();
  const agents = await db.selectFrom('agents').select(['id', 'name']).execute();
  const task = await db.selectFrom('tasks').select('id').where('key', '=', 'CK-31').executeTakeFirstOrThrow();
  await db.deleteFrom('cost_daily').execute();
  await db.deleteFrom('budgets').execute();
  for (const id of ['main', 'spare']) await db.insertInto('providers').values({ id, name: id, kind: 'metered', engine: 'fake', billing: 'metered', engine_config: '{}', models: JSON.stringify([`${id}-model`]), limits: '{"maxConcurrentTurns":4}', status: 'connected', status_detail: null }).execute();
  await db.updateTable('agents').set({ provider_id: 'main', model: 'main-model' }).execute();
  return { storage, context, turns: createTurns(context), docs: createVersionedDocs(context), projectId: project.id, taskId: task.id, agent: (name: string) => agents.find(item => item.name === name)!.id, tick: (ms: number) => { clock += ms; }, now: () => clock };
}
const worker = (projectId: string) => ({ workerId: 'w1', free: { work: 2, bounded: 2 }, projects: [projectId] });

test('a rate-limited turn limits its provider until reset; its agents wait as provider-limited and resume by themselves', async () => {
  const { storage, turns, projectId, taskId, agent, tick, now } = await boot();
  try {
    await turns.enqueue({ agentId: agent('Bram'), projectId, kind: 'work', taskId });
    const first = (await turns.claim(worker(projectId)))!;
    await turns.finish(first.turnId, 'w1', first.leaseToken, { state: 'deferred', stopReason: 'rate-limited', resetAt: now() + 20 * 60_000 });
    await turns.enqueue({ agentId: agent('Cleo'), projectId, kind: 'reply' });
    assert.equal(await turns.claim(worker(projectId)), null);
    const waiting = await storage.db.selectFrom('work_items').select(['kind', 'defer_reason']).where('state', '=', 'queued').orderBy('kind').execute();
    assert.deepEqual(waiting.map(row => [row.kind, row.defer_reason]), [['reply', 'provider-limited'], ['work', 'provider-limited']]);
    assert.equal((await storage.db.selectFrom('tasks').select('state').where('id', '=', taskId).executeTakeFirstOrThrow()).state, 'in_progress');
    assert.equal((await storage.db.selectFrom('quarantines').select('id').execute()).length, 0);
    assert.equal((await storage.db.selectFrom('events').select('type').where('type', '=', 'provider.limited').execute()).length, 1);
    tick(19 * 60_000);
    assert.equal(await turns.claim(worker(projectId)), null);
    tick(60_001);
    assert.deepEqual([(await turns.claim(worker(projectId)))?.kind, (await turns.claim(worker(projectId)))?.kind], ['reply', 'work']);
  } finally { await storage.close(); }
});

test('stored rules drive the claim: cap fallback, sticky route, one budget warning, only classes 1 and 2 past the budget', async () => {
  const { storage, turns, docs, projectId, taskId, agent } = await boot();
  try {
    await docs.save('cost_rules', RULES_SCOPE, RULES_SLUG, { dailyCap: { fallbackProvider: 'spare' } }, { author: 'test' });
    await docs.save('routing_rules', RULES_SCOPE, RULES_SLUG, { routes: [{ id: 'replies', kinds: ['reply'], provider: 'spare', model: 'tiny' }] }, { author: 'test' });
    await storage.db.updateTable('agents').set({ daily_cap_minor: 100 }).where('id', '=', agent('Bram')).execute();
    await storage.db.insertInto('budgets').values({ scope: 'project', scope_id: projectId, period: 'month', amount_minor: 1000, warned_period: null }).execute();

    await turns.enqueue({ agentId: agent('Cleo'), projectId, kind: 'reply' });
    const reply = (await turns.claim(worker(projectId)))!;
    assert.deepEqual([reply.engine, reply.model], ['fake', 'tiny']);
    await turns.finish(reply.turnId, 'w1', reply.leaseToken, { state: 'completed' });

    await turns.enqueue({ agentId: agent('Bram'), projectId, kind: 'work', taskId });
    const first = (await turns.claim(worker(projectId)))!;
    assert.equal(first.model, 'main-model');
    await turns.finish(first.turnId, 'w1', first.leaseToken, { state: 'completed', summary: 'Checkpoint.', tokensIn: 10, tokensOut: 10, costMinor: 850 });
    assert.equal((await storage.db.selectFrom('cost_entries').select('provider_id').where('turn_id', '=', first.turnId).executeTakeFirstOrThrow()).provider_id, 'main');

    // Over its cap Bram would fall back to the spare provider, but the task's work already runs on main: sticky wins over rules, the cap over sticky.
    await turns.enqueue({ agentId: agent('Bram'), projectId, kind: 'work', taskId });
    const second = (await turns.claim(worker(projectId)))!;
    assert.equal(second.model, 'spare-model');
    assert.equal((await storage.db.selectFrom('turns').select('provider_id').where('id', '=', second.turnId).executeTakeFirstOrThrow()).provider_id, 'spare');
    const warnings = () => storage.db.selectFrom('events').select('type').where('type', '=', 'budget.threshold').execute();
    assert.equal((await warnings()).length, 1);
    assert.equal((await storage.db.selectFrom('messages').select('body').where('kind', '=', 'system').execute()).filter(row => row.body.includes('85 %')).length, 1);
    await turns.finish(second.turnId, 'w1', second.leaseToken, { state: 'completed', summary: 'Checkpoint.', costMinor: 200 });

    // 105 % of the budget: new work waits, a reply to a human still runs, and nobody is warned twice.
    await turns.enqueue({ agentId: agent('Ada'), projectId, kind: 'work', taskId });
    await turns.enqueue({ agentId: agent('Ada'), projectId, kind: 'reply' });
    assert.equal((await turns.claim(worker(projectId)))?.kind, 'reply');
    assert.equal(await turns.claim(worker(projectId)), null);
    assert.equal((await storage.db.selectFrom('work_items').select('defer_reason').where('state', '=', 'queued').executeTakeFirstOrThrow()).defer_reason, 'over-budget');
    assert.equal((await warnings()).length, 1);
  } finally { await storage.close(); }
});

test('moving to the fallback provider is said once a day, in the discussion, when a turn actually starts there', async () => {
  const { storage, turns, docs, projectId, agent, tick } = await boot();
  try {
    const db = storage.db, bram = agent('Bram');
    await docs.save('cost_rules', RULES_SCOPE, RULES_SLUG, { dailyCap: { fallbackProvider: 'spare' } }, { author: 'test' });
    await db.updateTable('agents').set({ daily_cap_minor: 100 }).where('id', '=', bram).execute();
    await db.insertInto('cost_daily').values({ day: '2026-05-10', project_id: projectId, agent_id: bram, amount_minor: 150, tokens: 10 }).execute();
    const said = async () => (await db.selectFrom('messages').select('body').where('kind', '=', 'system').execute()).map(row => row.body).filter(body => body.includes('spending cap'));
    const noticed = async () => (await db.selectFrom('events').select('type').where('type', '=', 'cap.fallback').where('agent_id', '=', bram).execute()).length;

    // A reply to a person ignores the cap, so nothing is said about it.
    await turns.enqueue({ agentId: bram, projectId, kind: 'reply' });
    const reply = (await turns.claim(worker(projectId)))!;
    assert.equal(reply.model, 'main-model');
    await turns.finish(reply.turnId, 'w1', reply.leaseToken, { state: 'completed' });
    assert.deepEqual([await said(), await noticed()], [[], 0]);

    for (const round of [1, 2]) {
      await turns.enqueue({ agentId: bram, projectId, kind: 'feedback' });
      const turn = (await turns.claim(worker(projectId)))!;
      assert.equal(turn.model, 'spare-model', `round ${round}`);
      await turns.finish(turn.turnId, 'w1', turn.leaseToken, { state: 'completed' });
      assert.deepEqual([await said(), await noticed()], [['Bram has reached today’s spending cap and works on spare for the rest of the day.'], 1], `round ${round}`);
    }

    // The next day it is over its cap again, and that is said again.
    tick(24 * 3600_000);
    await db.insertInto('cost_daily').values({ day: '2026-05-11', project_id: projectId, agent_id: bram, amount_minor: 150, tokens: 10 }).execute();
    await turns.enqueue({ agentId: bram, projectId, kind: 'feedback' });
    assert.equal((await turns.claim(worker(projectId)))?.model, 'spare-model');
    assert.deepEqual([(await said()).length, await noticed()], [2, 2]);
  } finally { await storage.close(); }
});

test('idle is announced once per idle period', async () => {
  const { storage, turns, projectId, agent } = await boot();
  try {
    const idles = async () => (await storage.db.selectFrom('events').select('type').where('type', '=', 'agent.idle').where('agent_id', '=', agent('Cleo')).execute()).length;
    for (const expected of [1, 2]) {
      await turns.enqueue({ agentId: agent('Cleo'), projectId, kind: 'reply' });
      await turns.enqueue({ agentId: agent('Cleo'), projectId, kind: 'feedback' });
      const one = (await turns.claim(worker(projectId)))!;
      await turns.finish(one.turnId, 'w1', one.leaseToken, { state: 'completed' });
      assert.equal(await idles(), expected - 1);
      const two = (await turns.claim(worker(projectId)))!;
      await turns.finish(two.turnId, 'w1', two.leaseToken, { state: 'completed' });
      assert.equal(await idles(), expected);
    }
  } finally { await storage.close(); }
});
