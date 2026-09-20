import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createTurns, startCoordinator } from '@agent-team/coordinator';
import { allowlistedEnvironment } from '../../../adapters/engine/contract.ts';
import { fake } from '../../../adapters/engine/fake.ts';
import { clearRun, identifyRun, recordRun, sweepOrphans } from './orphans.ts';
import { processIdentity, spawnCommand } from './platform.ts';
import { clipBytes, createRedactor } from './redact.ts';
import { createWorker } from './worker.ts';

const TOKEN = 'machine-token-for-tests-0123456789';
const SECRET = 'hunter2-very-secret-value';
const temp = (name: string) => mkdtempSync(path.join(os.tmpdir(), `agent-team-${name}-`));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (check: () => boolean, ms = 8000) => { const end = Date.now() + ms; while (!check() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 50)); return check(); };

// The first owner of a fresh coordinator, signed in: what the web app is to the routes it reads.
async function signIn(url: string): Promise<string> {
  const link = await (await fetch(`${url}/machine/setup-link`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } })).json() as { path: string };
  const setup = await fetch(`${url}/api/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: new URL(link.path, 'http://x').searchParams.get('token'), email: 'owner@example.com', name: 'Owner', password: 'a-long-enough-password', orgName: 'Acme' }) });
  return setup.headers.get('set-cookie')!.split(';')[0]!;
}

function repository(): string {
  const root = path.join(temp('trace'), 'app');
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  for (const args of [['config', 'user.email', 't@example.com'], ['config', 'user.name', 'T']]) execFileSync('git', ['-C', root, ...args]);
  writeFileSync(path.join(root, 'notes.txt'), 'first line\n');
  execFileSync('git', ['-C', root, 'add', '-A']); execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'init']);
  return root;
}

async function boot(scenario: string, options: { isolation?: 'strict'; env?: NodeJS.ProcessEnv } = {}) {
  const coordinator = await startCoordinator({ port: 0, storage: { kind: 'sqlite', path: ':memory:' }, machineToken: TOKEN, webRoot: null });
  const db = coordinator.context.storage.db;
  const checkout = repository();
  const registered = await fetch(`${coordinator.url}/machine/projects`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ slug: 'app', name: 'App', manifest: {} }) });
  const projectId = (await registered.json() as { id: string }).id;
  const agents = Object.fromEntries((await db.selectFrom('agents').select(['id', 'name']).execute()).map(agent => [agent.name, agent.id])) as Record<string, string>;
  const taskId = 'task-1';
  await db.insertInto('tasks').values({ id: taskId, project_id: projectId, key: 'APP-7', source: 'internal', title: 'Fix it', brief: '', tag: null, priority: 0, milestone_id: null, state: 'assigned', assignee_agent_id: agents.Ada!, author_agent_id: null, branch: null, head_sha: null, pr_url: null, blocked_reason: null, created_at: 1, updated_at: 1 }).execute();
  const turns = createTurns(coordinator.context);
  const stateDir = temp('state');
  const config = (extra: string) => ({ coordinatorUrl: coordinator.url, token: TOKEN, workerId: 'w1', stateDir, lanes: { work: 1, bounded: 1, deliver: 1 }, projects: { [projectId]: checkout }, engine: fake, env: { ...process.env, ...options.env, FAKE_SCENARIO: extra }, worktrees: { branchPrefix: 'agents/', base: 'HEAD' }, timeoutMs: 20_000, ...(options.isolation ? { isolation: options.isolation } : {}) });
  const work = () => turns.enqueue({ agentId: agents.Ada!, projectId, kind: 'work', taskId });
  return { coordinator, db, turns, worker: createWorker(config(scenario)), workerWith: (extra: string) => createWorker(config(extra)), work, agents, projectId, taskId, stateDir };
}

test('the redactor strips secret environment values and token shapes, and leaves the rest alone', () => {
  const redact = createRedactor({ PATH: '/usr/bin:/bin', HOME: '/home/worker', DEPLOY_TOKEN: SECRET, DATABASE_URL: 'postgres://app:pw@db/app', MY_API_KEY: 'abcdef123456', SHORT_SECRET: 'abc', EDITOR: 'vim-is-not-secret' }, ['lease-token-0123456789']);
  assert.equal(redact(`curl -H "X: ${SECRET}" ${SECRET}`), 'curl -H "X: [redacted]" [redacted]');
  assert.equal(redact('key=abcdef123456 lease-token-0123456789'), 'key=[redacted] [redacted]');
  assert.equal(redact('abc /usr/bin:/bin /home/worker vim-is-not-secret'), 'abc /usr/bin:/bin /home/worker vim-is-not-secret');
  assert.equal(redact('postgres://app:pw@db/app'), '[redacted]');
  for (const token of [`ghp_${'a1B2'.repeat(9)}`, `glpat-${'x'.repeat(20)}`, `sk-${'k'.repeat(40)}`, 'AKIAABCDEFGHIJKLMNOP', `Bearer ${'t'.repeat(30)}`, `eyJ${'a'.repeat(12)}.eyJ${'b'.repeat(12)}.${'c'.repeat(12)}`, `xoxb-${'1'.repeat(12)}`]) {
    const clean = redact(`+const value = "${token}";`);
    assert.ok(!clean.includes(token.replace('Bearer ', '')), token);
    assert.ok(clean.startsWith('+const value = "[redacted]'), clean);
  }
  assert.equal(redact('https://user:p4ssw0rd@example.com/repo.git'), 'https://user:[redacted]@example.com/repo.git');
  assert.ok(!redact('-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----').includes('MIIEow'));
  assert.deepEqual(clipBytes('a'.repeat(10), 4), { text: 'aaaa', truncated: true });
  assert.deepEqual(clipBytes('ok', 4), { text: 'ok', truncated: false });
});

test('the model process gets an allowlisted environment and no way to the worker\'s git credentials', () => {
  const env = allowlistedEnvironment({ PATH: '/bin', GIT_ASKPASS: '/x/askpass', SSH_AUTH_SOCK: '/x/agent', GIT_CONFIG_GLOBAL: '/x/gitconfig', GCM_INTERACTIVE: 'always', NPM_TOKEN: 'n', RANDOM_THING: 'r' });
  assert.deepEqual(env, { PATH: '/bin', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '' });
});

test('diffs come from git: an edit step against the baseline, a shell edit after its run step, all redacted', async () => {
  const { coordinator, db, worker, work } = await boot(`write:src/pay.ts,shell:notes.txt,leak:${SECRET}`, { env: { DEPLOY_TOKEN: SECRET } });
  try {
    await work();
    assert.equal(await worker.tick(), true);
    await worker.idle();
    const turn = await db.selectFrom('turns').select(['id', 'state', 'summary']).executeTakeFirstOrThrow();
    assert.equal(turn.state, 'completed');
    assert.equal(turn.summary, 'Implemented and tested. [redacted]');
    const steps = await db.selectFrom('trace_steps').select(['seq', 'kind', 'title']).orderBy('seq').execute();
    assert.deepEqual(steps.map(step => step.kind), ['think', 'read', 'edit', 'run']);
    assert.equal(steps[3]!.title, 'npm test --token=[redacted]');
    const artifacts = await db.selectFrom('step_artifacts').selectAll().where('seq', '>=', 0).orderBy('seq').execute();
    assert.deepEqual(artifacts.map(row => [row.seq, row.kind]), [[2, 'diff'], [3, 'diff']]);
    assert.match(artifacts[0]!.body, /^diff --git a\/src\/pay\.ts b\/src\/pay\.ts\nnew file/);
    assert.ok(artifacts[0]!.body.includes('+changed [redacted]'));
    assert.ok(!artifacts[0]!.body.includes('notes.txt'), 'an edit step shows its own file');
    assert.ok(artifacts[1]!.body.includes('+from the shell') && artifacts[1]!.body.includes('notes.txt'));
    assert.ok(!JSON.stringify(artifacts).includes(SECRET));

    // What the web reads: the list names the artifact, the step returns its text.
    const link = await (await fetch(`${coordinator.url}/machine/setup-link`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } })).json() as { path: string };
    const setup = await fetch(`${coordinator.url}/api/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: new URL(link.path, 'http://x').searchParams.get('token'), email: 'owner@example.com', name: 'Owner', password: 'a-long-enough-password', orgName: 'Acme' }) });
    const cookie = setup.headers.get('set-cookie')!.split(';')[0]!;
    assert.equal((await fetch(`${coordinator.url}/api/turns/${turn.id}/steps`)).status, 401);
    const list = await (await fetch(`${coordinator.url}/api/turns/${turn.id}/steps`, { headers: { cookie } })).json() as { steps: { seq: number; artifact_kind: string | null }[] };
    assert.deepEqual(list.steps.map(step => step.artifact_kind), [null, null, 'diff', 'diff']);
    const one = await (await fetch(`${coordinator.url}/api/turns/${turn.id}/steps?seq=2`, { headers: { cookie } })).json() as { artifact: { kind: string; body: string; truncated: boolean } };
    assert.equal(one.artifact.kind, 'diff');
    assert.equal(one.artifact.truncated, false);
    assert.equal((await fetch(`${coordinator.url}/api/turns/${turn.id}/steps?seq=0`, { headers: { cookie } })).status, 404);
  } finally { await coordinator.close(); }
});

