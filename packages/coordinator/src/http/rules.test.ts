import test from 'node:test';
import assert from 'node:assert/strict';
import { newId } from '@agent-team/protocol';
import { boot } from './testing.ts';

test('rules are versioned documents: defaults at version 0, admin-only writes, If-Match guards the version', async () => {
  const { coordinator, call, owner, person } = await boot();
  try {
    const cookie = await owner(), member = await person('mia', 'member');
    const initial = await call('/api/rules/cost_rules', { cookie });
    assert.deepEqual([initial.status, initial.json.version, initial.json.doc.budgetWarn, initial.headers.get('etag')], [200, 0, { enabled: true, percent: 80 }, '"0"']);
    assert.equal((await call('/api/rules/nonsense', { cookie })).status, 404);
    const doc = { ...initial.json.doc, budgetWarn: { enabled: false, percent: 70 } };
    assert.equal((await call('/api/rules/cost_rules', { method: 'PUT', cookie: member.cookie, body: doc })).status, 403);
    const saved = await call('/api/rules/cost_rules', { method: 'PUT', cookie, body: doc, headers: { 'if-match': '"0"' } });
    assert.deepEqual([saved.status, saved.json.version], [200, 1]);
    assert.equal((await call('/api/rules/cost_rules', { method: 'PUT', cookie, body: doc, headers: { 'if-match': '0' } })).status, 412);
    assert.equal((await call('/api/rules/cost_rules', { method: 'PUT', cookie, body: { budgetWarn: { percent: 140 } } })).status, 400);
    const routes = await call('/api/rules/routing_rules', { cookie, body: { routes: [{ id: 'reviews', kinds: ['review'], provider: 'spare' }] }, headers: { 'if-match': '0' } });
    assert.equal(routes.status, 200);
    const read = await call('/api/rules/routing_rules', { cookie: member.cookie });
    assert.deepEqual([read.json.version, read.json.doc.routes[0].enabled, (await call('/api/rules/cost_rules', { cookie })).json.doc.budgetWarn.percent], [1, true, 70]);
  } finally { await coordinator.close(); }
});

