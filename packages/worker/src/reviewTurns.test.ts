import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createReviews, createTurns, startCoordinator } from '@agent-team/coordinator';
import { fake } from '../../../adapters/engine/fake.ts';
import { refusal as launcherRefusal } from '../../../adapters/launcher/ec2.ts';
import { createWorker, ephemeralRefusal, type DeliverFn, type WorkerConfig } from './worker.ts';
import { reviewWorktreeFor, worktreeFor } from './worktree.ts';

const TOKEN = 'machine-token-for-tests-0123456789';
const PR = 'https://scm.example.com/acme/app/pull/7';
const KINDS: Record<string, 'tester' | 'reviewer' | 'pm'> = { Cleo: 'tester', Rune: 'reviewer', Maren: 'pm' };

function repository(manifest?: unknown): string {
  const root = path.join(mkdtempSync(path.join(os.tmpdir(), 'agent-team-review-')), 'app');
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  for (const args of [['config', 'user.email', 't@example.com'], ['config', 'user.name', 'T']]) execFileSync('git', ['-C', root, ...args]);
  writeFileSync(path.join(root, 'a.txt'), 'a'); writeFileSync(path.join(root, '.env'), 'SECRET=1');
  if (manifest) writeFileSync(path.join(root, '.agent-team.json'), JSON.stringify(manifest));
  execFileSync('git', ['-C', root, 'add', '-A', '-f']); execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'init']);
  return root;
}

// Stands between the worker and the coordinator: every call is logged, and a test may act before one is passed on or answer it itself.
type Intercept = (route: string, body: Record<string, unknown>) => Promise<number | undefined>;
async function proxy(target: string, intercept: Intercept): Promise<{ url: string; log: { route: string; body: Record<string, unknown> }[]; server: Server }> {
  const log: { route: string; body: Record<string, unknown> }[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk as Buffer));
    request.on('end', () => void (async () => {
      const raw = Buffer.concat(chunks), json = String(request.headers['content-type']).includes('json');
      const body = json ? JSON.parse(raw.toString() || '{}') as Record<string, unknown> : {};
      log.push({ route: request.url ?? '', body });
      const status = await intercept(request.url ?? '', body);
      if (status) { response.writeHead(status, { 'content-type': 'application/json' }).end('{}'); return; }
      const headers = Object.fromEntries(Object.entries(request.headers).filter(([name, value]) => typeof value === 'string' && !['host', 'connection', 'content-length'].includes(name))) as Record<string, string>;
      const answer = await fetch(target + request.url, { method: request.method ?? 'POST', headers, body: raw });
      response.writeHead(answer.status, { 'content-type': answer.headers.get('content-type') ?? 'application/json' }).end(Buffer.from(await answer.arrayBuffer()));
    })().catch(() => response.writeHead(502).end()));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, log, server };
}