test('a run step that changes nothing keeps its output, and an artifact needs a live lease', async () => {
  const { coordinator, db, worker, work } = await boot('ok');
  try {
    await work();
    await worker.tick(); await worker.idle();
    assert.deepEqual((await db.selectFrom('step_artifacts').select(['seq', 'kind', 'body']).where('seq', '>=', 0).execute()).map(row => ({ ...row })), [{ seq: 3, kind: 'output', body: '12 passed' }]);
    const posted = await fetch(`${coordinator.url}/worker/turns/nope/artifacts`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'text/plain', 'x-step-seq': '1', 'x-step-kind': 'diff', 'x-worker-id': 'w1', 'x-lease-token': 'x'.repeat(24) }, body: 'x' });
    assert.equal(posted.status, 409, 'a step artifact needs a live lease like everything else');
  } finally { await coordinator.close(); }
});

test('the session id is posted at once and the next work turn resumes it on the same worker', async () => {
  const { coordinator, db, worker, work } = await boot('ok');
  try {
    await work();
    await worker.tick(); await worker.idle();
    const first = await db.selectFrom('turns').select('id').executeTakeFirstOrThrow();
    const session = await db.selectFrom('agent_sessions').select(['engine_session_id', 'base_sha', 'worker_id']).executeTakeFirstOrThrow();
    assert.equal(session.engine_session_id, `fake-${first.id}`);
    assert.match(session.base_sha ?? '', /^[0-9a-f]{40}$/);
    await work();
    await worker.tick(); await worker.idle();
    const second = await db.selectFrom('turns').select(['id', 'context_mode', 'state']).where('id', '!=', first.id).executeTakeFirstOrThrow();
    assert.deepEqual([second.context_mode, second.state], ['resume', 'completed']);
    // The fake engine says what it was started with.
    assert.equal((await db.selectFrom('step_artifacts').select('body').where('turn_id', '=', second.id).where('kind', '=', 'think').executeTakeFirstOrThrow()).body, `Resumed fake-${first.id}`);
  } finally { await coordinator.close(); }
});

