import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '@agent-team/storage';
import { createContext } from '../context.ts';
import { createWorkspace } from '../repos/workspace.ts';
import { createNeedsYou } from './needsYou.ts';
import { createTurns } from './turns.ts';

test('what holds the team up and no agent can put right is one item each, and goes when its cause does', async () => {
  const storage = await createStorage({ kind: 'sqlite', path: ':memory:' });
  await storage.migrate();
  let clock = 1_800_000_000_000;
  const context = createContext({ storage, machineToken: 'x'.repeat(24), now: () => clock });
  const db = storage.db;
  try {
    const projectId = await createWorkspace(context).registerProject({ slug: 'shop', name: 'Shop', kind: 'repo', manifest: {} });
    const agent = (await db.selectFrom('agents').select('id').where('is_pm', '=', false).executeTakeFirstOrThrow()).id;
    const needsYou = createNeedsYou(context, createTurns(context));
    const system = async () => (await needsYou.list()).filter(item => item.kind === 'system').map(item => item.id).sort();
    const item = (id: string, reason: string | null) => ({ id, agent_id: agent, project_id: projectId, kind: 'work', lane: 'work', task_id: null, thread_id: null, priority_class: 5, state: 'queued', defer_reason: reason, not_before: null, dedupe_key: id, cause_event_id: null, created_at: clock });
    await db.insertInto('work_items').values([item('w1', null), item('w2', 'over-budget'), item('w3', 'over-budget')]).execute();
    assert.deepEqual(await system(), [], 'work that has only just been queued is no problem yet');

    clock += 11 * 60_000;
    assert.deepEqual(await system(), [`no-worker:${projectId}`, `over-budget:${projectId}`]);
    const budget = (await needsYou.list()).find(found => found.id === `over-budget:${projectId}`)!;
    assert.match(budget.detail, /^2 turns wait: raise the budget/);

    // A worker serving the project takes the first away; the budget still holds two turns.
    await db.insertInto('workers').values({ id: 'w-1', name: 'laptop', lanes: '{}', isolation: 'isolated', providers: '[]', projects: JSON.stringify([projectId]), last_seen_at: clock }).execute();
    assert.deepEqual(await system(), [`over-budget:${projectId}`]);

    // A tool signed out, and a sync that stopped answering.
    await db.insertInto('providers').values({ id: 'p1', name: 'Claude subscription', kind: 'subscription', engine: 'claude', billing: 'subscription', engine_config: '{}', models: '["sonnet"]', limits: '{}', status: 'connected', status_detail: null }).execute();
    await db.insertInto('turns').values({ id: 't1', work_item_id: 'w1', agent_id: agent, project_id: projectId, task_id: null, kind: 'work', lane: 'work', access: 'write', state: 'failed', stop_reason: 'auth', worker_id: 'laptop', lease_token_hash: 'h', lease_until: clock, grants: '{}', summary: null, tokens_in: 0, tokens_out: 0, cost_minor: 0, started_at: clock, finished_at: clock, provider_id: 'p1', model: null, session_id: null, context_mode: 'packet', git_admin: false } as never).execute();
    await db.insertInto('sync_cursors').values({ scope_id: projectId, resource: 'tracker', cursor: null, last_ok_at: null, error: 'Linear did not accept the API key (401)', failing_since: clock - 20 * 60_000 }).execute();
    assert.deepEqual(await system(), [`over-budget:${projectId}`, 'signed-out:p1', `sync:${projectId}:tracker`]);
    const sync = (await needsYou.list()).find(found => found.id.startsWith('sync:'))!;
    assert.deepEqual([sync.title, sync.detail], ['The task board sync of Shop is failing', 'Linear did not accept the API key (401)']);
  } finally { await storage.close(); }
});
