import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createReviews, createTurns, startCoordinator } from '@agent-team/coordinator';
import { fake } from '../../../adapters/engine/fake.ts';
import { createWorker, type DeliverFn } from './worker.ts';

const TOKEN = 'machine-token-for-tests-0123456789';
const PR = 'https://github.com/acme/app/pull/7';

function repository(manifest?: unknown): string {
  const root = path.join(mkdtempSync(path.join(os.tmpdir(), 'agent-team-deliver-')), 'app');
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  for (const args of [['config', 'user.email', 't@example.com'], ['config', 'user.name', 'T']]) execFileSync('git', ['-C', root, ...args]);
  writeFileSync(path.join(root, 'a.txt'), 'a');
  if (manifest) writeFileSync(path.join(root, '.agent-team.json'), JSON.stringify(manifest));
  execFileSync('git', ['-C', root, 'add', '-A']); execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'init']);
  return root;
}

async function boot(deliver: DeliverFn, scenario = 'ok', committed?: unknown) {
  const coordinator = await startCoordinator({ port: 0, storage: { kind: 'sqlite', path: ':memory:' }, machineToken: TOKEN, webRoot: null });
  const db = coordinator.context.storage.db;
  const checkout = repository(committed);
  const registered = await fetch(`${coordinator.url}/machine/projects`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ slug: 'app', name: 'App', manifest: { scm: { kind: 'github' }, delivery: { repository: 'acme/app', baseBranch: 'main', requiredChecks: ['verify'], autoMergeAuthorized: true } } }) });
  const projectId = (await registered.json() as { id: string }).id;
  const agents = Object.fromEntries((await db.selectFrom('agents').select(['id', 'name']).execute()).map(agent => [agent.name, agent.id])) as Record<string, string>;
  const taskId = 'task-1';
  await db.insertInto('tasks').values({ id: taskId, project_id: projectId, key: 'GH-7', source: 'tracker', title: 'Fix it', brief: '', tag: null, priority: 0, milestone_id: null, state: 'in_review', assignee_agent_id: agents.Ada!, author_agent_id: null, branch: null, head_sha: null, pr_url: null, blocked_reason: null, created_at: 1, updated_at: 1 }).execute();
  const turns = createTurns(coordinator.context), reviews = createReviews(coordinator.context, turns);
  const calls: string[][] = [];
  const worker = createWorker({
    coordinatorUrl: coordinator.url, token: TOKEN, workerId: 'w1', stateDir: mkdtempSync(path.join(os.tmpdir(), 'agent-team-state-')), lanes: { work: 1, bounded: 3, deliver: 1 }, projects: { [projectId]: checkout },
    engine: fake, env: { ...process.env, FAKE_SCENARIO: scenario }, worktrees: { branchPrefix: 'agents/', base: 'HEAD' }, deliver,
    publish: { scm: 'github', repository: 'acme/app', base: 'main', exec: async (bin, args) => { calls.push([bin, ...args]); return args.includes('create') ? PR : ''; } },
  });
  return { coordinator, db, worker, turns, reviews, agents, projectId, taskId, calls };
}

test('work is published, reviewed at its head by three agents, then merged by the gate with platform approvals', async () => {
  let seen: Parameters<DeliverFn>[0] | null = null, approvalKinds: string[] = [];
  const { coordinator, db, worker, turns, reviews, agents, projectId, taskId, calls } = await boot(async input => { seen = input; approvalKinds = Object.keys(await input.approvals()).sort(); return { state: 'merged', reason: 'confirmed MERGED', mergeAttempted: true, mergeCommit: 'c'.repeat(40) }; });

  await turns.enqueue({ agentId: agents.Ada!, projectId, kind: 'work', taskId });
  await worker.tick(); await worker.idle();
  const afterWork = await db.selectFrom('tasks').select(['pr_url', 'head_sha', 'state']).where('id', '=', taskId).executeTakeFirstOrThrow();
  assert.equal(afterWork.pr_url, PR);
  assert.match(afterWork.head_sha ?? '', /^[0-9a-f]{40}$/);
  assert.ok(calls.some(call => call.includes('push')) && !calls.flat().includes('--force'));

  // Reviews were requested at that head; the three reviewers record their verdicts through the platform.
  const review = (name: string, kind: 'tester' | 'reviewer' | 'pm') => reviews.record({ id: `turn-${name}`, agent_id: agents[name]!, task_id: taskId, kind: 'review' }, { kind, verdict: 'pass', headSha: afterWork.head_sha!, summary: 'ok', findings: [] });
  await review('Cleo', 'tester'); await review('Rune', 'reviewer');
  assert.deepEqual(await review('Maren', 'pm'), { approved: true });

  // Drain the queued review items (the fake engine answers them), then the delivery turn.
  for (let i = 0; i < 6 && await worker.tick(); i++) await worker.idle();
  const done = await db.selectFrom('tasks').select('state').where('id', '=', taskId).executeTakeFirstOrThrow();
  assert.equal(done.state, 'done');
  assert.equal((await db.selectFrom('merge_queue').select('state').executeTakeFirstOrThrow()).state, 'merged');
  const gate = seen as unknown as Parameters<DeliverFn>[0];
  assert.equal(gate.prUrl, PR);
  assert.equal(gate.branch, 'agents/gh-7');
  // Read while the delivery turn held its lease: the gate sees the platform's approvals, not a copy.
  assert.deepEqual(approvalKinds, ['pm', 'reviewer', 'tester']);
  await coordinator.close();
});