test('a missing session is requeued once in packet mode and the task carries on', async () => {
  const { coordinator, db, worker, work, taskId } = await boot('resume-missing');
  try {
    await work();
    await worker.tick(); await worker.idle();
    await work();
    await worker.tick(); await worker.idle();
    await worker.tick(); await worker.idle();
    const turns = await db.selectFrom('turns').select(['state', 'stop_reason', 'context_mode']).orderBy('started_at').execute();
    assert.deepEqual(turns.map(turn => [turn.state, turn.stop_reason, turn.context_mode]), [['completed', 'completed', 'packet'], ['failed', 'resume-missing', 'resume'], ['completed', 'completed', 'packet']]);
    assert.equal((await db.selectFrom('tasks').select('state').where('id', '=', taskId).executeTakeFirstOrThrow()).state, 'in_progress');
    assert.equal(await worker.tick(), false);
  } finally { await coordinator.close(); }
});

test('a strict worker refuses a restricted turn on an engine that only has the prompt to enforce it', async () => {
  const { coordinator, db, worker, turns, agents, projectId } = await boot('ok', { isolation: 'strict' });
  try {
    await turns.enqueue({ agentId: agents.Ada!, projectId, kind: 'reply' });
    await worker.tick(); await worker.idle();
    assert.deepEqual({ ...await db.selectFrom('turns').select(['state', 'stop_reason']).executeTakeFirstOrThrow() }, { state: 'failed', stop_reason: 'isolation-refused' });
    assert.equal((await db.selectFrom('trace_steps').select('seq').execute()).length, 0, 'nothing ran');
  } finally { await coordinator.close(); }
});

