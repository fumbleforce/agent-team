import test from 'node:test';
import assert from 'node:assert/strict';
import { CostRules, RoutingRules, type TurnKind } from '@agent-team/protocol';
import { AGING_MS, effectiveClass, enqueue, gate, idleFires, laneOf, pick, type Snapshot, type TurnDraft } from './scheduler.ts';
import { suggest } from './rebalance.ts';

const T0 = 1_000_000_000;
let serial = 0;
const item = (agentId: string, kind: TurnKind, over: Partial<TurnDraft> = {}): TurnDraft => ({ id: `i${String(serial += 1).padStart(4, '0')}`, agentId, projectId: 'p', kind, lane: laneOf(kind), taskId: null, priorityClass: enqueue({ kind, agentId }, { liveDedupeKeys: new Set() })!.priorityClass, createdAt: T0, ...over });
const agent = (over: Partial<Snapshot['agents'][string]> = {}) => ({ status: 'active', providerId: 'main', model: 'm1', dailyCapMinor: null, spentTodayMinor: 0, lastStartedAt: 0, ...over });
const provider = (id: string, over: Partial<Snapshot['providers'][string]> = {}) => ({ id, name: id, status: 'connected', models: [`${id}-model`], limitedUntil: null, running: 0, maxConcurrent: null, windowPct: null, ...over });
const task = (over: Partial<Snapshot['tasks'][string]> = {}) => ({ state: 'assigned', tags: [], difficulty: null, quarantined: false, writerRunning: false, holder: null, sticky: null, ...over });
const project = (over: Partial<Snapshot['projects'][string]> = {}) => ({ status: 'active', budgetPct: null, budget: null, warned: false, deliveryBusy: false, ...over });
const world = (over: Partial<Snapshot> = {}): Snapshot => ({ now: T0, items: [], agents: { a: agent(), b: agent() }, tasks: { t: task() }, providers: { main: provider('main'), spare: provider('spare') }, projects: { p: project() }, running: [], rules: { cost: CostRules.parse({}), routing: RoutingRules.parse({}) }, ...over });
const claim = { workerId: 'w1', free: { work: 1, bounded: 1, deliver: 1 }, projects: ['p'] };

test('enqueue: dedupe absorbs a second wake, continuing outranks starting', () => {
  assert.equal(enqueue({ kind: 'feedback', agentId: 'a', dedupeKey: 'k' }, { liveDedupeKeys: new Set(['k']) }), null);
  const cases: [TurnKind, { state: string; assigneeAgentId: string | null } | null, number, string][] = [
    ['reply', null, 1, 'bounded'], ['conclude', null, 2, 'bounded'], ['revise', null, 2, 'bounded'], ['review', null, 3, 'bounded'], ['feedback', null, 3, 'bounded'],
    ['work', { state: 'in_progress', assigneeAgentId: 'a' }, 4, 'work'], ['work', { state: 'in_progress', assigneeAgentId: 'b' }, 5, 'work'], ['work', { state: 'assigned', assigneeAgentId: 'a' }, 5, 'work'],
    ['retro', null, 6, 'bounded'], ['ideate', null, 6, 'bounded'], ['deliver', null, 4, 'deliver'],
  ];
  for (const [kind, taskRow, priorityClass, lane] of cases) assert.deepEqual(enqueue({ kind, agentId: 'a' }, { liveDedupeKeys: new Set(), task: taskRow }), { lane, priorityClass }, kind);
});

test('aging: one class per 30 minutes, never above class 2, classes 1 and 2 never move', () => {
  const cases: [number, number, number][] = [[6, 0, 6], [6, 29, 6], [6, 30, 5], [6, 60, 4], [6, 120, 2], [6, 600, 2], [5, 90, 2], [3, 30, 2], [3, 300, 2], [2, 300, 2], [1, 300, 1]];
  for (const [priorityClass, minutes, expected] of cases) assert.equal(effectiveClass({ priorityClass, createdAt: T0 }, T0 + minutes * 60_000), expected, `${priorityClass} after ${minutes} min`);
  // An old retro overtakes fresh new work but never a fresh reply.
  const retro = item('a', 'retro'), work = item('b', 'work', { createdAt: T0 + 3 * AGING_MS }), reply = item('b', 'reply', { createdAt: T0 + 3 * AGING_MS });
  assert.equal(pick(world({ now: T0 + 3 * AGING_MS, items: [work, retro] }), claim).picked?.item.id, retro.id);
  assert.equal(pick(world({ now: T0 + 3 * AGING_MS, items: [work, retro, reply] }), claim).picked?.item.id, reply.id);
});

