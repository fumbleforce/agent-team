import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '@agent-team/storage';
import { createContext } from '../context.ts';
import { createWorkspace } from '../repos/workspace.ts';
import { createReviews } from './reviews.ts';
import { createTurns } from './turns.ts';

const SHA1 = 'a'.repeat(40), SHA2 = 'b'.repeat(40);

async function boot() {
  const storage = await createStorage({ kind: 'sqlite', path: ':memory:' });
  await storage.migrate();
  const context = createContext({ storage, machineToken: 'x'.repeat(24) });
  const db = storage.db;
  const projectId = await createWorkspace(context).registerProject({ slug: 'shop', name: 'Shop', kind: 'repo', manifest: {} });
  const agents = Object.fromEntries((await db.selectFrom('agents').select(['id', 'name']).execute()).map(agent => [agent.name, agent.id])) as Record<string, string>;
  const taskId = 'task-1';
  await db.insertInto('tasks').values({ id: taskId, project_id: projectId, key: 'GH-1', source: 'tracker', title: 'T', brief: '', tag: null, priority: 0, milestone_id: null, state: 'in_progress', assignee_agent_id: agents.Ada!, author_agent_id: null, branch: null, head_sha: null, pr_url: null, blocked_reason: null, created_at: 1, updated_at: 1 }).execute();
  const turns = createTurns(context);
  const turn = (name: string, kind = 'review') => ({ id: `turn-${name}`, agent_id: agents[name]!, task_id: taskId, kind });
  const verdict = (kind: 'tester' | 'reviewer' | 'pm', value: 'pass' | 'changes' = 'pass', headSha = SHA1) => ({ kind, verdict: value, headSha, summary: 'ok', findings: [] });
  return { storage, db, reviews: createReviews(context, turns), agents, taskId, turn, verdict };
}

test('a review asks one reviewer, never the author and not the PM; its pass at the head approves and queues the merge under the PM', async () => {
  const { storage, db, reviews, agents, taskId, turn, verdict } = await boot();
  const teamId = (await db.selectFrom('agents').select('team_id').where('id', '=', agents.Rune!).executeTakeFirstOrThrow()).team_id;
  await db.insertInto('agents').values({ id: 'bram', team_id: teamId, name: 'Bram', initials: 'BR', tint: '2', title: 'Developer', persona: '', status: 'active', provider_id: null, model: null, daily_cap_minor: null, is_pm: false, doing: null, sort: 9, created_at: 1 }).execute();
  await db.insertInto('agent_roles').values({ agent_id: 'bram', role_slug: 'developer' }).execute();
  const asked = await reviews.request(taskId, SHA1);
  assert.deepEqual(asked, [{ kind: 'reviewer', agentId: agents.Rune }]);
  assert.deepEqual((await db.selectFrom('work_items').select('agent_id').where('kind', '=', 'review').execute()).map(item => item.agent_id), [agents.Rune]);

  await assert.rejects(reviews.record(turn('Ada'), verdict('reviewer')), /author/);
  await assert.rejects(reviews.record({ ...turn('Rune'), agent_id: 'bram' }, verdict('reviewer')), /do not hold/);
  await assert.rejects(reviews.record(turn('Rune', 'work'), verdict('reviewer')), /review turn/);
  await assert.rejects(reviews.record(turn('Rune'), verdict('reviewer', 'pass', SHA2)), /review that revision/);

  // An older prompt that still names another kind records the one review.
  assert.deepEqual(await reviews.record(turn('Rune'), verdict('tester')), { approved: true });
  assert.equal((await db.selectFrom('tasks').select('state').where('id', '=', taskId).executeTakeFirstOrThrow()).state, 'approved');
  const queued = await db.selectFrom('merge_queue').select(['state', 'head_sha']).executeTakeFirstOrThrow();
  assert.deepEqual([queued.state, queued.head_sha], ['queued', SHA1]);
  assert.equal((await db.selectFrom('work_items').select('agent_id').where('kind', '=', 'deliver').executeTakeFirstOrThrow()).agent_id, agents.Maren);
  const gate = await reviews.approvalsFor(taskId, SHA1) as Record<string, { verdict: string; sessionId: string }>;
  assert.deepEqual(Object.keys(gate), ['reviewer']);
  assert.deepEqual([gate.reviewer!.verdict, gate.reviewer!.sessionId], ['APPROVE', 'turn-Rune']);
  assert.deepEqual((await reviews.deliveryFor(taskId)).approvalRoles, ['reviewer']);
  await storage.close();
});

test('a team made before there was one reviewer has its tester, else its PM, stand in as the one reviewer', async () => {
  const { storage, db, reviews, agents, taskId } = await boot();
  await db.updateTable('agent_roles').set({ role_slug: 'tester' }).where('agent_id', '=', agents.Rune!).execute();
  assert.deepEqual(await reviews.request(taskId, SHA1), [{ kind: 'reviewer', agentId: agents.Rune }]);
  await db.updateTable('agents').set({ status: 'retired' }).where('id', '=', agents.Rune!).execute();
  assert.deepEqual(await reviews.request(taskId, SHA2), [{ kind: 'reviewer', agentId: agents.Maren }]);
  await storage.close();
});