test('fail-stop: a heartbeat that cannot be confirmed kills the engine process tree and reports nothing', async () => {
  const dir = temp('failstop'), pidfile = path.join(dir, 'engine.pid'), seen: string[] = [];
  let claimed = false;
  // A coordinator that hands out one turn and then refuses its heartbeat, as one does after the lease moved on.
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      seen.push(request.url ?? '');
      const heartbeat = request.url?.endsWith('/heartbeat');
      response.writeHead(heartbeat ? 409 : 200, { 'content-type': 'application/json' });
      if (request.url === '/worker/claim' && !claimed) { claimed = true; return response.end(JSON.stringify({ turn: { turnId: 'turn-1', leaseToken: 'l'.repeat(32), leaseMs: 900, kind: 'work', agentId: 'a', projectId: 'p', taskId: null, taskKey: null, packet: { system: '', prompt: '' }, grants: { codeWrite: 'none' }, engine: null, model: null } })); }
      response.end(JSON.stringify({ turn: null, ok: true }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const worker = createWorker({ coordinatorUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: TOKEN, workerId: 'w1', stateDir: dir, lanes: { work: 1, bounded: 0, deliver: 0 }, projects: { p: dir }, engine: fake, env: { ...process.env, FAKE_SCENARIO: `hang,pidfile:${pidfile}` }, worktrees: null, timeoutMs: 60_000 });
    assert.equal(await worker.tick(), true);
    assert.ok(await until(() => existsSync(pidfile)), 'the engine started');
    const pid = Number(readFileSync(pidfile, 'utf8'));
    assert.ok(alive(pid));
    await worker.idle();
    assert.ok(await until(() => !alive(pid)), 'the engine process is gone');
    assert.ok(seen.some(url => url.endsWith('/heartbeat')));
    assert.ok(!seen.some(url => url.endsWith('/finish')), 'with the lease gone nothing more is reported');
  } finally { server.close(); }
});

test('orphan sweep: a turn left by a restarted worker has its process ended by that worker, which makes its state known: it goes back to the queue instead of to a person', async () => {
  const { coordinator, db, turns, worker, work, projectId, taskId, stateDir } = await boot('ok');
  const child = spawnCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    await work();
    const claimed = (await turns.claim({ workerId: 'w1', free: { work: 1, bounded: 0, deliver: 0 }, projects: [projectId] }))!;
    const turnDir = path.join(stateDir, 'turns', claimed.turnId);
    mkdirSync(turnDir, { recursive: true });
    writeFileSync(path.join(turnDir, 'run.json'), JSON.stringify({ turnId: claimed.turnId, leaseToken: claimed.leaseToken, pid: child.pid, startedAt: 1 }));
    writeFileSync(path.join(turnDir, 'platform-token'), 'token');

    const swept = await worker.sweep();
    assert.deepEqual(swept.map(record => record.turnId), [claimed.turnId]);
    assert.ok(await until(() => !alive(child.pid!)), 'the orphaned process is gone');
    assert.deepEqual({ ...await db.selectFrom('turns').select(['state', 'stop_reason']).where('id', '=', claimed.turnId).executeTakeFirstOrThrow() }, { state: 'deferred', stop_reason: 'worker-restarted' });
    assert.notEqual((await db.selectFrom('tasks').select('state').where('id', '=', taskId).executeTakeFirstOrThrow()).state, 'quarantined');
    assert.equal((await db.selectFrom('quarantines').select('id').execute()).length, 0, 'nobody is asked to investigate');
    assert.deepEqual((await db.selectFrom('work_items').select(['state', 'task_id']).execute()).map(item => [item.state, item.task_id]), [['queued', taskId]], 'the same work waits to continue');
    assert.ok(existsSync(path.join(turnDir, 'orphaned.json')) && !existsSync(path.join(turnDir, 'run.json')) && !existsSync(path.join(turnDir, 'platform-token')));
    // The record is dealt with once, and the work may go on at once: a restart is no reason to wait.
    assert.deepEqual(await worker.sweep(), []);
    const waiting = await db.selectFrom('work_items').select('not_before').where('state', '=', 'queued').executeTakeFirstOrThrow();
    assert.ok(waiting.not_before === null || Number(waiting.not_before) <= Date.now());
  } finally { child.kill('SIGKILL'); await coordinator.close(); }
});