test('gate: every refusal has its typed reason', () => {
  const work = item('a', 'work', { taskId: 't' }), feedback = item('a', 'feedback'), deliver = item('a', 'deliver', { taskId: 't' }), reply = item('a', 'reply');
  const cases: [string, TurnDraft, Partial<Snapshot>, string | null][] = [
    ['open', work, {}, null],
    ['agent paused', work, { agents: { a: agent({ status: 'paused' }) } }, 'agent-paused'],
    ['task blocked', work, { tasks: { t: task({ state: 'blocked' }) } }, 'task-blocked'],
    ['task stopped', work, { tasks: { t: task({ state: 'stopped' }) } }, 'task-blocked'],
    ['task done', work, { tasks: { t: task({ state: 'done' }) } }, 'task-closed'],
    ['task quarantined', work, { tasks: { t: task({ quarantined: true }) } }, 'task-quarantined'],
    ['lane busy', work, { running: [{ agentId: 'a', lane: 'work' }] }, 'lane-busy'],
    ['other lane free', feedback, { running: [{ agentId: 'a', lane: 'work' }] }, null],
    ['one writer per task', work, { tasks: { t: task({ writerRunning: true }) } }, 'writer-busy'],
    ['one delivery per project', deliver, { projects: { p: project({ deliveryBusy: true }) } }, 'delivery-busy'],
    ['provider unknown', work, { providers: {} }, 'provider-unavailable'],
    ['provider disconnected', work, { providers: { main: provider('main', { status: 'error' }) } }, 'provider-unavailable'],
    ['provider limited', work, { providers: { main: provider('main', { limitedUntil: T0 + 1 }) } }, 'provider-limited'],
    ['provider limit lapsed', work, { providers: { main: provider('main', { limitedUntil: T0 }) } }, null],
    ['provider at concurrency', work, { providers: { main: provider('main', { running: 2, maxConcurrent: 2 }) } }, 'provider-busy'],
    ['provider window full', work, { providers: { main: provider('main', { windowPct: 100 }) } }, 'provider-window'],
    ['agent over cap', work, { agents: { a: agent({ dailyCapMinor: 100, spentTodayMinor: 100 }) } }, 'over-cap'],
    ['reply ignores the cap', reply, { agents: { a: agent({ dailyCapMinor: 100, spentTodayMinor: 100 }) } }, null],
    ['budget spent', work, { projects: { p: project({ budgetPct: 100, warned: true }) } }, 'over-budget'],
    ['budget spent, reply runs', reply, { projects: { p: project({ budgetPct: 140, warned: true }) } }, null],
    ['budget spent, conclude runs', item('a', 'conclude'), { projects: { p: project({ budgetPct: 140, warned: true }) } }, null],
    ['another live worker holds the worktree', work, { tasks: { t: task({ holder: 'w2' }) }, claim }, 'no-worktree-holder'],
    ['this worker holds the worktree', work, { tasks: { t: task({ holder: 'w1' }) }, claim }, null],
    ['a read turn needs no holder', item('a', 'review', { taskId: 't' }), { tasks: { t: task({ holder: 'w2' }) }, claim }, null],
  ];
  for (const [name, draft, over, expected] of cases) {
    const result = gate(draft, world(over));
    assert.equal(result.ok ? null : result.deferReason, expected, name);
  }
});

test('an aged item still obeys the budget by its own class', () => {
  const old = item('a', 'work', { createdAt: T0 - 10 * AGING_MS });
  const result = pick(world({ items: [old], projects: { p: project({ budgetPct: 100, warned: true }) } }), claim);
  assert.deepEqual([result.picked, result.deferrals], [null, [{ id: old.id, reason: 'over-budget' }]]);
});

test('pick: class first, then the agent that has waited longest, then age; refusals ahead of the pick are reported', () => {
  const first = item('a', 'work'), second = item('b', 'work', { createdAt: T0 + 5 });
  // Same class: b has gone longer without a turn, so b goes first although its item is newer.
  assert.equal(pick(world({ items: [first, second], agents: { a: agent({ lastStartedAt: 900 }), b: agent({ lastStartedAt: 100 }) } }), claim).picked?.item.id, second.id);
  assert.equal(pick(world({ items: [first, second] }), claim).picked?.item.id, first.id);
  const blocked = item('a', 'reply'), result = pick(world({ items: [first, second, blocked], agents: { a: agent({ status: 'paused' }), b: agent() } }), claim);
  assert.equal(result.picked?.item.id, second.id);
  assert.deepEqual(result.deferrals, [{ id: blocked.id, reason: 'agent-paused' }, { id: first.id, reason: 'agent-paused' }]);
  // The worker's free lanes and projects are filters, not deferrals.
  assert.deepEqual(pick(world({ items: [first] }), { ...claim, free: { bounded: 1 } }), { picked: null, deferrals: [], notices: [] });
  assert.equal(pick(world({ items: [first] }), { ...claim, projects: ['other'] }).picked, null);
});

