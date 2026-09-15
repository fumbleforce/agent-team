import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync, readFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { requireToken } from './queue.mjs';

const runner = fileURLToPath(new URL('./runner.mjs', import.meta.url));
export function runnerArgs(job, checkout) {
  const args = [runner, '--project', checkout, '--execute', '--cycles', '1'];
  for (const [key, flag] of [['issue', '--issue'], ['base', '--base'], ['model', '--model'], ['timeoutMinutes', '--timeout-minutes']]) {
    if (job[key] !== undefined) args.push(flag, String(job[key]));
  }
  if (job.publish === true) args.push('--publish');
  if (job.autoMerge === true) args.push('--auto-merge');
  return args;
}
export function createClient(url, token, fetchImpl = fetch) {
  requireToken(token);
  const base = new URL(url);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('Invalid coordinator URL');
  return async (route, body) => {
    const response = await fetchImpl(new URL(route, base), { method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Coordinator request failed (${response.status})`);
    return response.json();
  };
}

export function parseJournal(output) {
  // Runner prints a final pretty-printed journal, potentially after other output.
  for (let index = output.lastIndexOf('{'); index >= 0; index = output.lastIndexOf('{', index - 1)) {
    try { return JSON.parse(output.slice(index)); } catch { /* try outer object */ }
    if (index === 0) break;
  }
  return null;
}
// Runner needs 5 seconds to kill its separately detached OpenCode group. Keep
// this outer grace comfortably longer. SIGKILL/crashes cannot guarantee cleanup;
// blocked/failed jobs quarantine the project until operator inspection/requeue.
export const RUNNER_STOP_GRACE_MS = 20_000;
export function runProcess({ args, signal, stateDir, job, stopGraceMs = RUNNER_STOP_GRACE_MS }) {
  if (!Number.isInteger(stopGraceMs) || stopGraceMs < 1) throw new Error('Invalid runner stop grace');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const prefix = path.join(stateDir, job.id);
  const stdout = openSync(`${prefix}.stdout.log`, 'a', 0o600);
  const stderr = openSync(`${prefix}.stderr.log`, 'a', 0o600);
  return new Promise((resolve, reject) => {
    let child;
    try {
      const env = { ...process.env }; delete env.AGENT_TEAM_TOKEN;
      child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', 'pipe', stderr], env });
    } catch (error) { closeSync(stdout); closeSync(stderr); reject(error); return; }
    let output = ''; let killTimer; let stopped = false;
    // Local logs contain model output; API results never include these contents.
    child.stdout.on('data', chunk => {
      // Synchronous append to an already-open descriptor keeps memory bounded.
      writeSync(stdout, chunk); output = (output + chunk.toString()).slice(-262144);
    });
    const kill = signalName => { try { process.kill(-child.pid, signalName); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
    const stop = () => {
      if (stopped) return; stopped = true; kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), stopGraceMs);
    };
    signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop();
    child.once('error', error => { reject(error); });
    child.once('close', (code, exitSignal) => {
      clearTimeout(killTimer); signal.removeEventListener('abort', stop);
      // The group may still contain descendants after the group leader exits.
      if (stopped) kill('SIGKILL');
      closeSync(stdout); closeSync(stderr);
      resolve({ code, signal: exitSignal, journal: parseJournal(output), evidence: `${prefix}.stdout.log` });
    });
  });
}
const sleep = (ms, signal) => new Promise(resolve => {
  if (signal?.aborted) return resolve();
  const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms); signal?.addEventListener('abort', done, { once: true });
});
export function validateConfig(config) {
  if (!config || typeof config.workerId !== 'string' || !/^[\w.-]{1,128}$/.test(config.workerId)) throw new Error('Invalid workerId');
  if (!Number.isInteger(config.concurrency ?? 1) || (config.concurrency ?? 1) < 1 || (config.concurrency ?? 1) > 32) throw new Error('Invalid concurrency');
  if (!config.projects || !Object.keys(config.projects).length || Object.values(config.projects).some(p => typeof p !== 'string' || !path.isAbsolute(p))) throw new Error('Projects must map IDs to absolute checkout paths');
}
export async function runWorker(config, { once = false, signal = new AbortController().signal,
  request = createClient(config.coordinatorUrl, process.env.AGENT_TEAM_TOKEN), run = runProcess,
  pollMs = 2000, onError = error => console.error(error.message) } = {}) {
  validateConfig(config);
  const projectIds = Object.keys(config.projects);
  async function execute(job) {
    if (!Object.hasOwn(config.projects, job.projectId) || !/^[a-f0-9-]{36}$/.test(job.id) || !Number.isFinite(job.leaseMs) || job.leaseMs < 1) throw new Error('Invalid claimed job');
    const control = new AbortController(); const heartbeatControl = new AbortController();
    let interruption;
    const stop = reason => { interruption ??= reason; control.abort(); };
    const shutdown = () => stop('Worker interrupted; inspect execution before requeue');
    signal.addEventListener('abort', shutdown, { once: true }); if (signal.aborted) shutdown();
    const credentials = { workerId: config.workerId, leaseToken: job.leaseToken };
    const heartbeat = (async () => {
      while (!heartbeatControl.signal.aborted) {
        await sleep(Math.max(1, Math.floor(job.leaseMs / 3)), heartbeatControl.signal);
        if (heartbeatControl.signal.aborted) break;
        try { await request(`/jobs/${job.id}/heartbeat`, credentials); }
        catch { stop('Heartbeat failed; lease ownership uncertain'); break; }
      }
    })();
    const cap = setTimeout(() => stop('Worker execution time cap exceeded'), (Math.min(job.timeoutMinutes ?? 45, 120) + 2) * 60_000);
    let execution;
    try { execution = await run({ job, args: runnerArgs(job, config.projects[job.projectId]), signal: control.signal,
      stateDir: path.resolve(config.stateDir ?? '.agent-team-worker') }); }
    catch { execution = { code: 1 }; }
    finally {
      clearTimeout(cap); heartbeatControl.abort(); await heartbeat;
      signal.removeEventListener('abort', shutdown);
    }
    const outcome = interruption ? 'blocked' : execution.code === 0 ? (['ready', 'idle'].includes(execution.journal?.outcome) ? execution.journal.outcome : 'failed') : [2, 130].includes(execution.code) ? 'blocked' : 'failed';
    const summary = interruption ?? (execution.code === 0 && outcome === 'failed' ? 'Runner exited without a valid ready/idle journal' : `Runner ${outcome} (exit ${execution.code ?? 'signal'})`);
    const result = { outcome, summary };
    if (typeof execution.evidence === 'string' && execution.evidence.length <= 1024 && !/[\x00-\x1f\x7f]/.test(execution.evidence)) result.evidence = execution.evidence;
    try { await request(`/jobs/${job.id}/${['ready', 'idle'].includes(outcome) ? 'complete' : 'fail'}`, { ...credentials, result }); }
    catch (error) { onError(error); }
  }
  async function slot() {
    do {
      if (signal.aborted) return;
      try {
        const job = await request('/claim', { workerId: config.workerId, projectIds });
        if (job) await execute(job);
        else if (!once) await sleep(pollMs, signal);
      } catch (error) { onError(error); if (!once) await sleep(pollMs, signal); }
    } while (!once && !signal.aborted);
  }
  await Promise.all(Array.from({ length: once ? 1 : config.concurrency ?? 1 }, slot));
}
export async function main(args = process.argv.slice(2)) {
  let configPath; let once = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' && args[i + 1]) configPath = args[++i];
    else if (args[i] === '--once') once = true;
    else throw new Error(`Unknown or incomplete option ${args[i]}`);
  }
  if (!configPath) throw new Error('Usage: node worker.mjs --config worker.json [--once]');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const control = new AbortController(); const stop = () => control.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try { await runWorker(config, { once, signal: control.signal }); }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