test('orphan sweep reports even when the coordinator cannot be reached', async () => {
  const stateDir = temp('sweep'), turnDir = path.join(stateDir, 'turns', 't1');
  mkdirSync(turnDir, { recursive: true });
  writeFileSync(path.join(turnDir, 'run.json'), JSON.stringify({ turnId: 't1', leaseToken: 'x', pid: 999_999, startedAt: 1 }));
  const killed: number[] = [];
  const swept = await sweepOrphans(stateDir, async () => { throw new Error('unreachable'); }, pid => { killed.push(pid); });
  assert.deepEqual([swept.length, killed], [1, [999_999]]);
});

test('orphan sweep ends a pid only while it is still the process that was started: never a stranger that inherited the number', async () => {
  const stateDir = temp('reuse');
  const engine = { command: 'node', started: '4242' };
  const records = { same: 101, renamed: 102, restarted: 103, gone: 104, unknownStart: 105 };
  for (const [name, pid] of Object.entries(records)) {
    mkdirSync(path.join(stateDir, 'turns', name), { recursive: true });
    writeFileSync(path.join(stateDir, 'turns', name, 'run.json'), JSON.stringify({ turnId: name, leaseToken: 'x', pid, startedAt: 1, process: engine }));
  }
  const now: Record<number, { command: string; started: string | null } | null> = { 101: engine, 102: { command: 'backup', started: '4242' }, 103: { command: 'node', started: '9000' }, 104: null, 105: { command: 'node', started: null } };
  const killed: number[] = [], reported: string[] = [];
  const swept = await sweepOrphans(stateDir, async record => { reported.push(record.turnId); }, pid => { killed.push(pid); }, async pid => now[pid] ?? null);
  assert.deepEqual(killed.sort(), [101, 105], 'the same program is ended, also where the system cannot say when it started');
  assert.deepEqual(Object.fromEntries(swept.map(record => [record.turnId, record.swept])), { same: 'killed', renamed: 'not-ours', restarted: 'not-ours', gone: 'gone', unknownStart: 'killed' });
  assert.equal(reported.length, 5, 'every orphaned turn is reported, whatever became of its process');
});

test('the run record says who the pid is, as this system tells it', async () => {
  const dir = temp('identity');
  const child = spawnCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    const record = { turnId: 't1', leaseToken: 'x', pid: child.pid!, startedAt: Date.now() };
    recordRun(dir, record);
    await identifyRun(dir, record);
    const written = JSON.parse(readFileSync(path.join(dir, 'run.json'), 'utf8')) as { process?: { command: string; started: string | null } };
    assert.match(written.process?.command ?? '', /node/i);
    assert.deepEqual(await processIdentity(child.pid!), written.process, 'asked again, the same process answers the same');
    // Once the turn is over the record is gone and stays gone.
    clearRun(dir);
    await identifyRun(dir, record);
    assert.ok(!existsSync(path.join(dir, 'run.json')));
  } finally { child.kill('SIGKILL'); }
  assert.ok(await until(() => !alive(child.pid!)));
  assert.equal(await processIdentity(child.pid!), null, 'a pid nobody has is nobody');
  // The places each system is asked, without asking them.
  assert.deepEqual(await processIdentity(7, { platform: 'linux', read: () => '7 (tmux: server) S 1 7 7 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 12345 1000 10 1' }), { command: 'tmux: server', started: '12345' });
  assert.deepEqual(await processIdentity(7, { platform: 'win32', run: async () => '"node.exe","7","Console","1","50,120 K"\r\n' }), { command: 'node.exe', started: null });
  assert.equal(await processIdentity(7, { platform: 'win32', run: async () => 'INFO: No tasks are running which match the specified criteria.\r\n' }), null);
  assert.deepEqual(await processIdentity(7, { platform: 'darwin', run: async () => 'Sat Sep 19 10:01:02 2026 /usr/local/bin/node\n' }), { command: 'node', started: 'Sat Sep 19 10:01:02 2026' });
});