async function boot(options: { committed?: unknown; scenario?: string; deliver?: DeliverFn; intercept?: (context: { db: Awaited<ReturnType<typeof startCoordinator>>['context']['storage']['db']; reviews: ReturnType<typeof createReviews>; taskId: string; agents: Record<string, string> }) => Intercept; worker?: Partial<WorkerConfig>; pushFails?: boolean } = {}) {
  const coordinator = await startCoordinator({ port: 0, storage: { kind: 'sqlite', path: ':memory:' }, machineToken: TOKEN, webRoot: null });
  const db = coordinator.context.storage.db;
  const checkout = repository(options.committed);
  const registered = await fetch(`${coordinator.url}/machine/projects`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ slug: 'app', name: 'App', manifest: { scm: { kind: 'github' }, delivery: { repository: 'acme/app', baseBranch: 'main', requiredChecks: ['verify'], autoMergeAuthorized: true } } }) });
  const projectId = (await registered.json() as { id: string }).id;
  const agents = Object.fromEntries((await db.selectFrom('agents').select(['id', 'name']).execute()).map(agent => [agent.name, agent.id])) as Record<string, string>;
  const taskId = 'task-1';
  await db.insertInto('tasks').values({ id: taskId, project_id: projectId, key: 'GH-7', source: 'tracker', title: 'Fix it', brief: '', tag: null, priority: 0, milestone_id: null, state: 'in_review', assignee_agent_id: agents.Ada!, author_agent_id: null, branch: null, head_sha: null, pr_url: null, blocked_reason: null, created_at: 1, updated_at: 1 }).execute();
  const turns = createTurns(coordinator.context), reviews = createReviews(coordinator.context, turns);
  const between = await proxy(coordinator.url, options.intercept?.({ db, reviews, taskId, agents }) ?? (async () => {}));
  const calls: string[][] = [];
  const worker = createWorker({
    coordinatorUrl: between.url, token: TOKEN, workerId: 'w1', stateDir: mkdtempSync(path.join(os.tmpdir(), 'agent-team-state-')), lanes: { work: 1, bounded: 1, deliver: 1 }, projects: { [projectId]: checkout },
    engine: fake, env: { ...process.env, FAKE_SCENARIO: options.scenario ?? 'ok' }, worktrees: { branchPrefix: 'agents/', base: 'HEAD' },
    deliver: options.deliver ?? (async () => ({ state: 'merged', reason: 'confirmed MERGED', mergeAttempted: true })),
    publish: { scm: 'github', repository: 'acme/app', base: 'main', exec: async (bin, args) => { calls.push([bin, ...args]); if (options.pushFails && args.includes('push')) throw new Error('remote rejected'); return args.includes('create') ? PR : ''; } },
    ...options.worker,
  });
  const close = async () => { between.server.closeAllConnections(); await new Promise(resolve => between.server.close(resolve)); await coordinator.close(); };
  return { coordinator, db, worker, turns, reviews, agents, projectId, taskId, checkout, calls, log: between.log, close };
}
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' }).toString().trim();

test('a review runs in its own detached worktree, the worker reports the head it verified, and only then does the verdict count', async () => {
  // The verdict arrives while the review turn runs, as it does from an agent: before the worker's closing report is passed on.
  const harness = await boot({ intercept: ({ db, reviews, taskId, agents }) => async (route, body) => {
    const finished = /^\/worker\/turns\/([^/]+)\/finish$/.exec(route);
    if (!finished) return;
    const turn = await db.selectFrom('turns').select(['id', 'agent_id', 'task_id', 'kind']).where('id', '=', finished[1]!).executeTakeFirstOrThrow();
    if (turn.kind !== 'review') return;
    const name = Object.keys(agents).find(key => agents[key] === turn.agent_id)!, head = (await db.selectFrom('tasks').select('head_sha').where('id', '=', taskId).executeTakeFirstOrThrow()).head_sha!;
    assert.deepEqual(await reviews.record(turn, { kind: KINDS[name]!, verdict: 'pass', headSha: head, summary: 'ok', findings: [] }, { verification: 'worker' }), { approved: false });
    assert.equal((await db.selectFrom('approvals').select('state').where('turn_id', '=', turn.id).executeTakeFirstOrThrow()).state, 'pending-verification');
    assert.deepEqual([(body.outcome as Record<string, unknown>).headShaStart, (body.outcome as Record<string, unknown>).headShaEnd], [head, head]);
  } });
  const { db, worker, turns, agents, projectId, taskId, checkout, log, close } = harness;
  try {
    await turns.enqueue({ agentId: agents.Ada!, projectId, kind: 'work', taskId });
    await worker.tick(); await worker.idle();
    const head = (await db.selectFrom('tasks').select('head_sha').where('id', '=', taskId).executeTakeFirstOrThrow()).head_sha!;
    const author = worktreeFor(checkout, 'GH-7', 'agents/');

    for (let i = 0; i < 3; i++) { assert.equal(await worker.tick(), true); await worker.idle(); }
    assert.deepEqual((await db.selectFrom('turns').select(['kind', 'state']).where('kind', '=', 'review').execute()).map(turn => turn.state), ['completed', 'completed', 'completed']);
    for (const kind of Object.values(KINDS)) {
      const tree = reviewWorktreeFor(checkout, 'GH-7', kind);
      assert.notEqual(tree, author.path);
      assert.equal(git(tree, 'rev-parse', 'HEAD'), head);
      assert.throws(() => git(tree, 'symbolic-ref', '-q', 'HEAD'), 'detached: no branch to write to');
      assert.ok(existsSync(path.join(tree, 'a.txt')) && !existsSync(path.join(tree, '.env')));
    }
    assert.equal(git(author.path, 'symbolic-ref', '--short', 'HEAD'), 'agents/gh-7');
    assert.deepEqual((await db.selectFrom('approvals').select('state').execute()).map(row => row.state), ['valid', 'valid', 'valid']);
    assert.equal((await db.selectFrom('tasks').select('state').where('id', '=', taskId).executeTakeFirstOrThrow()).state, 'approved');
    // Each worktree that was made was announced as a git-admin operation and closed again: the author's and one per reviewer kind.
    const admin = log.filter(entry => entry.route.endsWith('/git-admin')).map(entry => entry.body.state);
    assert.deepEqual(admin, ['begin', 'end', 'begin', 'end', 'begin', 'end', 'begin', 'end']);

    // The merge ends the task: the review worktrees go, the author's worktree and branch stay.
    assert.equal(await worker.tick(), true); await worker.idle();
    assert.equal((await db.selectFrom('tasks').select('state').where('id', '=', taskId).executeTakeFirstOrThrow()).state, 'done');
    for (const kind of Object.values(KINDS)) assert.equal(existsSync(reviewWorktreeFor(checkout, 'GH-7', kind)), false);
    assert.ok(existsSync(author.path));
    assert.equal(git(checkout, 'branch', '--list', 'agents/gh-7').replace(/^[*+ ]+/, ''), 'agents/gh-7');
  } finally { await close(); }
});