test('budgets are set, listed and removed; the export is CSV of the period for visible projects only', async () => {
  const { coordinator, db, call, owner, person, project } = await boot();
  try {
    const cookie = await owner(), shop = await project('shop'), hidden = await project('hidden'), viewer = await person('vera', 'member', { [shop]: 'viewer' });
    assert.equal((await call('/api/budgets', { method: 'PUT', cookie: viewer.cookie, body: { scope: 'org', amountMinor: 1000 } })).status, 403);
    assert.equal((await call('/api/budgets', { method: 'PUT', cookie: viewer.cookie, body: { scope: 'project', scopeId: shop, amountMinor: 1000 } })).status, 403);
    assert.equal((await call('/api/budgets', { method: 'PUT', cookie, body: { scope: 'org', amountMinor: 50_000 } })).status, 200);
    assert.equal((await call('/api/budgets', { method: 'PUT', cookie, body: { scope: 'project', scopeId: hidden, amountMinor: 9000 } })).status, 200);
    assert.equal((await call('/api/costs', { cookie })).json.budgetMinor, 50_000);
    assert.deepEqual((await call('/api/budgets', { cookie: viewer.cookie })).json.budgets, [{ scope: 'org', scopeId: '', period: 'month', amountMinor: 50_000 }]);
    assert.equal((await call('/api/budgets', { cookie })).json.budgets.length, 2);
    assert.equal((await call(`/api/budgets/project/${hidden}`, { method: 'DELETE', cookie })).status, 200);
    assert.equal((await call('/api/budgets', { method: 'PUT', cookie, body: { scope: 'org', amountMinor: null } })).status, 200);
    assert.deepEqual((await call('/api/budgets', { cookie })).json.budgets, []);

    const at = Date.now();
    const entry = (projectId: string, amount: number) => ({ id: newId(), turn_id: null, agent_id: null, project_id: projectId, provider_id: null, billing_kind: 'metered', tokens_in: 1200, tokens_out: 300, amount_minor: amount, currency: 'EUR', at });
    await db.insertInto('cost_entries').values([entry(shop, 42), entry(hidden, 77)]).execute();
    const seen = await call('/api/costs/export.csv', { cookie: viewer.cookie });
    assert.match(seen.headers.get('content-type') ?? '', /^text\/csv/);
    assert.match(seen.headers.get('content-disposition') ?? '', /attachment; filename="costs-/);
    const lines = seen.text.trim().split('\r\n');
    assert.deepEqual([lines.length, lines[0], lines[1]!.split(',').slice(1)], [2, 'at,project,agent,provider,billing_kind,tokens_in,tokens_out,amount_minor,currency,turn_id', ['shop', '', '', 'metered', '1200', '300', '42', 'EUR', '']]);
    assert.equal((await call('/api/costs/export.csv', { cookie })).text.trim().split('\r\n').length, 3);
    assert.equal((await call('/api/costs/export.csv?from=2001-01-01&to=2001-01-31', { cookie })).text.trim().split('\r\n').length, 1);
    assert.equal((await call('/api/costs/export.csv?from=yesterday', { cookie })).status, 400);
  } finally { await coordinator.close(); }
});

test('rebalance suggests moves of queued work and applies only what is still true; the workload shows defer reasons and limited providers', async () => {
  const { coordinator, db, call, owner, person } = await boot();
  try {
    const cookie = await owner();
    const created = await call('/machine/projects', { headers: { authorization: 'Bearer machine-token-for-tests-0123456789' }, body: { slug: 'shop', name: 'shop' } });
    const projectId = created.json.id as string, viewer = await person('vera', 'member', { [projectId]: 'viewer' });
    const team = (await db.selectFrom('projects').select('team_id').where('id', '=', projectId).executeTakeFirstOrThrow()).team_id ?? newId();
    if (!(await db.selectFrom('teams').select('id').where('id', '=', team).executeTakeFirst())) { await db.insertInto('teams').values({ id: team, scope: 'project', project_id: projectId, name: 'Shop', template_slug: null, template_version: null }).execute(); await db.updateTable('projects').set({ team_id: team }).where('id', '=', projectId).execute(); }
    await db.deleteFrom('agents').where('team_id', '=', team).execute();
    await db.insertInto('providers').values({ id: 'main', name: 'Main', kind: 'metered', engine: 'fake', billing: 'metered', engine_config: '{}', models: '["m"]', limits: '{}', status: 'connected', status_detail: null, limited_until: Date.now() + 600_000 }).execute();
    const seat = (name: string, sort: number) => ({ id: `agent-${name}`, team_id: team, name, initials: name.slice(0, 2), tint: '1', title: 'Engineer', persona: '', status: 'active', provider_id: name === 'ada' ? 'main' : null, model: null, daily_cap_minor: null, is_pm: false, doing: null, sort, created_at: 1 });
    await db.insertInto('agents').values([seat('ada', 0), seat('bram', 1)]).execute();
    for (let n = 0; n < 4; n += 1) {
      const taskId = newId();
      await db.insertInto('tasks').values({ id: taskId, project_id: projectId, key: `S-${n}`, source: 'internal', title: `Task ${n}`, brief: '', tag: null, priority: n, milestone_id: null, state: 'assigned', assignee_agent_id: 'agent-ada', author_agent_id: null, branch: null, head_sha: null, pr_url: null, blocked_reason: null, created_at: 1, updated_at: 1 }).execute();
      await db.insertInto('work_items').values({ id: `item-${n}`, agent_id: 'agent-ada', project_id: projectId, kind: 'work', lane: 'work', task_id: taskId, thread_id: null, priority_class: 5, state: 'queued', defer_reason: n === 0 ? 'provider-limited' : null, not_before: null, dedupe_key: null, cause_event_id: null, created_at: 10 + n }).execute();
    }

    const workload = await call('/api/projects/shop/workload', { cookie });
    assert.deepEqual([workload.json.lanes[0].queued[0].deferReason, workload.json.lanes[0].agent.limitedUntil > Date.now(), workload.json.lanes[1].agent.limitedUntil], ['provider-limited', true, null]);

    assert.equal((await call('/api/projects/shop/workload/rebalance', { cookie: viewer.cookie })).status, 403);
    const suggested = await call('/api/projects/shop/workload/rebalance', { cookie });
    assert.deepEqual(suggested.json.moves.map((move: { workItemId: string; fromName: string; toName: string; key: string }) => [move.workItemId, move.fromName, move.toName, move.key]), [['item-3', 'ada', 'bram', 'S-3'], ['item-2', 'ada', 'bram', 'S-2']]);
    assert.deepEqual((await call('/api/projects/shop/workload/rebalance', { cookie })).json, suggested.json);

    // Between suggest and apply one item started: it stays where it is.
    await db.updateTable('work_items').set({ state: 'leased' }).where('id', '=', 'item-3').execute();
    const moves = suggested.json.moves.map((move: { workItemId: string; fromAgentId: string; toAgentId: string }) => ({ workItemId: move.workItemId, fromAgentId: move.fromAgentId, toAgentId: move.toAgentId }));
    assert.equal((await call('/api/projects/shop/workload/rebalance', { cookie: viewer.cookie, body: { moves } })).status, 403);
    assert.deepEqual((await call('/api/projects/shop/workload/rebalance', { cookie, body: { moves } })).json, { applied: 1, skipped: ['item-3'] });
    const owners = await db.selectFrom('work_items').innerJoin('tasks', 'tasks.id', 'work_items.task_id').select(['work_items.id', 'work_items.agent_id', 'tasks.assignee_agent_id']).orderBy('work_items.id').execute();
    assert.deepEqual(owners.map(row => [row.id, row.agent_id, row.assignee_agent_id]), [['item-0', 'agent-ada', 'agent-ada'], ['item-1', 'agent-ada', 'agent-ada'], ['item-2', 'agent-bram', 'agent-bram'], ['item-3', 'agent-ada', 'agent-ada']]);
    assert.equal((await db.selectFrom('events').select('type').where('type', '=', 'work_item.moved').execute()).length, 1);
    assert.equal((await call('/api/projects/shop/workload/rebalance', { cookie, body: { moves: [{ workItemId: 'item-1', fromAgentId: 'agent-ada', toAgentId: 'agent-elsewhere' }] } })).status, 400);
  } finally { await coordinator.close(); }
});
