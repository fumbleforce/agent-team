import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '@agent-team/storage';
import { createContext } from '../context.ts';
import { createWorkspace } from '../repos/workspace.ts';
import { createTurns } from '../runtime/turns.ts';
import { createChecks } from '../checks/checks.ts';
import { createCheckWake, failingChecks } from '../checks/wake.ts';
import { createCursors } from './cursors.ts';
import { createScmSync, type ScmApi, type ScmTestReport } from './scm.ts';

const report = (suite: string, branch: string, sha: string, failing: string[]): ScmTestReport => ({ suite, branch, sha, report: { passed: 10, failed: failing.length, skipped: 0, total: 10 + failing.length, durationMs: 1200, failing: failing.map(name => ({ name, status: 'failed' as const, message: 'Expected 200, got 500' })) } });

async function setup() {
  const storage = await createStorage({ kind: 'sqlite', path: ':memory:' });
  await storage.migrate();
  let clock = 1_800_000_000_000;
  const context = createContext({ storage, machineToken: 'x'.repeat(24), now: () => clock++ });
  const projectId = await createWorkspace(context).registerProject({ slug: 'shop', name: 'Shop', kind: 'repo', manifest: { scm: { kind: 'fake', repository: 'acme/shop' }, delivery: { baseBranch: 'trunk' } } });
  return { storage, context, projectId };
}

test('environments of the code host feed the product view, and its test reports feed the checks, once per commit', async () => {
  const { storage, context, projectId } = await setup();
  try {
    const asked: string[] = [];
    const host = { environments: [{ name: 'preview', url: 'https://preview.example.com', branch: 'feature/pay' as string | null }, { name: 'staging', url: 'https://staging.example.com', branch: null }, { name: 'odd', url: 'javascript:alert(1)', branch: null }], reports: new Map<string, ScmTestReport[]>([['trunk', [report('unit', 'trunk', 'a'.repeat(40), [])]]]) };
    const api: ScmApi = {
      reviewState: async () => ({ state: 'pending', approvals: 0, reviewers: [] }),
      changeState: async () => ({ open: true, headSha: null, conflicting: null }),
      environments: async () => host.environments,
      testReports: async (_repository, ref) => { const branch = 'branch' in ref ? ref.branch : ''; asked.push(branch); if (branch === 'gone') throw new Error('Host HTTP request failed (404)'); return host.reports.get(branch) ?? []; },
    };
    await storage.db.insertInto('product_envs').values({ id: 'manual-1', project_id: projectId, name: 'staging', branch: null, url: 'https://hand-made.example.com', source: 'manual', created_at: 1 }).execute();
    const sync = createScmSync(context);
    assert.deepEqual(await sync.syncProject(projectId, api), { environments: 1, runs: 1, sentBack: 0 });
    assert.deepEqual(await sync.syncProject(projectId, api), { environments: 0, runs: 0, sentBack: 0 }, 'the same commit is not recorded twice');
    const envs = await storage.db.selectFrom('product_envs').select(['name', 'url', 'branch', 'source']).where('project_id', '=', projectId).orderBy('name').execute();
    assert.deepEqual(envs.map(row => [row.name, row.url, row.branch, row.source]), [['preview', 'https://preview.example.com', 'feature/pay', 'scm'], ['staging', 'https://hand-made.example.com', null, 'manual']]);
    host.environments[0]!.url = 'https://preview-2.example.com';
    assert.equal((await sync.syncProject(projectId, api)).environments, 1);
    assert.equal((await storage.db.selectFrom('product_envs').select('url').where('name', '=', 'preview').executeTakeFirstOrThrow()).url, 'https://preview-2.example.com');

    // Branches of open tasks are polled beside the base branch; one branch failing to answer is reported, the rest still lands.
    await storage.db.insertInto('tasks').values(['feature/pay', 'gone'].map((branch, index) => ({ id: `t${index}`, project_id: projectId, key: `T-${index}`, source: 'internal', title: branch, brief: '', tag: null, priority: index, milestone_id: null, state: 'in_progress', assignee_agent_id: null, author_agent_id: null, branch, head_sha: null, pr_url: null, blocked_reason: null, created_at: 1, updated_at: 1 }))).execute();
    host.reports.set('feature/pay', [report('e2e', 'feature/pay', 'b'.repeat(40), ['checkout.spec › pays with card'])]);
    asked.length = 0;
    await assert.rejects(sync.syncProject(projectId, api), /404/);
    assert.deepEqual(asked.sort(), ['feature/pay', 'gone', 'trunk']);
    const runs = await storage.db.selectFrom('check_runs').select(['suite', 'branch', 'status', 'source', 'sha']).where('project_id', '=', projectId).orderBy('created_at').execute();
    assert.deepEqual(runs.map(run => [run.suite, run.branch, run.status, run.source]), [['unit', 'trunk', 'passed', 'scm'], ['e2e', 'feature/pay', 'failed', 'scm']]);
    const status = (await createCursors(context).status(projectId)).find(row => row.resource === 'scm')!;
    assert.deepEqual([status.error, typeof status.failingSince, typeof status.lastOkAt], ['Host HTTP request failed (404)', 'number', 'number']);
  } finally { await storage.close(); }
});