test('a review whose head cannot be checked out safely fails without running anything; its verdict could never count', async () => {
  const { db, worker, turns, agents, projectId, taskId, close } = await boot();
  try {
    await db.updateTable('tasks').set({ head_sha: 'f'.repeat(40) }).where('id', '=', taskId).execute();
    await turns.enqueue({ agentId: agents.Cleo!, projectId, kind: 'review', taskId, dedupeKey: `review:${taskId}:tester:${'f'.repeat(40)}` });
    assert.equal(await worker.tick(), true); await worker.idle();
    const turn = await db.selectFrom('turns').select(['state', 'stop_reason', 'summary']).executeTakeFirstOrThrow();
    assert.deepEqual([turn.state, turn.stop_reason], ['failed', 'worktree-refused']);
    assert.match(turn.summary ?? '', /not in the primary checkout/);
    assert.equal((await db.selectFrom('trace_steps').select('seq').execute()).length, 0);
  } finally { await close(); }
});

test('a lease lost in the middle of a git-admin operation makes the worker stop claiming for that checkout', async () => {
  const { worker, turns, agents, projectId, taskId, log, close } = await boot({ intercept: () => async (route, body) => (route.endsWith('/git-admin') && body.state === 'end' ? 409 : undefined) });
  try {
    await turns.enqueue({ agentId: agents.Ada!, projectId, kind: 'work', taskId });
    assert.equal(await worker.tick(), true); await worker.idle();
    assert.deepEqual(worker.quarantinedCheckouts(), [projectId]);
    // Nothing was run and nothing reported after the lease was gone.
    assert.equal(log.some(entry => entry.route.endsWith('/finish') || entry.route.endsWith('/steps')), false);
    const claims = log.filter(entry => entry.route === '/worker/claim').length;
    assert.equal(await worker.tick(), false);
    assert.equal(log.filter(entry => entry.route === '/worker/claim').length, claims);
  } finally { await close(); }
});

test('the worker and the launcher refuse a disposable host for the same reasons', () => {
  const target = { scm: 'github', repository: 'acme/app', base: 'main' };
  for (const authorized of [true, false]) for (const publish of [target, null, { ...target, repository: '' }]) {
    const here = ephemeralRefusal({ publishAuthorized: authorized, publish }), there = launcherRefusal({ manifest: { publishAuthorized: authorized }, sessions: 'packet', publish });
    assert.equal(here === null, there === null, JSON.stringify({ authorized, publish }));
    for (const reason of ['does not authorize publishing (publishAuthorized)', 'no publish target (scm, repository, base) is configured']) assert.equal(here?.includes(reason) ?? false, there?.includes(reason) ?? false, reason);
  }
  assert.match(ephemeralRefusal({ publishAuthorized: true, publish: target, worktrees: null }) ?? '', /no branch to push/);
});

