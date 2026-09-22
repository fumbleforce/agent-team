import test from 'node:test';
import assert from 'node:assert/strict';
import { seedDemo } from '../demo/seed.ts';
import { startCoordinator } from '../server.ts';
import { isOpenWeight, modelFamily } from '../../../../adapters/engine/providers.ts';
import { createScorecard, FIGURE_IDS, formatFigure, median, percentile, sameFinding, type Scorecard } from './scorecard.ts';
import { printScorecard } from './scorecardText.ts';

const start = () => startCoordinator({ port: 0, storage: { kind: 'sqlite', path: ':memory:' }, machineToken: 'x'.repeat(24), webRoot: null });

test('medians and percentiles of nothing are nothing, not zero', () => {
  assert.equal(median([]), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(percentile([], 90), null);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
});

test('an empty project has a scorecard of unmeasured figures, never zeros that read as good', async () => {
  const coordinator = await start();
  try {
    const card = await createScorecard(coordinator.context).compute('no-such-project');
    const byId = Object.fromEntries(card.figures.map(item => [item.id, item]));
    for (const id of ['A1', 'A2', 'P1', 'P3', 'P5', 'D1', 'O2', 'T3', 'C1', 'C2', 'C3']) {
      assert.equal(byId[id]!.value, null, id);
      assert.equal(byId[id]!.met, null, id);
      assert.equal(formatFigure(byId[id]!), 'not measured');
    }
    // Counts of bad things are truly zero when there is nothing.
    assert.equal(byId.A3!.value, 0);
    assert.equal(byId.S2!.value, 0);
  } finally { await coordinator.close(); }
});

test('the figures are counted from what is recorded: who acted, how long it took, the gap between turns, what it cost', async () => {
  const coordinator = await start();
  try {
    await seedDemo(coordinator.context, { activity: true });
    const { context } = coordinator, db = context.storage.db, now = context.now();
    const project = await db.selectFrom('projects').select('id').where('slug', '=', 'checkout-v2').executeTakeFirstOrThrow();
    const agent = await db.selectFrom('agents').select('id').executeTakeFirstOrThrow();
    const worker = { id: 'sc-worker' };
    await db.insertInto('workers').values({ id: worker.id, name: worker.id, lanes: '{}', isolation: 'isolated', providers: '[]', projects: '[]', last_seen_at: now }).execute();
    const hour = 3600_000;
    const task = (id: string, state: string, created: number, updated: number) => ({ id, project_id: project.id, key: id.toUpperCase(), source: 'internal', title: id, brief: '', tag: null, priority: 3, milestone_id: null, state, assignee_agent_id: agent.id, author_agent_id: null, branch: null, head_sha: null, pr_url: null, blocked_reason: null, created_at: created, updated_at: updated });
    await db.deleteFrom('cost_entries').execute();
    await db.insertInto('tasks').values([task('sc-1', 'done', now - 10 * hour, now - 6 * hour), task('sc-2', 'done', now - 9 * hour, now - 1 * hour), task('sc-3', 'in_progress', now - 5 * hour, now - 2 * hour)] as never).execute();
    const turn = (id: string, taskId: string, startedAt: number, finishedAt: number) => ({ id, work_item_id: `w-${id}`, agent_id: agent.id, project_id: project.id, task_id: taskId, kind: 'work', lane: 'work', access: 'write', state: 'completed', stop_reason: null, worker_id: worker.id, lease_token_hash: 'h', lease_until: finishedAt, grants: '{}', summary: 'did it', tokens_in: 1000, tokens_out: 100, cost_minor: 50, started_at: startedAt, finished_at: finishedAt, provider_id: null, model: 'open/model', session_id: null, context_mode: 'packet', git_admin: false });
    const item = (id: string, taskId: string) => ({ id: `w-${id}`, agent_id: agent.id, project_id: project.id, kind: 'work', lane: 'work', task_id: taskId, thread_id: null, priority_class: 5, state: 'done', defer_reason: null, not_before: null, dedupe_key: `k-${id}`, cause_event_id: null, created_at: now - 10 * hour });
    const runs = [['t1', 'sc-1', now - 10 * hour, now - 9 * hour], ['t2', 'sc-1', now - 9 * hour + 600_000, now - 8 * hour], ['t3', 'sc-2', now - 9 * hour, now - 8 * hour]] as const;
    await db.insertInto('work_items').values(runs.map(([id, taskId]) => item(id, taskId)) as never).execute();
    await db.insertInto('turns').values(runs.map(([id, taskId, startedAt, finishedAt]) => turn(id, taskId, startedAt, finishedAt)) as never).execute();
    await db.insertInto('cost_entries').values(runs.map(([id]) => ({ id: `c-${id}`, turn_id: id, agent_id: agent.id, project_id: project.id, provider_id: null, billing_kind: 'metered', tokens_in: 1000, tokens_out: 100, amount_minor: 50, currency: 'USD', at: now - 8 * hour, rate: 1, usd_minor: 50 })) as never).execute();
    // A person pushed sc-2 along by hand.
    const user = await db.selectFrom('users').select('id').executeTakeFirstOrThrow();
    await context.storage.transaction(tx => context.events.append(tx, [{ type: 'task.state_changed', actorKind: 'user', userId: user.id, projectId: project.id, taskId: 'sc-2', payload: { from: 'blocked', to: 'in_progress' } }]));

    const card = await createScorecard(context, { openWeight: model => model === 'open/model' }).compute(project.id, { from: now - 12 * hour, to: now });
    const byId = Object.fromEntries(card.figures.map(entry => [entry.id, entry]));
    // The demo's own finished tasks are in the period too, so the figures are checked through what the three added tasks must contribute.
    assert.ok(byId.A1!.sample >= 2);
    assert.ok(byId.A2!.value! > 0, 'the hand on sc-2 is counted');
    assert.ok(byId.P3!.sample >= 1 && byId.P3!.value !== null);
    assert.ok(byId.T3!.value! > 0 && byId.T3!.value! <= 1, 'tokens on the model named open-weight are counted as such');
    assert.ok(byId.P4!.value! > 0);
    // sc-3 is in progress, untouched for two hours, with nothing queued, nobody awaited and no reason given.
    assert.ok(byId.A3!.value! >= 1);
    assert.ok(byId.O1!.value! < 1);
    assert.equal(byId.A3!.met, false);
  } finally { await coordinator.close(); }
});

test('the gap between turns of one task is measured exactly', async () => {
  const coordinator = await start();
  try {
    await seedDemo(coordinator.context, { activity: true });
    const { context } = coordinator, db = context.storage.db, now = context.now();
    const projectId = 'gap-project';
    await db.insertInto('projects').values({ ...(await db.selectFrom('projects').selectAll().where('slug', '=', 'checkout-v2').executeTakeFirstOrThrow()), id: projectId, slug: 'gap-project', name: 'Gap' } as never).execute();
    const agent = await db.selectFrom('agents').select('id').executeTakeFirstOrThrow();
    const worker = { id: 'sc-worker' };
    await db.insertInto('workers').values({ id: worker.id, name: worker.id, lanes: '{}', isolation: 'isolated', providers: '[]', projects: '[]', last_seen_at: now }).execute();
    await db.insertInto('tasks').values({ id: 'g-1', project_id: projectId, key: 'G-1', source: 'internal', title: 'g', brief: '', tag: null, priority: 3, milestone_id: null, state: 'done', assignee_agent_id: agent.id, author_agent_id: null, branch: null, head_sha: null, pr_url: null, blocked_reason: null, created_at: now - 100 * 60_000, updated_at: now - 10 * 60_000 } as never).execute();
    const rows = [['a', now - 100 * 60_000, now - 80 * 60_000], ['b', now - 72 * 60_000, now - 60 * 60_000], ['c', now - 59 * 60_000, now - 40 * 60_000]] as const;
    await db.insertInto('work_items').values(rows.map(([id]) => ({ id: `gw-${id}`, agent_id: agent.id, project_id: projectId, kind: 'work', lane: 'work', task_id: 'g-1', thread_id: null, priority_class: 5, state: 'done', defer_reason: null, not_before: null, dedupe_key: `g-${id}`, cause_event_id: null, created_at: now })) as never).execute();
    await db.insertInto('turns').values(rows.map(([id, startedAt, finishedAt]) => ({ id: `gt-${id}`, work_item_id: `gw-${id}`, agent_id: agent.id, project_id: projectId, task_id: 'g-1', kind: 'work', lane: 'work', access: 'write', state: 'completed', stop_reason: null, worker_id: worker.id, lease_token_hash: 'h', lease_until: finishedAt, grants: '{}', summary: 's', tokens_in: 0, tokens_out: 0, cost_minor: 0, started_at: startedAt, finished_at: finishedAt, provider_id: null, model: null, session_id: null, context_mode: 'packet', git_admin: false })) as never).execute();
    const card = await createScorecard(context).compute(projectId, { from: now - 200 * 60_000, to: now });
    const byId = Object.fromEntries(card.figures.map(entry => [entry.id, entry]));
    // Gaps of 8 minutes and 1 minute.
    assert.equal(byId.P3!.value, 4.5 * 60_000);
    assert.equal(byId.P3!.met, false);
    assert.equal(byId.P1!.value, 90 * 60_000);
    assert.equal(formatFigure(byId.P1!), '1.5 h');
    assert.equal(byId.A1!.value, 1);
    // 51 of 90 minutes had a turn running.
    assert.ok(Math.abs(byId.P2!.value! - 51 / 90) < 1e-9);
  } finally { await coordinator.close(); }
});

test('the scorecard is served to a signed-in reader of the project and to a machine, and prints as text', async () => {
  const TOKEN = 'machine-token-for-tests-0123456789';
  const coordinator = await startCoordinator({ port: 0, storage: { kind: 'sqlite', path: ':memory:' }, machineToken: TOKEN, webRoot: null });
  try {
    await seedDemo(coordinator.context, { activity: true });
    const machine = await fetch(`${coordinator.url}/machine/projects/checkout-v2/scorecard?days=7`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(machine.status, 200);
    const card = await machine.json() as Scorecard;
    assert.equal(Math.round((card.to - card.from) / (24 * 3600_000)), 7);
    assert.ok(card.figures.some(entry => entry.id === 'A1') && card.figures.some(entry => entry.id === 'S3'));
    assert.equal((await fetch(`${coordinator.url}/machine/projects/checkout-v2/scorecard`)).status, 401);
    assert.equal((await fetch(`${coordinator.url}/machine/projects/nope/scorecard`, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 404);
    assert.equal((await fetch(`${coordinator.url}/api/projects/checkout-v2/scorecard`)).status, 401);
    const text = printScorecard(card, 'checkout-v2');
    assert.match(text, /Scorecard for checkout-v2, last 7 days/);
    assert.match(text, /Autonomy\n {2}. A1 {2}Tasks finished with nobody acting/);
    assert.match(text, /T1 .*not measured/);
  } finally { await coordinator.close(); }
});

test('perspectives are different when seats find different things, and checkers should not share a model family', async () => {
  assert.equal(sameFinding({ path: 'src/a.ts', note: 'x' }, { path: 'src/a.ts', note: 'something else entirely' }), true);
  assert.equal(sameFinding({ note: 'The retry loop never backs off on a 429 response' }, { note: 'retry loop does not back off on 429 response' }), true);
  assert.equal(sameFinding({ note: 'The retry loop never backs off' }, { note: 'The button label is misleading' }), false);
  assert.deepEqual(['anthropic/claude-sonnet-5', 'gpt-5', 'o3-mini', 'qwen/qwen3-coder', 'mistralai/devstral-small', 'meta-llama/llama-4'].map(modelFamily), ['claude', 'gpt', 'gpt', 'qwen', 'mistral', 'llama']);
  assert.equal(isOpenWeight('qwen/qwen3-coder', 'metered'), true);
  assert.equal(isOpenWeight('anthropic/claude-sonnet-5', 'metered'), false);
  assert.equal(isOpenWeight('anything', 'local'), true);

  const coordinator = await start();
  try {
    await seedDemo(coordinator.context, { activity: true });
    const { context } = coordinator, db = context.storage.db, now = context.now();
    const project = await db.selectFrom('projects').select('id').where('slug', '=', 'checkout-v2').executeTakeFirstOrThrow();
    const [first, second] = await db.selectFrom('agents').select('id').limit(2).execute();
    const task = await db.selectFrom('tasks').select('id').where('project_id', '=', project.id).executeTakeFirstOrThrow();
    await db.deleteFrom('approvals').execute();
    await db.insertInto('workers').values({ id: 't5-worker', name: 't5', lanes: '{}', isolation: 'isolated', providers: '[]', projects: '[]', last_seen_at: now }).execute();
    const review = async (id: string, agentId: string, model: string, findings: object[]) => {
      await db.insertInto('work_items').values({ id: `wi-${id}`, agent_id: agentId, project_id: project.id, kind: 'review', lane: 'bounded', task_id: task.id, thread_id: null, priority_class: 3, state: 'done', defer_reason: null, not_before: null, dedupe_key: id, cause_event_id: null, created_at: now } as never).execute();
      await db.insertInto('turns').values({ id, work_item_id: `wi-${id}`, agent_id: agentId, project_id: project.id, task_id: task.id, kind: 'review', lane: 'bounded', access: 'read', state: 'completed', stop_reason: null, worker_id: 't5-worker', lease_token_hash: 'h', lease_until: now, grants: '{}', summary: 's', tokens_in: 0, tokens_out: 0, cost_minor: 0, started_at: now - 1000, finished_at: now, provider_id: null, model, session_id: null, context_mode: 'packet', git_admin: false } as never).execute();
      await db.insertInto('approvals').values({ id: `ap-${id}`, task_id: task.id, kind: 'review', agent_id: agentId, turn_id: id, head_sha: 'abc', verdict: 'changes', findings: JSON.stringify(findings), summary: '', state: 'valid', created_at: now } as never).execute();
    };
    await review('r1', first!.id, 'qwen/qwen3-coder', [{ severity: 'high', path: 'src/pay.ts', note: 'double charge on retry' }, { severity: 'low', note: 'The empty state has no message' }]);
    await review('r2', second!.id, 'qwen/qwen3-max', [{ severity: 'high', path: 'src/pay.ts', note: 'retry charges twice' }, { severity: 'med', note: 'No test covers a declined card' }]);
    const card = await createScorecard(context, { modelFamily }).compute(project.id, { from: now - 3600_000, to: now + 1000 });
    const byId = Object.fromEntries(card.figures.map(entry => [entry.id, entry]));
    // Four findings; the two about src/pay.ts are one finding raised twice.
    assert.deepEqual([byId.T5!.value, byId.T5!.sample, byId.T5!.met], [0.5, 4, false]);
    assert.deepEqual([byId.T7!.value, byId.T7!.sample, byId.T7!.met], [0, 1, false], 'both checkers ran on the same family');
  } finally { await coordinator.close(); }
});

test('the list of figures a trial may name is the list the scorecard computes', async () => {
  const coordinator = await start();
  try {
    const card = await createScorecard(coordinator.context).compute('none');
    assert.deepEqual(card.figures.map(entry => entry.id).sort(), [...FIGURE_IDS].sort());
  } finally { await coordinator.close(); }
});