test('two tool calls named in one message: the diff goes to the step whose file changed, the rest to the run step', async () => {
  const { coordinator, db, worker, work } = await boot('write:src/pay.ts,shell:notes.txt,batch');
  try {
    await work();
    await worker.tick(); await worker.idle();
    assert.deepEqual((await db.selectFrom('trace_steps').select('kind').orderBy('seq').execute()).map(step => step.kind), ['think', 'read', 'edit', 'run']);
    const artifacts = await db.selectFrom('step_artifacts').select(['seq', 'kind', 'body']).where('seq', '>=', 0).orderBy('seq').execute();
    assert.deepEqual(artifacts.map(row => [row.seq, row.kind]), [[2, 'diff'], [3, 'diff']]);
    assert.ok(artifacts[0]!.body.includes('src/pay.ts') && !artifacts[0]!.body.includes('notes.txt'), 'the edit step has its own file, though it closed before anything was written');
    assert.ok(artifacts[1]!.body.includes('notes.txt') && !artifacts[1]!.body.includes('src/pay.ts'), 'the run step has what the shell changed and not the edit');
  } finally { await coordinator.close(); }
});

test('a change no step accounts for is shown as other changes, never pinned on a step that does not name it', async () => {
  const { coordinator, db, worker, work } = await boot('write:src/pay.ts,shell:notes.txt,batch-reversed');
  try {
    await work();
    await worker.tick(); await worker.idle();
    const steps = await db.selectFrom('trace_steps').select(['seq', 'kind', 'title']).orderBy('seq').execute();
    assert.deepEqual(steps.map(step => [step.kind, step.title]).slice(2), [['run', 'npm test'], ['edit', 'Edit src/pay.ts'], ['run', 'Other changes']]);
    const artifacts = await db.selectFrom('step_artifacts').select(['seq', 'kind', 'body']).where('seq', '>=', 0).orderBy('seq').execute();
    assert.deepEqual(artifacts.map(row => [row.seq, row.kind]), [[2, 'output'], [3, 'diff'], [4, 'diff']]);
    assert.ok(artifacts[1]!.body.includes('src/pay.ts') && !artifacts[1]!.body.includes('notes.txt'), 'the edit step shows only the file it names');
    assert.ok(artifacts[2]!.body.includes('notes.txt') && !artifacts[2]!.body.includes('src/pay.ts'));
  } finally { await coordinator.close(); }
});