test('a disposable worker claims nothing unless the committed manifest authorizes publishing', async () => {
  // The coordinator's copy of the manifest is not what counts: the repository at the base is.
  for (const committed of [undefined, { delivery: { publishAuthorized: false } }, { ceiling: { publishAuthorized: 'yes' } }]) {
    const { db, worker, turns, agents, projectId, taskId, log, close } = await boot({ committed, worker: { ephemeral: true } });
    try {
      await turns.enqueue({ agentId: agents.Ada!, projectId, kind: 'work', taskId });
      assert.equal(await worker.tick(), false);
      assert.match((await worker.refusals())[projectId] ?? '', /An ephemeral worker is refused: the project manifest does not authorize publishing/);
      assert.equal(log.length, 0, 'nothing was claimed, so nothing can be left uncertain');
      assert.equal((await db.selectFrom('turns').select('id').execute()).length, 0);
    } finally { await close(); }
  }
  const { worker, turns, agents, projectId, taskId, close } = await boot({ committed: { delivery: { publishAuthorized: true } }, worker: { ephemeral: true, publish: null } });
  try {
    await turns.enqueue({ agentId: agents.Ada!, projectId, kind: 'work', taskId });
    assert.equal(await worker.tick(), false);
    assert.match((await worker.refusals())[projectId] ?? '', /no publish target/);
  } finally { await close(); }
});

test('a disposable worker pushes the branch however the turn ended, and says so when it could not', async () => {
  for (const committed of [{ delivery: { publishAuthorized: true } }, { ceiling: { publishAuthorized: true } }]) {
    const { db, worker, turns, agents, projectId, taskId, calls, close } = await boot({ committed, scenario: 'crash', worker: { ephemeral: true } });
    try {
      await turns.enqueue({ agentId: agents.Ada!, projectId, kind: 'work', taskId });
      assert.equal(await worker.tick(), true); await worker.idle();
      assert.deepEqual({ ...await db.selectFrom('turns').select(['state', 'stop_reason']).executeTakeFirstOrThrow() }, { state: 'failed', stop_reason: 'crashed' });
      assert.deepEqual(calls.map(call => call.filter(part => part === 'push' || part === '--force' || part === 'create')), [['push']]);
      assert.ok(calls[0]!.includes('agents/gh-7:agents/gh-7'));
    } finally { await close(); }
  }
  const failing = await boot({ committed: { delivery: { publishAuthorized: true } }, scenario: 'crash', worker: { ephemeral: true }, pushFails: true });
  try {
    await failing.turns.enqueue({ agentId: failing.agents.Ada!, projectId: failing.projectId, kind: 'work', taskId: failing.taskId });
    await failing.worker.tick(); await failing.worker.idle();
    const turn = await failing.db.selectFrom('turns').select(['state', 'stop_reason', 'summary']).executeTakeFirstOrThrow();
    assert.deepEqual([turn.state, turn.stop_reason], ['failed', 'push-failed']);
    assert.match(turn.summary ?? '', /remote rejected/);
  } finally { await failing.close(); }
  // A host that stays keeps its worktree, so a turn that did not complete pushes nothing.
  const staying = await boot({ scenario: 'crash' });
  try {
    await staying.turns.enqueue({ agentId: staying.agents.Ada!, projectId: staying.projectId, kind: 'work', taskId: staying.taskId });
    await staying.worker.tick(); await staying.worker.idle();
    assert.equal(staying.calls.length, 0);
  } finally { await staying.close(); }
});

test('a disposable worker starts every turn from its packet; a worker that stays resumes the session', async () => {
  const sessionsSeen = async (ephemeral: boolean) => {
    const seen: (string | null)[] = [];
    const engine = { ...fake, prepare: (...args: Parameters<typeof fake.prepare>) => { seen.push(args[0].sessionId ?? null); return fake.prepare(...args); } };
    const { worker, turns, agents, projectId, taskId, close } = await boot({ committed: { delivery: { publishAuthorized: true } }, worker: { ephemeral, engine, lanes: { work: 1, bounded: 0, deliver: 0 } } });
    try {
      for (let i = 0; i < 2; i++) { await turns.enqueue({ agentId: agents.Ada!, projectId, kind: 'work', taskId }); assert.equal(await worker.tick(), true); await worker.idle(); }
    } finally { await close(); }
    return seen;
  };
  const staying = await sessionsSeen(false);
  assert.equal(staying[0], null);
  assert.equal(typeof staying[1], 'string');
  assert.deepEqual(await sessionsSeen(true), [null, null]);
});