test('requested changes send the task back to its author; a new head makes the earlier verdict stale', async () => {
  const { storage, db, reviews, agents, taskId, turn, verdict } = await boot();
  await reviews.request(taskId, SHA1);
  await reviews.record(turn('Rune'), verdict('reviewer', 'changes'));
  assert.equal((await db.selectFrom('tasks').select('state').where('id', '=', taskId).executeTakeFirstOrThrow()).state, 'in_progress');
  assert.equal((await db.selectFrom('work_items').select('agent_id').where('kind', '=', 'work').executeTakeFirstOrThrow()).agent_id, agents.Ada);

  await reviews.request(taskId, SHA2);
  assert.deepEqual(await reviews.approvalsFor(taskId, SHA2), {});
  assert.equal((await db.selectFrom('approvals').select('state').where('state', '=', 'stale').execute()).length, 1);
  await assert.rejects(reviews.record({ ...turn('Rune'), id: 'turn-Rune-2' }, verdict('reviewer', 'pass', SHA1)), /review that revision/);
  await storage.close();
});

test('changes asked for at a third revision bring the PM in instead of sending the author round again', async () => {
  const { storage, db, reviews, agents, taskId, turn, verdict } = await boot();
  const pmTriage = async () => db.selectFrom('work_items').select('id').where('agent_id', '=', agents.Maren!).where('kind', '=', 'triage').executeTakeFirst();
  for (const [index, sha] of ['1', '2', '3'].map(digit => digit.repeat(40)).entries()) {
    await reviews.request(taskId, sha);
    await db.updateTable('work_items').set({ state: 'done' }).where('kind', '=', 'work').execute();
    await reviews.record({ ...turn('Rune'), id: `turn-Rune-${index}` }, verdict('reviewer', 'changes', sha));
    const authorQueued = await db.selectFrom('work_items').select('id').where('agent_id', '=', agents.Ada!).where('kind', '=', 'work').where('state', '=', 'queued').executeTakeFirst();
    assert.equal(Boolean(authorQueued), index < 2, `round ${index + 1}`);
  }
  assert.ok(await pmTriage(), 'the PM is asked to look at the task');
  assert.match((await db.selectFrom('messages').select('body').orderBy('created_at', 'desc').executeTakeFirstOrThrow()).body, /at three revisions/);
  await storage.close();
});

test('only the seat asked to review decides: the PM cannot approve a change beside the reviewer', async () => {
  const { storage, db, reviews, taskId, turn, verdict } = await boot();
  await reviews.request(taskId, SHA1);
  await assert.rejects(reviews.record(turn('Maren'), verdict('pm')), /Another seat reviews this task/);
  assert.equal((await db.selectFrom('approvals').select('id').execute()).length, 0);
  assert.deepEqual(await reviews.record(turn('Rune'), verdict('reviewer')), { approved: true });
  await storage.close();
});

test('what the author was given to remember is judged by the review: up when it passes, down when it is sent back', async () => {
  const { storage, db, reviews, agents, taskId, turn, verdict } = await boot();
  const projectId = (await db.selectFrom('tasks').select('project_id').where('id', '=', taskId).executeTakeFirstOrThrow()).project_id;
  await db.insertInto('memories').values({ id: 'mem-1', scope_type: 'project', scope_id: projectId, agent_id: null, type: 'gotcha', title: 'Money is integer cents', body: 'b', status: 'filed', hits: 0, last_hit_at: null, promoted_page_id: null, created_at: 1 }).execute();
  const workTurn = async (id: string, at: number) => {
    await db.insertInto('work_items').values({ id: `wi-${id}`, agent_id: agents.Ada!, project_id: projectId, kind: 'work', lane: 'work', task_id: taskId, thread_id: null, priority_class: 5, state: 'done', defer_reason: null, not_before: null, dedupe_key: null, cause_event_id: null, created_at: at }).execute();
    await db.insertInto('turns').values({ id, work_item_id: `wi-${id}`, agent_id: agents.Ada!, project_id: projectId, task_id: taskId, kind: 'work', lane: 'work', access: 'write', state: 'completed', stop_reason: null, worker_id: 'w1', lease_token_hash: 'h', lease_until: at, grants: '{}', summary: null, tokens_in: 0, tokens_out: 0, cost_minor: 0, started_at: at, finished_at: at, provider_id: null, model: null, session_id: null, context_mode: 'packet', git_admin: false } as never).execute();
    await db.insertInto('memory_injections').values({ turn_id: id, memory_id: 'mem-1', depth: 'full', created_at: at }).execute();
  };
  const score = async () => (await db.selectFrom('memories').select('score').where('id', '=', 'mem-1').executeTakeFirstOrThrow()).score;
  await workTurn('w-1', 10);
  await reviews.request(taskId, SHA1);
  await reviews.record(turn('Rune'), verdict('reviewer', 'changes'));
  assert.equal(await score(), -1);
  await workTurn('w-2', Date.now() + 1000);
  await reviews.request(taskId, SHA2);
  await reviews.record({ ...turn('Rune'), id: 'turn-Rune-2' }, verdict('reviewer', 'pass', SHA2));
  assert.equal(await score(), 0, 'only what was given since the last verdict is judged by this one');
  assert.equal((await db.selectFrom('events').select('seq').where('type', '=', 'memory.scored').execute()).length, 2);
  await storage.close();
});