test('a gate refusal blocks the task with its reason and merges nothing', async () => {
  const { coordinator, db, worker, turns, reviews, agents, projectId, taskId } = await boot(async () => ({ state: 'blocked', reason: 'Required checks missing or not passing', mergeAttempted: false }));
  await turns.enqueue({ agentId: agents.Ada!, projectId, kind: 'work', taskId });
  await worker.tick(); await worker.idle();
  const head = (await db.selectFrom('tasks').select('head_sha').where('id', '=', taskId).executeTakeFirstOrThrow()).head_sha!;
  for (const [name, kind] of [['Cleo', 'tester'], ['Rune', 'reviewer'], ['Maren', 'pm']] as const) await reviews.record({ id: `turn-${name}`, agent_id: agents[name]!, task_id: taskId, kind: 'review' }, { kind, verdict: 'pass', headSha: head, summary: 'ok', findings: [] });
  for (let i = 0; i < 6 && await worker.tick(); i++) await worker.idle();
  const task = await db.selectFrom('tasks').select(['state', 'blocked_reason']).where('id', '=', taskId).executeTakeFirstOrThrow();
  assert.deepEqual([task.state, task.blocked_reason], ['blocked', 'Required checks missing or not passing']);
  await coordinator.close();
});

test('a change outside the write scope of the agent fails the turn and is never published or reviewed', async () => {
  const never: DeliverFn = async () => { throw new Error('unreachable'); };
  const { coordinator, db, worker, turns, agents, projectId, taskId, calls } = await boot(never, 'write:src/pay.ts');
  // Cleo is the tester: she may write under test, tests and e2e only.
  await db.updateTable('tasks').set({ assignee_agent_id: agents.Cleo!, state: 'in_progress' }).where('id', '=', taskId).execute();
  await turns.enqueue({ agentId: agents.Cleo!, projectId, kind: 'work', taskId });
  await worker.tick(); await worker.idle();
  const turn = await db.selectFrom('turns').select(['state', 'stop_reason', 'summary']).executeTakeFirstOrThrow();
  assert.deepEqual([turn.state, turn.stop_reason], ['failed', 'write-scope']);
  assert.match(turn.summary ?? '', /src.pay.ts/);
  assert.equal(calls.length, 0);
  assert.equal((await db.selectFrom('tasks').select('pr_url').where('id', '=', taskId).executeTakeFirstOrThrow()).pr_url, null);
  await coordinator.close();
});

test('a ceiling committed in the repository caps the grants the coordinator sent', async () => {
  const never: DeliverFn = async () => { throw new Error('unreachable'); };
  const { coordinator, db, worker, turns, agents, projectId, taskId, calls } = await boot(never, 'write:src/pay.ts', { ceiling: { codeWrite: { paths: ['docs'] } } });
  // Ada is a developer and may write anywhere by role; the repository says docs only.
  await turns.enqueue({ agentId: agents.Ada!, projectId, kind: 'work', taskId });
  await worker.tick(); await worker.idle();
  const turn = await db.selectFrom('turns').select(['state', 'stop_reason', 'grants']).executeTakeFirstOrThrow();
  assert.equal(JSON.parse(turn.grants).codeWrite, 'all');
  assert.deepEqual([turn.state, turn.stop_reason, calls.length], ['failed', 'write-scope', 0]);
  await coordinator.close();
});
