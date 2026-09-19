import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createQueue } from './queue.mjs';
import { createClient, runWorker, runnerArgs, parseJournal, runProcess, validateConfig, latestWorktree, RUNNER_STOP_GRACE_MS } from './worker.mjs';
import { parseEnqueueArgs } from './cli.mjs';

const config = { workerId: 'test', concurrency: 2, projects: { a: '/tmp/synthetic-a', b: '/tmp/synthetic-b' } };
const ideaConfig = { enabled: true, backlogCap: 10, batchSize: 3, minimumIntervalHours: 24, ideaLabel: 'Idea', proposedState: 'Backlog', approvedState: 'Todo', rejectedState: 'Canceled' };
const manifest = { version: 1, name: 'Synthetic', instructions: [], workspaceId: 'workspace', workspaceUrl: 'https://tracker.example/w', teamId: 'team', projectId: 'project', projectUrl: 'https://tracker.example/w/p', readyLabel: 'agent:ready', ideation: ideaConfig };
const proposal = { title: 'Batch matching', problem: 'Manual matching', benefit: 'Fewer errors', scope: 'Confirm matches', successCriteria: ['Confirm a batch'], effort: 'M', evidence: ['Matching screen'], whyNow: 'Repeated manual work' };

test('ideation CLI requires explicit budget and disallows publishing', () => {
  assert.deepEqual(parseEnqueueArgs('a', ['--ideate', '--proposal-limit', '3']), { projectId: 'a', kind: 'ideation', proposalLimit: 3 });
  for (const flags of [['--ideate'], ['--ideate', '--proposal-limit', '0'], ['--proposal-limit', '2'], ['--ideate', '--proposal-limit', '2', '--publish'], ['--approval-required']]) assert.throws(() => parseEnqueueArgs('a', flags));
});

test('missing Linear API key blocks before model invocation', async () => {
  const previous = process.env.LINEAR_API_KEY; delete process.env.LINEAR_API_KEY;
  const q = createQueue(':memory:', { projects: config.projects });
  try {
    q.enqueue({ projectId: 'a', kind: 'ideation', proposalLimit: 3 });
    await runWorker(config, { once: true, request: requestFor(q), loadManifest: () => manifest,
      run: () => assert.fail('No model without an API key') });
    assert.equal(q.list()[0].state, 'blocked');
    assert.match(q.list()[0].result.summary, /LINEAR_API_KEY is required/);
  } finally {
    q.close();
    if (previous !== undefined) process.env.LINEAR_API_KEY = previous;
  }
});

test('heartbeat loss during API preflight aborts requests and never starts model', async () => {
  const q = createQueue(':memory:', { projects: config.projects, leaseMs: 90 });
  let transport;
  try {
    q.enqueue({ projectId: 'a', kind: 'ideation', proposalLimit: 3 });
    await runWorker(config, { once: true, loadManifest: () => manifest,
      request: requestFor(q, route => { if (route.endsWith('/heartbeat')) throw new Error('Lost lease'); }),
      tracker: (_kind, { fetchImpl }) => { transport = fetchImpl; return { snapshot: async () => {
        await new Promise(resolve => setTimeout(resolve, 40));
        return { remaining: 2 };
      } }; }, run: () => assert.fail('No model after heartbeat loss') });
    assert.equal(q.list()[0].state, 'blocked');
    assert.match(q.list()[0].result.summary, /Heartbeat failed/);
    assert.throws(() => transport('https://example.invalid'), /interrupted/);
  } finally { q.close(); }
});

