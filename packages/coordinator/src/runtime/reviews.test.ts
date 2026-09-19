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

test('a review asks one agent per role, never the author; all three passing at one head approve and queue the merge', async () => {
  const { storage, db, reviews, agents, taskId, turn, verdict } = await boot();
  const asked = await reviews.request(taskId, SHA1);
  assert.deepEqual(asked, [{ kind: 'pm', agentId: agents.Maren }, { kind: 'tester', agentId: agents.Cleo }, { kind: 'reviewer', agentId: agents.Rune }]);
  assert.equal((await db.selectFrom('work_items').select('kind').where('kind', '=', 'review').execute()).length, 3);

  await assert.rejects(reviews.record(turn('Ada'), verdict('reviewer')), /author/);
  await assert.rejects(reviews.record(turn('Cleo'), verdict('reviewer')), /do not hold/);
  await assert.rejects(reviews.record(turn('Cleo', 'work'), verdict('tester')), /review turn/);
  await assert.rejects(reviews.record(turn('Cleo'), verdict('tester', 'pass', SHA2)), /review that revision/);

  assert.deepEqual(await reviews.record(turn('Cleo'), verdict('tester')), { approved: false });
  assert.deepEqual(await reviews.record(turn('Rune'), verdict('reviewer')), { approved: false });
  assert.deepEqual(await reviews.record(turn('Maren'), verdict('pm')), { approved: true });
  assert.equal((await db.selectFrom('tasks').select('state').where('id', '=', taskId).executeTakeFirstOrThrow()).state, 'approved');
  const queued = await db.selectFrom('merge_queue').select(['state', 'head_sha']).executeTakeFirstOrThrow();
  assert.deepEqual([queued.state, queued.head_sha], ['queued', SHA1]);
  const gate = await reviews.approvalsFor(taskId, SHA1) as Record<string, { verdict: string; sessionId: string }>;
  assert.deepEqual([gate.tester!.verdict, gate.reviewer!.verdict, gate.pm!.verdict], ['PASS', 'APPROVE', 'APPROVE']);
  assert.equal(new Set(Object.values(gate).map(item => item.sessionId)).size, 3);
  await storage.close();
});

test('requested changes send the task back to its author; a new head makes earlier approvals stale', async () => {
  const { storage, db, reviews, agents, taskId, turn, verdict } = await boot();
  await reviews.request(taskId, SHA1);
  await reviews.record(turn('Cleo'), verdict('tester'));
  await reviews.record(turn('Rune'), verdict('reviewer', 'changes'));
  assert.equal((await db.selectFrom('tasks').select('state').where('id', '=', taskId).executeTakeFirstOrThrow()).state, 'in_progress');
  assert.equal((await db.selectFrom('work_items').select('agent_id').where('kind', '=', 'work').executeTakeFirstOrThrow()).agent_id, agents.Ada);

  await reviews.request(taskId, SHA2);
  assert.deepEqual(await reviews.approvalsFor(taskId, SHA2), {});
  assert.equal((await db.selectFrom('approvals').select('state').where('state', '=', 'stale').execute()).length, 2);
  await storage.close();
});