test('fairness over a run: agents with equal queues alternate', () => {
  const state = world({ items: [...Array(3)].flatMap(() => [item('a', 'feedback'), item('b', 'feedback')]).sort((x, y) => x.agentId.localeCompare(y.agentId)) });
  const order: string[] = [];
  for (let step = 1; state.items.length > 0; step += 1) {
    state.now = T0 + step * 1000;
    const picked = pick(state, claim).picked!;
    order.push(picked.item.agentId);
    state.items = state.items.filter(other => other.id !== picked.item.id);
    state.agents[picked.item.agentId]!.lastStartedAt = state.now;
  }
  assert.deepEqual(order, ['a', 'b', 'a', 'b', 'a', 'b']);
});

test('idle fires once per idle period', () => {
  const cases: [number, number | null, boolean][] = [[1, null, false], [0, null, true], [0, T0, false], [2, T0, false]];
  for (const [liveItems, idleAt, fires] of cases) assert.equal(idleFires({ liveItems, idleAt }), fires);
});

test('rebalance.suggest is deterministic, levels queued work and never moves started or running work', () => {
  const queued = [1, 2, 3, 4, 5].map(n => ({ id: `q${n}`, agentId: 'a', priorityClass: 5, createdAt: T0 + n, started: n === 5 }));
  const seats = [{ id: 'b', active: true, running: 0 }, { id: 'a', active: true, running: 1 }, { id: 'c', active: false, running: 0 }];
  const moves = suggest(seats, queued);
  assert.deepEqual(moves, [{ workItemId: 'q4', fromAgentId: 'a', toAgentId: 'b' }, { workItemId: 'q3', fromAgentId: 'a', toAgentId: 'b' }, { workItemId: 'q2', fromAgentId: 'a', toAgentId: 'b' }]);
  assert.deepEqual(suggest([...seats].reverse(), [...queued].reverse()), moves);
  assert.deepEqual(suggest(seats, queued.map(row => ({ ...row, started: true }))), []);
  assert.deepEqual(suggest([{ id: 'a', active: true, running: 0 }], queued), []);
});

test('gate: a merge runs no model, so a full, limited, switched-off or spent-out provider never holds it back', () => {
  const deliver = item('a', 'deliver', { taskId: 't' }), review = item('a', 'review', { taskId: 't' });
  const hostile: Partial<Snapshot>[] = [
    { providers: { main: provider('main', { running: 2, maxConcurrent: 2 }) } },
    { providers: { main: provider('main', { limitedUntil: T0 + 60_000 }) } },
    { providers: { main: provider('main', { status: 'paused' }) } },
    { providers: { main: provider('main', { windowPct: 100 }) } },
    { projects: { p: project({ budgetPct: 100 }) } },
  ];
  for (const over of hostile) {
    const verdict = gate(deliver, world({ tasks: { t: task({ state: 'approved' }) }, ...over }));
    assert.deepEqual([verdict.ok, verdict.ok ? verdict.route : null], [true, { providerId: null, model: null }], JSON.stringify(over));
  }
  // The same conditions do hold a turn that runs a model.
  assert.equal(gate(review, world({ providers: { main: provider('main', { running: 2, maxConcurrent: 2 }) } })).ok, false);
  // What a merge still waits for is another merge of the same project.
  const busy = gate(deliver, world({ projects: { p: project({ deliveryBusy: true }) } }));
  assert.deepEqual([busy.ok, busy.ok ? null : busy.deferReason], [false, 'delivery-busy']);
});

test('a turn goes only to a worker that has its provider\'s tool; a worker that says nothing is not held to it', () => {
  const work = item('a', 'work', { taskId: 't' });
  const snapshot = world({ items: [work], providers: { main: provider('main', { engine: 'codex' }), spare: provider('spare') } });
  const without = pick(snapshot, { ...claim, ready: { engines: ['claude'] } });
  assert.equal(without.picked, null);
  assert.deepEqual(without.deferrals.map(row => row.reason), ['engine-missing']);
  assert.equal(pick(snapshot, { ...claim, ready: { engines: ['claude', 'codex'] } }).picked?.item.id, work.id);
  assert.equal(pick(snapshot, claim).picked?.item.id, work.id, 'an older worker that reports nothing still gets the turn');
});