test('worker ideation preflight, bounded publication and fail-closed gates', async () => {
  for (const mode of ['full', 'unavailable', 'withdrawn', 'malformed', 'failed', 'aborted', 'publish', 'dedup']) {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), 'team-ideas-'));
    const q = createQueue(':memory:', { projects: config.projects });
    const control = new AbortController(); let runs = 0; let publishes = 0;
    try {
      q.enqueue(mode === 'withdrawn' ? { projectId: 'a', issue: 'TEST-1', approvalRequired: true }
        : { projectId: 'a', kind: 'ideation', proposalLimit: 5 });
      const tracker = () => ({
        checkApproved: async () => ({ allowed: false }),
        snapshot: async () => {
          if (mode === 'unavailable') throw new Error('Offline');
          return { remaining: mode === 'full' ? 0 : 2, existing: ['Existing feature'], ideas: [{ title: 'Existing feature', description: 'Task data', secretField: 'not copied' }] };
        },
        inboxComments: async () => [{ id: 'c1', createdAt: '2026-09-16T08:14:00Z', author: 'Owner', body: 'Build a Fastgraphs-style chart' }],
        publishProposals: async (manifest, proposals, options) => {
          publishes++; assert.equal(options.limit, 2); assert.equal(proposals.length, 1); assert.ok(options.jobId);
          return { created: mode === 'dedup' ? [] : [{ identifier: 'TEST-2' }], skipped: mode === 'dedup' ? 1 : 0 };
        },
      });
      await runWorker({ ...config, stateDir }, { once: true, signal: control.signal, request: requestFor(q), tracker,
        loadManifest: checkout => { assert.equal(checkout, config.projects.a); return manifest; },
        run: async ({ args, job }) => {
          runs++; assert.equal(job.proposalLimit, 2);
          const contextPath = args[args.indexOf('--idea-context') + 1];
          assert.ok(path.isAbsolute(contextPath)); assert.equal(statSync(contextPath).mode & 0o777, 0o600);
          const context = JSON.parse(readFileSync(contextPath)); assert.equal(context.proposalLimit, 2);
          assert.deepEqual(context.ownerRequests, [{ at: '2026-09-16T08:14:00Z', author: 'Owner', text: 'Build a Fastgraphs-style chart' }]);
          assert.ok(!JSON.stringify(context).includes('not copied'));
          if (mode === 'aborted') control.abort();
          return { code: mode === 'failed' ? 1 : 0, journal: { outcome: 'ready', issue: null, prUrl: null, summary: 'Evidence', proposals: mode === 'malformed' ? [{}] : [proposal] } };
        } });
      assert.equal(runs, ['full', 'unavailable', 'withdrawn'].includes(mode) ? 0 : 1);
      assert.equal(publishes, ['publish', 'dedup'].includes(mode) ? 1 : 0);
      const job = q.list()[0];
      assert.equal(job.state, ['full', 'withdrawn', 'publish', 'dedup'].includes(mode) ? 'completed' : mode === 'failed' ? 'failed' : 'blocked');
      if (mode === 'publish') assert.match(job.result.summary, /TEST-2/);
      if (mode === 'dedup') assert.match(job.result.summary, /skipped 1/);
    } finally { q.close(); rmSync(stateDir, { recursive: true, force: true }); }
  }
});
test('CLI auto-merge requires explicit publish and preserves existing enqueue options', () => {
  assert.deepEqual(parseEnqueueArgs('a'), { projectId: 'a', publish: false, autoMerge: false });
  assert.equal(parseEnqueueArgs('a', ['--publish']).autoMerge, false);
  assert.throws(() => parseEnqueueArgs('a', ['--auto-merge']), /--auto-merge requires explicit --publish/);
  for (const flags of [['--publish', '--auto-merge'], ['--auto-merge', '--publish']]) {
    assert.deepEqual(parseEnqueueArgs('a', [...flags, '--issue', 'FUM-6', '--key', 'delivery', '--base', 'HEAD', '--model', 'provider/model', '--timeout-minutes', '45']), {
      projectId: 'a', publish: true, autoMerge: true, issue: 'FUM-6', idempotencyKey: 'delivery', base: 'HEAD', model: 'provider/model', timeoutMinutes: 45,
    });
  }
  assert.throws(() => parseEnqueueArgs('a', ['--publish', '--auto-merge', '--auto-merge']), /Duplicate/);
});
test('engine and fetch route to the runner; worker default engine applies only when the job has none', async () => {
  assert.deepEqual(runnerArgs({ engine: 'claude', base: 'origin/main', fetch: true }, '/tmp/a').slice(1), ['--project', '/tmp/a', '--execute', '--cycles', '1', '--base', 'origin/main', '--engine', 'claude', '--fetch']);
  assert.ok(!runnerArgs({ fetch: false }, '/tmp/a').includes('--fetch'));
  // Queue views carry null columns for unpinned jobs; null must not become an argument.
  assert.deepEqual(runnerArgs({ issue: null, engine: null, model: null, kind: 'ideation', proposalLimit: 2 }, '/tmp/a').slice(1), ['--project', '/tmp/a', '--execute', '--cycles', '1', '--ideate', '--proposal-limit', '2']);
  assert.throws(() => validateConfig({ ...config, engine: 'unknown-engine' }), /Invalid engine/);
  assert.deepEqual(parseEnqueueArgs('a', ['--engine', 'claude', '--base', 'origin/master', '--fetch']), { projectId: 'a', publish: false, autoMerge: false, engine: 'claude', base: 'origin/master', fetch: true });
  assert.throws(() => parseEnqueueArgs('a', ['--fetch']), /REMOTE\/BRANCH/);
  for (const [job, expected] of [[{ projectId: 'a' }, 'claude'], [{ projectId: 'a', engine: 'opencode' }, 'opencode']]) {
    const q = createQueue(':memory:', { projects: config.projects });
    try {
      q.enqueue(job); let seen;
      await runWorker({ ...config, engine: 'claude' }, { once: true, request: requestFor(q), run: async ({ args }) => { seen = args; return { code: 0, journal: { outcome: 'idle' } }; } });
      assert.equal(seen[seen.indexOf('--engine') + 1], expected);
    } finally { q.close(); }
  }
});
test('worker only routes auto-merge when explicitly selected, retaining publish and one cycle', () => {
  for (const job of [{}, { publish: true }, { publish: true, autoMerge: false }]) assert.ok(!runnerArgs(job, '/tmp/a').includes('--auto-merge'));
  const args = runnerArgs({ publish: true, autoMerge: true }, '/tmp/a');
  assert.deepEqual(args.slice(1), ['--project', '/tmp/a', '--execute', '--cycles', '1', '--publish', '--auto-merge']);
});
function requestFor(q, observer = () => {}) {
  return async (route, body) => {
    observer(route, body);
    if (route === '/claim') return q.claim(body);
    const project = /^\/projects\/([^/]+)\/manifest$/.exec(route); if (project) return q.registerProject(project[1], body);
    if (route.endsWith('/evidence')) return q.evidence(route.split('/')[2], body);
    const [, , id, method] = route.split('/'); return q[method](id, body);
  };
}
test('absolute runner and configured checkout routing with structured optional arguments', () => {
  const args = runnerArgs({ issue: 'FUM-6', base: 'HEAD', model: 'provider/model', timeoutMinutes: 45, publish: false }, '/tmp/a path');
  assert.ok(args[0].startsWith('/')); assert.ok(args[0].endsWith('/runner.mjs'));
  assert.deepEqual(args.slice(1), ['--project', '/tmp/a path', '--execute', '--cycles', '1', '--issue', 'FUM-6', '--base', 'HEAD', '--model', 'provider/model', '--timeout-minutes', '45']);
  assert.ok(runnerArgs({ publish: true }, '/tmp/a').includes('--publish'));
  assert.deepEqual(parseJournal('noise\n{\n "outcome":"ready", "nested": {"x":1}\n}\n'), { outcome: 'ready', nested: { x: 1 } });
});
test('--once executes exactly one job even with concurrency two', async () => {
  const q = createQueue(':memory:', { projects: config.projects });
  try {
    q.enqueue({ projectId: 'a' }); q.enqueue({ projectId: 'b' }); let runs = 0;
    await runWorker(config, { once: true, request: requestFor(q), run: async ({ args }) => {
      runs++; assert.equal(args[2], config.projects.a); return { code: 0, journal: { outcome: 'idle', summary: 'private model text' } };
    } });
    assert.equal(runs, 1); assert.deepEqual(q.list().map(j => j.state), ['completed', 'queued']);
    assert.ok(!JSON.stringify(q.list()).includes('private model text'));
  } finally { q.close(); }
});
test('heartbeat failure aborts execution and reports blocked', async () => {
  const q = createQueue(':memory:', { projects: config.projects, leaseMs: 60 });
  try {
    q.enqueue({ projectId: 'a' }); let aborted = false; let heartbeats = 0;
    const request = requestFor(q, route => { if (route.endsWith('/heartbeat')) { heartbeats++; throw new Error('network lost'); } });
    await runWorker(config, { once: true, request, run: ({ signal }) => new Promise(resolve => {
      signal.addEventListener('abort', () => { aborted = true; resolve({ code: 130 }); }, { once: true });
    }) });
    assert.equal(aborted, true); assert.equal(heartbeats, 1); assert.equal(q.list()[0].state, 'blocked');
  } finally { q.close(); }
});
test('slots run different projects concurrently and serialize same-project jobs', async () => {
  const q = createQueue(':memory:', { projects: config.projects }); const control = new AbortController();
  try {
    q.enqueue({ projectId: 'a', issue: 'FUM-1' }); q.enqueue({ projectId: 'a', issue: 'FUM-2' }); q.enqueue({ projectId: 'b' });
    const active = new Set(); let max = 0; let completed = 0;
    const baseRequest = requestFor(q);
    await runWorker(config, { signal: control.signal, pollMs: 1, request: async (route, body) => {
      const result = await baseRequest(route, body);
      if (route.endsWith('/complete') && ++completed === 3) control.abort(); return result;
    }, run: async ({ job }) => {
      assert.ok(!active.has(job.projectId)); active.add(job.projectId); max = Math.max(max, active.size);
      await new Promise(resolve => setTimeout(resolve, 20)); active.delete(job.projectId);
      return { code: 0, journal: { outcome: 'ready' } };
    } });
    assert.equal(max, 2); assert.equal(completed, 3);
  } finally { q.close(); }
});
test('shutdown aborts active runner; heartbeat requests never overlap', async () => {
  const q = createQueue(':memory:', { projects: config.projects, leaseMs: 120 }); const control = new AbortController();
  try {
    q.enqueue({ projectId: 'a' }); let active = 0; let max = 0; let beats = 0;
    const base = requestFor(q);
    await runWorker(config, { once: true, signal: control.signal, request: async (route, body) => {
      if (route.endsWith('/heartbeat')) {
        active++; max = Math.max(max, active); await new Promise(resolve => setTimeout(resolve, 50));
        active--; if (++beats === 2) control.abort();
      }
      return base(route, body);
    }, run: ({ signal }) => new Promise(resolve => signal.addEventListener('abort', () => resolve({ code: 130 }), { once: true })) });
    assert.equal(max, 1); assert.equal(beats, 2); assert.equal(q.list()[0].state, 'blocked');
  } finally { q.close(); }
});
test('exit codes and journal outcomes map conservatively', async () => {
  for (const [execution, expected] of [[{ code: 0 }, 'failed'], [{ code: 2 }, 'blocked'], [{ code: 1 }, 'failed'], [{ code: 130 }, 'blocked'], [{ code: 0, journal: { outcome: 'ready' } }, 'completed']]) {
    const q = createQueue(':memory:', { projects: config.projects });
    try { q.enqueue({ projectId: 'a' }); await runWorker(config, { once: true, request: requestFor(q), run: async () => execution }); assert.equal(q.list()[0].state, expected); }
    finally { q.close(); }
  }
});
test('real child process retains local logs and parses bounded final journal without passing token', async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'team-worker-'));
  const previous = process.env.AGENT_TEAM_TOKEN; process.env.AGENT_TEAM_TOKEN = 'private-control-plane-token';
  const priorLinear = process.env.LINEAR_API_KEY; const priorFuture = process.env.AGENT_TEAM_FUTURE_TOKEN;
  process.env.LINEAR_API_KEY = 'synthetic-private-api-key'; process.env.AGENT_TEAM_FUTURE_TOKEN = 'synthetic-future-token';
  try {
    const result = await runProcess({ stateDir, job: { id: 'synthetic' }, signal: new AbortController().signal,
      args: ['-e', `if (process.env.AGENT_TEAM_TOKEN || process.env.LINEAR_API_KEY || process.env.AGENT_TEAM_FUTURE_TOKEN) process.exit(7); console.log('x'.repeat(300000)); console.error('local stderr'); console.log(JSON.stringify({outcome:'ready'}));`] });
    assert.equal(result.code, 0); assert.equal(result.journal.outcome, 'ready');
    assert.ok(readFileSync(result.evidence, 'utf8').length > 300000);
    assert.match(readFileSync(path.join(stateDir, 'synthetic.stderr.log'), 'utf8'), /local stderr/);
  } finally {
    if (previous === undefined) delete process.env.AGENT_TEAM_TOKEN; else process.env.AGENT_TEAM_TOKEN = previous;
    if (priorLinear === undefined) delete process.env.LINEAR_API_KEY; else process.env.LINEAR_API_KEY = priorLinear;
    if (priorFuture === undefined) delete process.env.AGENT_TEAM_FUTURE_TOKEN; else process.env.AGENT_TEAM_FUTURE_TOKEN = priorFuture;
    rmSync(stateDir, { recursive: true, force: true });
  }
});
test('real child process is terminated on abort', async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'team-worker-')); const control = new AbortController();
  const timer = setTimeout(() => control.abort(), 100);
  try {
    const result = await runProcess({ stateDir, job: { id: 'synthetic' }, signal: control.signal,
      args: ['-e', 'setInterval(() => {}, 1000)'] });
    assert.equal(result.signal, 'SIGTERM');
  } finally { clearTimeout(timer); rmSync(stateDir, { recursive: true, force: true }); }
});
test('worker gives supervisor time to kill a separately detached TERM-ignoring child', async () => {
  assert.equal(RUNNER_STOP_GRACE_MS, 20_000);
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'team-supervisor-'));
  const control = new AbortController(); let pids; let execution;
  const childCode = `process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000);`;
  const supervisorCode = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], {
      detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    });
    console.log(JSON.stringify({supervisor: process.pid, child: child.pid}));
    process.on('SIGTERM', () => {
      process.kill(-child.pid, 'SIGTERM');
      setTimeout(() => process.kill(-child.pid, 'SIGKILL'), 5000);
    });
    child.on('message', () => console.log('READY'));
    child.on('exit', (code, signal) => {
      console.log(JSON.stringify({outcome: 'blocked', childSignal: signal}));
      process.exitCode = 130;
    });
  `;
  const log = path.join(stateDir, 'supervisor.stdout.log');
  try {
    execution = runProcess({ stateDir, job: { id: 'supervisor' }, signal: control.signal, args: ['-e', supervisorCode] });
    const deadline = Date.now() + 5000;
    while (true) {
      const output = readFileSync(log, 'utf8');
      if (output.includes('\n')) pids = JSON.parse(output.split('\n')[0]);
      if (output.includes('READY')) break;
      assert.ok(Date.now() < deadline, 'synthetic supervisor becomes ready');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const started = Date.now(); control.abort();
    const result = await execution;
    assert.ok(Date.now() - started >= 4900, 'worker waits through supervisor cleanup grace');
    assert.equal(result.code, 130); assert.equal(result.signal, null);
    assert.equal(result.journal.childSignal, 'SIGKILL');
    assert.throws(() => process.kill(pids.child, 0), { code: 'ESRCH' });
    assert.throws(() => process.kill(pids.supervisor, 0), { code: 'ESRCH' });
  } finally {
    control.abort();
    // Ensure failed assertions cannot strand either synthetic process group.
    for (const pid of Object.values(pids ?? {})) {
      try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await execution;
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('workers register manifests, stream run evidence from the run directory, and answer chat jobs', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'team-evidence-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = path.join(root, 'checkout'); const runId = '2026-09-16T09-00-00-000Z-abcdef12';
  const runDir = path.join(checkout, '.agent-team', 'runs', runId); mkdirSync(runDir, { recursive: true });
  const worktree = path.join(root, 'worktree'); mkdirSync(worktree);
  writeFileSync(path.join(checkout, '.agent-team.json'), JSON.stringify({ ...manifest, queueProjectId: 'a', ownerInboxIssue: 'FUM-10' }));
  const q = createQueue(':memory:', { projects: { a: {}, b: {} } });
  try {
    q.enqueue({ projectId: 'a', issue: 'FUM-1' });
    const cfg = { ...config, projects: { a: checkout, b: '/tmp/synthetic-b' } };
    await runWorker(cfg, { once: true, request: requestFor(q), evidenceMs: 15, run: async () => {
      writeFileSync(path.join(checkout, '.agent-team', 'lock.json'), JSON.stringify({ id: runId, pid: 1 }));
      writeFileSync(path.join(runDir, 'journal.json'), JSON.stringify({ id: runId, state: 'running', engine: 'claude', options: { issue: 'FUM-1' }, worktree, startedAt: '2026-09-16T09:00:00.000Z' }));
      writeFileSync(path.join(runDir, 'events.jsonl'), [{ type: 'assistant', message: { content: [{ type: 'text', text: 'Working on it.' }, { type: 'tool_use', id: 'toolu_pm', name: 'Agent', input: { subagent_type: 'team-pm', description: 'Claim FUM-1' } }] } },
        { type: 'assistant', parent_tool_use_id: 'toolu_pm', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: `${worktree}/README.md` } }] } }].map(e => JSON.stringify(e)).join('\n') + '\n');
      await new Promise(resolve => setTimeout(resolve, 60));
      writeFileSync(path.join(runDir, 'journal.json'), JSON.stringify({ id: runId, state: 'ready', engine: 'claude', issue: 'FUM-1', worktree, startedAt: '2026-09-16T09:00:00.000Z', finishedAt: '2026-09-16T09:05:00.000Z', summary: 'Delivered' }));
      rmSync(path.join(checkout, '.agent-team', 'lock.json'));
      return { code: 0, journal: { outcome: 'ready' } };
    } });
    const registry = q.projectsList().find(p => p.id === 'a');
    assert.equal(registry.manifest.name, 'Synthetic'); assert.equal(registry.workerId, 'test');
    const evidence = q.evidenceList()[0];
    assert.equal(evidence.run.state, 'ready'); assert.equal(evidence.run.issue, 'FUM-1'); assert.equal(evidence.steps[0].text, 'Working on it.');
    assert.equal(latestWorktree(checkout), worktree);
    const chat = q.enqueue({ projectId: 'a', kind: 'chat', role: 'team-pm', issue: 'FUM-10', message: 'Jeff?' });
    let answered;
    await runWorker(cfg, { once: true, request: requestFor(q), tracker: () => ({}), chatAnswer: async args => { answered = args; return { reply: 'On it, nothing blocks.' }; } });
    assert.equal(answered.role, 'team-pm'); assert.equal(answered.issue, 'FUM-10'); assert.equal(answered.cwd, worktree); assert.equal(answered.manifest.name, 'Synthetic');
    assert.ok(answered.work.some(line => line.includes('FUM-1 run')));
    assert.deepEqual([q.list().find(j => j.id === chat.id).state, q.list().find(j => j.id === chat.id).result.summary], ['completed', 'On it, nothing blocks.']);
    q.enqueue({ projectId: 'a', kind: 'chat', role: 'team-dev', issue: 'FUM-10', message: 'x' });
    await runWorker(cfg, { once: true, request: requestFor(q), tracker: () => ({}), chatAnswer: async () => { throw new Error('Claude usage limit reached'); } });
    assert.match(q.list().at(-1).result.summary, /No reply: Claude usage limit/); assert.equal(q.list().at(-1).state, 'blocked');
  } finally { q.close(); }
});

test('owner settings from the coordinator reach the runner as a settings file and shape ideation preflight', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'team-settings-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = path.join(root, 'checkout'); mkdirSync(checkout);
  writeFileSync(path.join(checkout, '.agent-team.json'), JSON.stringify({ ...manifest, queueProjectId: 'a' }));
  const q = createQueue(':memory:', { projects: { a: {}, b: {} } });
  try {
    q.saveSettings('a', { overrides: { pm: { autonomy: 'act' }, engine: { default: 'claude' } }, author: 'owner' });
    q.enqueue({ projectId: 'a', issue: 'FUM-1' });
    let seen;
    await runWorker({ ...config, stateDir: path.join(root, 'state'), projects: { a: checkout, b: '/tmp/synthetic-b' } }, { once: true, request: requestFor(q), run: async ({ args }) => { seen = args; return { code: 0, journal: { outcome: 'idle' } }; } });
    const file = seen[seen.indexOf('--settings-file') + 1];
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { pm: { autonomy: 'act' }, engine: { default: 'claude' } });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    // Without overrides no settings file is passed at all.
    q.saveSettings('a', { overrides: {}, author: 'owner' });
    q.enqueue({ projectId: 'a', issue: 'FUM-2' });
    await runWorker({ ...config, stateDir: path.join(root, 'state'), projects: { a: checkout, b: '/tmp/synthetic-b' } }, { once: true, request: requestFor(q), run: async ({ args }) => { seen = args; return { code: 0, journal: { outcome: 'idle' } }; } });
    assert.ok(!seen.includes('--settings-file'));
  } finally { q.close(); }
});

test('the coordinator-resolved team and environment reach the runner as files', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'team-resolve-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = path.join(root, 'checkout'); mkdirSync(checkout);
  writeFileSync(path.join(checkout, '.agent-team.json'), JSON.stringify({ ...manifest, queueProjectId: 'a' }));
  const q = createQueue(':memory:', { projects: { a: {}, b: {} } });
  try {
    q.saveSettings('a', { overrides: { worker: { environment: 'browser' } }, author: 'owner' });
    q.enqueue({ projectId: 'a', issue: 'FUM-1' });
    let seen;
    const request = requestFor(q);
    const routed = async (route, body) => {
      const resolve = /^\/projects\/([^/]+)\/(team|environment)$/.exec(route);
      if (resolve && body === undefined) return resolve[2] === 'team' ? q.projectTeam(resolve[1]) : q.projectEnvironment(resolve[1]);
      if (route === '/projects/a/settings' && body === undefined) return q.settings('a');
      return request(route, body);
    };
    await runWorker({ ...config, stateDir: path.join(root, 'state'), projects: { a: checkout, b: '/tmp/synthetic-b' } }, { once: true, request: routed, run: async ({ args }) => { seen = args; return { code: 0, journal: { outcome: 'idle' } }; } });
    const team = JSON.parse(readFileSync(seen[seen.indexOf('--team-file') + 1], 'utf8'));
    assert.equal(team.id, 'default'); assert.equal(team.roles, null, 'a version 1 manifest delegates to every subagent'); assert.ok(team.agents['team-coordinator'].prompt);
    const environment = JSON.parse(readFileSync(seen[seen.indexOf('--environment-file') + 1], 'utf8'));
    assert.equal(environment.id, 'browser'); assert.deepEqual(environment.capabilities, ['browser']);
    assert.equal(statSync(seen[seen.indexOf('--team-file') + 1]).mode & 0o777, 0o600);
  } finally { q.close(); }
});

test('the memory and team shims follow the platform: shell scripts everywhere, .cmd launchers too on Windows, PATH in its own spelling', async () => {
  const { installMemoryShim, memoryEnvironment } = await import('./worker.mjs');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'worker-shim-'));
  try {
    const posix = installMemoryShim(path.join(dir, 'posix'), { platform: 'linux' });
    assert.equal(posix, path.join(dir, 'posix', 'memory'));
    assert.deepEqual(readdirSync(path.join(dir, 'posix')).sort(), ['memory', 'team']);
    assert.match(readFileSync(posix, 'utf8'), /^#!\/bin\/sh\nexec ".*" ".*memory-cli\.mjs" "\$@"\n$/);
    installMemoryShim(path.join(dir, 'windows'), { platform: 'win32' });
    assert.deepEqual(readdirSync(path.join(dir, 'windows')).sort(), ['memory', 'memory.cmd', 'team', 'team.cmd']);
    assert.match(readFileSync(path.join(dir, 'windows', 'team.cmd'), 'utf8'), /^@echo off\r\n".*" ".*channel-cli\.mjs" %\*\r\n$/);
    const job = { id: 'j', projectId: 'a', workerId: 'w', leaseToken: 'lease' };
    const spelled = memoryEnvironment({ coordinatorUrl: 'http://127.0.0.1:4310', job, binDir: '/bin/shims', env: { Path: `C:\\tools${path.delimiter}C:\\node`, HOME: 'h' } });
    assert.deepEqual(Object.keys(spelled), ['Path', 'AGENT_TEAM_MEMORY_URL', 'AGENT_TEAM_MEMORY_JOB', 'AGENT_TEAM_MEMORY_PROJECT', 'AGENT_TEAM_MEMORY_LEASE']);
    assert.equal(spelled.Path, `/bin/shims${path.delimiter}C:\\tools${path.delimiter}C:\\node`);
    assert.equal(spelled.AGENT_TEAM_MEMORY_LEASE, 'w:lease');
    assert.equal(memoryEnvironment({ coordinatorUrl: 'http://127.0.0.1:4310', job, binDir: '/bin/shims', env: {} }).PATH, `/bin/shims${path.delimiter}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the coordinator client names the rejected field on a failed request and nothing more', async () => {
  const fetchImpl = async (url, init) => new Response(JSON.stringify({ error: 'Invalid body', token: init.headers.authorization }), { status: 400, headers: { 'content-type': 'application/json' } });
  const request = createClient('http://127.0.0.1:4310', 'a'.repeat(32), fetchImpl);
  await assert.rejects(request('/messages/x', { body: 'bell\x07' }), error => error.message === 'Coordinator request failed (400): Invalid body');
  const plain = createClient('http://127.0.0.1:4310', 'a'.repeat(32), async () => new Response('nope', { status: 502 }));
  await assert.rejects(plain('/health'), /^Error: Coordinator request failed \(502\)$/);
});
