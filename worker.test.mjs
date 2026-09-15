import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createQueue } from './queue.mjs';
import { runWorker, runnerArgs, parseJournal, runProcess, RUNNER_STOP_GRACE_MS } from './worker.mjs';
import { parseEnqueueArgs } from './cli.mjs';

const config = { workerId: 'test', concurrency: 2, projects: { a: '/tmp/synthetic-a', b: '/tmp/synthetic-b' } };
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
test('worker only routes auto-merge when explicitly selected, retaining publish and one cycle', () => {
  for (const job of [{}, { publish: true }, { publish: true, autoMerge: false }]) assert.ok(!runnerArgs(job, '/tmp/a').includes('--auto-merge'));
  const args = runnerArgs({ publish: true, autoMerge: true }, '/tmp/a');
  assert.deepEqual(args.slice(1), ['--project', '/tmp/a', '--execute', '--cycles', '1', '--publish', '--auto-merge']);
});
function requestFor(q, observer = () => {}) {
  return async (route, body) => {
    observer(route, body);
    if (route === '/claim') return q.claim(body);
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
  try {
    const result = await runProcess({ stateDir, job: { id: 'synthetic' }, signal: new AbortController().signal,
      args: ['-e', `if (process.env.AGENT_TEAM_TOKEN) process.exit(7); console.log('x'.repeat(300000)); console.error('local stderr'); console.log(JSON.stringify({outcome:'ready'}));`] });
    assert.equal(result.code, 0); assert.equal(result.journal.outcome, 'ready');
    assert.ok(readFileSync(result.evidence, 'utf8').length > 300000);
    assert.match(readFileSync(path.join(stateDir, 'synthetic.stderr.log'), 'utf8'), /local stderr/);
  } finally {
    if (previous === undefined) delete process.env.AGENT_TEAM_TOKEN; else process.env.AGENT_TEAM_TOKEN = previous;
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