test('a failing run on a task’s branch emits check.failed and wakes whoever works on it, once', async () => {
  const { storage, context, projectId } = await setup();
  try {
    const turns = createTurns(context), wake = createCheckWake(context, turns), checks = createChecks(context);
    const agent = await storage.db.selectFrom('agents').select('id').where('is_pm', '=', false).executeTakeFirstOrThrow();
    await storage.db.insertInto('tasks').values({ id: 't1', project_id: projectId, key: 'T-1', source: 'internal', title: 'Pay', brief: '', tag: null, priority: 0, milestone_id: null, state: 'in_review', assignee_agent_id: agent.id, author_agent_id: null, branch: 'feature/pay', head_sha: null, pr_url: null, blocked_reason: null, created_at: 1, updated_at: 1 }).execute();
    assert.equal(await wake.sweep(), 0, 'the first sweep only marks where the log stands');

    const failing = report('e2e', 'feature/pay', 'b'.repeat(40), ['checkout.spec › pays with card']);
    await checks.record({ projectId, suite: failing.suite, branch: failing.branch, sha: failing.sha, source: 'scm', report: failing.report });
    await checks.record({ projectId, suite: 'e2e', branch: 'nobody/works-here', source: 'upload', report: failing.report });
    await checks.record({ projectId, suite: 'unit', branch: 'feature/pay', source: 'agent', report: report('unit', 'feature/pay', 'b'.repeat(40), []).report });
    assert.equal((await storage.db.selectFrom('events').select('seq').where('type', '=', 'check.failed').execute()).length, 2);
    assert.equal(await wake.sweep(), 1);
    assert.equal(await wake.sweep(), 0);
    const items = await storage.db.selectFrom('work_items').select(['agent_id', 'kind', 'task_id', 'cause_event_id']).execute();
    assert.deepEqual(items.map(item => [item.agent_id, item.kind, item.task_id, Boolean(item.cause_event_id)]), [[agent.id, 'work', 't1', true]]);
    // The woken agent reads what failed; a later green run of the suite takes it away again.
    assert.match((await failingChecks(storage.db, 't1'))!, /# Failing checks on feature\/pay\n- e2e: 1 failing at bbbbbbbbbb\n {2}- checkout\.spec › pays with card: Expected 200, got 500$/);
    await checks.record({ projectId, suite: 'e2e', branch: 'feature/pay', sha: 'c'.repeat(40), source: 'scm', report: report('e2e', 'feature/pay', 'c'.repeat(40), []).report });
    assert.equal(await failingChecks(storage.db, 't1'), null);
  } finally { await storage.close(); }
});

test('a change in review that no longer merges goes back to its author at once, to merge the base in, once per revision', async () => {
  const { storage, context, projectId } = await setup();
  try {
    const db = storage.db, turns = createTurns(context), sync = createScmSync(context, turns);
    const author = await db.selectFrom('agents').select('id').where('is_pm', '=', false).executeTakeFirstOrThrow(), pm = await db.selectFrom('agents').select('id').where('is_pm', '=', true).executeTakeFirstOrThrow();
    const head = 'c'.repeat(40), url = 'https://host.example/acme/shop/pull/3';
    await db.insertInto('tasks').values({ id: 't1', project_id: projectId, key: 'T-1', source: 'internal', title: 'Pay', brief: '', tag: null, priority: 0, milestone_id: null, state: 'in_review', assignee_agent_id: author.id, author_agent_id: null, branch: null, head_sha: head, pr_url: url, blocked_reason: null, created_at: 1, updated_at: 1 }).execute();
    await turns.enqueue({ agentId: pm.id, projectId, kind: 'review', taskId: 't1', dedupeKey: `review:t1:pm:${head}` });
    const answer: { open: boolean; headSha: string | null; conflicting: boolean | null } = { open: true, headSha: head, conflicting: null };
    const asked: string[] = [];
    const api: ScmApi = {
      reviewState: async () => ({ state: 'pending', approvals: 0, reviewers: [] }),
      changeState: async (_repository, change) => { asked.push(change); return { ...answer }; },
      environments: async () => [], testReports: async () => [],
    };

    // The host has not worked it out yet: that is no answer, and nothing is sent.
    assert.equal((await sync.syncProject(projectId, api)).sentBack, 0);
    assert.deepEqual(asked, [url]);
    // It collides, but at another head than the one in review: that says nothing about this revision.
    Object.assign(answer, { conflicting: true, headSha: 'd'.repeat(40) });
    assert.equal((await sync.syncProject(projectId, api)).sentBack, 0);

    // It collides at the revision in review: back to its author with what to do, the review still waiting is dropped, the author is started.
    answer.headSha = head;
    assert.equal((await sync.syncProject(projectId, api)).sentBack, 1);
    assert.equal((await db.selectFrom('tasks').select('state').where('id', '=', 't1').executeTakeFirstOrThrow()).state, 'in_progress');
    const moves = (await db.selectFrom('events').select('payload').where('task_id', '=', 't1').where('type', '=', 'task.state_changed').execute()).map(row => JSON.parse(row.payload));
    assert.deepEqual(moves.map(move => [move.from, move.to, move.reason]), [['in_review', 'in_progress', 'conflicts-with-base']]);
    const told = await db.selectFrom('messages').innerJoin('threads', 'threads.id', 'messages.thread_id').select('messages.body').where('threads.subject_id', '=', 't1').execute();
    assert.equal(told.length, 1);
    assert.match(told[0]!.body, /^This change no longer merges into the base branch/);
    assert.match(told[0]!.body, /MERGE it into your branch/);
    const items = await db.selectFrom('work_items').select(['agent_id', 'kind', 'state']).where('task_id', '=', 't1').execute();
    assert.deepEqual(items.map(item => [item.kind, item.state, item.agent_id === author.id]).sort(), [['review', 'canceled', false], ['work', 'queued', true]]);

    // Once per revision: in review again at the same head and still colliding, it is not sent back a second time.
    await db.updateTable('tasks').set({ state: 'in_review' }).where('id', '=', 't1').execute();
    assert.equal((await sync.syncProject(projectId, api)).sentBack, 0);
    assert.equal((await db.selectFrom('tasks').select('state').where('id', '=', 't1').executeTakeFirstOrThrow()).state, 'in_review');
  } finally { await storage.close(); }
});