test('artifact tiers: large output and the raw stream live in the artifact store, screenshots become image steps, all served by the steps route', async () => {
  const { coordinator, db, worker, work } = await boot(`output:1100000,screenshot,leak:${SECRET}`, { env: { DEPLOY_TOKEN: SECRET } });
  try {
    await work();
    await worker.tick(); await worker.idle();
    const turn = await db.selectFrom('turns').select(['id', 'state']).executeTakeFirstOrThrow();
    assert.equal(turn.state, 'completed');
    const rows = await db.selectFrom('step_artifacts').select(['seq', 'kind', 'body', 'bytes', 'truncated', 'storage_key', 'mime']).orderBy('seq').execute();
    assert.deepEqual(rows.map(row => [row.seq, row.kind, row.body, row.storage_key !== null]), [[-1, 'stream', '', true], [3, 'output', '', true], [4, 'image', '', true]]);
    const [stream, output, image] = rows;
    assert.deepEqual([Number(output!.bytes), Number(output!.truncated)], [1024 * 1024, 1], 'output is kept up to 1 MB and says when it was cut');
    // The bodies are files of the local store under the data directory, not database text.
    const stored = path.join(coordinator.context.dataDir, 'artifacts', ...output!.storage_key!.split('/'));
    assert.equal(readFileSync(stored).length, 1024 * 1024);
    assert.equal(image!.mime, 'image/png');

    const cookie = await signIn(coordinator.url);
    const list = await (await fetch(`${coordinator.url}/api/turns/${turn.id}/steps`, { headers: { cookie } })).json() as { steps: { seq: number; kind: string; title: string; artifact_kind: string | null; artifact_bytes: number | null }[]; stream: { seq: number; bytes: number; truncated: boolean } | null };
    assert.deepEqual(list.steps.map(step => [step.seq, step.artifact_kind]).slice(3), [[3, 'output'], [4, 'image']]);
    assert.equal(list.steps[4]!.title, 'Screenshot checkout-page.png');
    assert.deepEqual([list.stream?.seq, list.stream?.bytes], [-1, Number(stream!.bytes)]);
    const one = await (await fetch(`${coordinator.url}/api/turns/${turn.id}/steps?seq=3`, { headers: { cookie } })).json() as { artifact: { kind: string; body: string; bytes: number; truncated: boolean; stored: boolean } };
    assert.deepEqual([one.artifact.kind, one.artifact.body.length, one.artifact.truncated, one.artifact.stored], ['output', 1024 * 1024, true, true]);
    const picture = await fetch(`${coordinator.url}/api/turns/${turn.id}/steps?seq=4&raw=1`, { headers: { cookie } });
    assert.equal(picture.headers.get('content-type'), 'image/png');
    assert.deepEqual([...new Uint8Array(await picture.arrayBuffer()).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    assert.equal((await fetch(`${coordinator.url}/api/turns/${turn.id}/steps?seq=4&raw=1`)).status, 401);
    // The raw stream is every line the engine wrote, with the worker's secrets taken out.
    const raw = await (await fetch(`${coordinator.url}/api/turns/${turn.id}/steps?seq=-1&raw=1`, { headers: { cookie } })).text();
    const lines = raw.trim().split('\n').map(line => JSON.parse(line) as { type: string });
    assert.deepEqual([lines[0]!.type, lines.at(-1)!.type], ['session', 'result']);
    assert.ok(raw.includes('[redacted]') && !raw.includes(SECRET));

    // Only a PNG, JPEG or WebP is an image, and the stream has the one place.
    const post = (headers: Record<string, string>, body: string) => fetch(`${coordinator.url}/worker/turns/${turn.id}/artifacts`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'x-worker-id': 'w1', 'x-lease-token': 'x'.repeat(24), ...headers }, body });
    assert.equal((await post({ 'content-type': 'text/html', 'x-step-seq': '9', 'x-step-kind': 'image' }, '<script>')).status, 415);
  } finally { await coordinator.close(); }
});

test('the isolation a worker is configured with is recorded from its claim, and the workers are listed', async () => {
  const { coordinator, db, worker, projectId } = await boot('ok', { isolation: 'strict' });
  try {
    await worker.tick();
    // A worker that says nothing about it is an isolated one, as before.
    await fetch(`${coordinator.url}/worker/claim`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ workerId: 'w2', free: { bounded: 1 }, projects: [], ready: { engines: ['fake'], variables: [] } }) });
    assert.deepEqual((await db.selectFrom('workers').select(['id', 'isolation']).orderBy('id').execute()).map(row => ({ ...row })), [{ id: 'w1', isolation: 'strict' }, { id: 'w2', isolation: 'isolated' }]);
    assert.equal((await fetch(`${coordinator.url}/api/workers`)).status, 401);
    const listed = await (await fetch(`${coordinator.url}/api/workers`, { headers: { cookie: await signIn(coordinator.url) } })).json() as { workers: { name: string; isolation: string; lastSeenAt: number; lanes: Record<string, number>; projects: string[]; engines: string[] }[] };
    assert.deepEqual(listed.workers.map(row => [row.name, row.isolation, row.projects, row.engines, row.lanes]), [['w1', 'strict', [projectId], [], { work: 1, bounded: 1, deliver: 1 }], ['w2', 'isolated', [], ['fake'], { bounded: 1 }]]);
    assert.ok(listed.workers.every(row => row.lastSeenAt > 0));
  } finally { await coordinator.close(); }
});
