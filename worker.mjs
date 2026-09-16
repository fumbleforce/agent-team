import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync, readFileSync, writeSync, renameSync, readdirSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { requireToken } from './queue.mjs';
import { ENGINES } from './engines.mjs';
import { createLinearClient } from './linear-api.mjs';
import { validateIdeation } from './idea-schema.mjs';
import { validateResult } from './runner.mjs';
import { RUN_ID, memberActivity, runEvidence } from './evidence.mjs';
import { answer } from './chat.mjs';

const runner = fileURLToPath(new URL('./runner.mjs', import.meta.url));
export function runnerArgs(job, checkout, ideaContext) {
  const args = [runner, '--project', checkout, '--execute', '--cycles', '1'];
  for (const [key, flag] of [['issue', '--issue'], ['base', '--base'], ['engine', '--engine'], ['model', '--model'], ['timeoutMinutes', '--timeout-minutes']]) {
    if (job[key] !== undefined && job[key] !== null) args.push(flag, String(job[key]));
  }
  if (job.fetch === true) args.push('--fetch');
  if (job.publish === true) args.push('--publish');
  if (job.autoMerge === true) args.push('--auto-merge');
  if (job.kind === 'ideation') {
    args.push('--ideate', '--proposal-limit', String(job.proposalLimit));
    if (ideaContext) args.push('--idea-context', ideaContext);
  }
  if (job.approvalRequired === true) args.push('--approval-required');
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
      const env = { ...process.env };
      for (const key of Object.keys(env)) if (key === 'LINEAR_API_KEY' || key.startsWith('AGENT_TEAM_')) delete env[key];
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
// The newest retained run worktree: sparse-excluded secrets make it the safe place to read code.
export function latestWorktree(checkout) {
  const runsDir = path.join(checkout, '.agent-team', 'runs');
  let ids = []; try { ids = readdirSync(runsDir).filter(id => RUN_ID.test(id)).sort().reverse(); } catch { return null; }
  for (const id of ids) {
    try { const worktree = JSON.parse(readFileSync(path.join(runsDir, id, 'journal.json'), 'utf8')).worktree; if (worktree && existsSync(worktree)) return worktree; } catch { /* unreadable journal */ }
  }
  return null;
}
export function validateConfig(config) {
  if (!config || typeof config.workerId !== 'string' || !/^[\w.-]{1,128}$/.test(config.workerId)) throw new Error('Invalid workerId');
  if (config.engine !== undefined && !ENGINES.includes(config.engine)) throw new Error('Invalid engine');
  if (!Number.isInteger(config.concurrency ?? 1) || (config.concurrency ?? 1) < 1 || (config.concurrency ?? 1) > 32) throw new Error('Invalid concurrency');
  if (!config.projects || !Object.keys(config.projects).length || Object.values(config.projects).some(p => typeof p !== 'string' || !path.isAbsolute(p))) throw new Error('Projects must map IDs to absolute checkout paths');
}
export async function runWorker(config, { once = false, signal = new AbortController().signal,
  request = createClient(config.coordinatorUrl, process.env.AGENT_TEAM_TOKEN), run = runProcess, chatAnswer = answer,
  linear = createLinearClient, loadManifest = checkout => JSON.parse(readFileSync(path.join(checkout, '.agent-team.json'), 'utf8')),
  pollMs = 2000, evidenceMs = 20_000, registerMs = 60_000, onError = error => console.error(error.message) } = {}) {
  validateConfig(config);
  const projectIds = Object.keys(config.projects);
  // Manifests registered here let a remote coordinator, intake and dashboard work without checkouts.
  async function register() {
    for (const [projectId, checkout] of Object.entries(config.projects)) {
      try { await request(`/projects/${projectId}/manifest`, { workerId: config.workerId, manifest: await loadManifest(checkout) }); } catch (error) { onError(error); }
    }
  }
  function reporter(job, credentials, checkout) {
    let runId = null;
    const report = async () => {
      try {
        if (!runId) { const lock = JSON.parse(readFileSync(path.join(checkout, '.agent-team', 'lock.json'), 'utf8')); if (RUN_ID.test(lock.id ?? '')) runId = lock.id; }
        if (!runId) return;
        const dir = path.join(checkout, '.agent-team', 'runs', runId);
        if (!existsSync(path.join(dir, 'journal.json'))) return;
        await request(`/jobs/${job.id}/evidence`, { ...credentials, evidence: runEvidence(job.projectId, dir, runId, { stepLimit: 200 }) });
      } catch { /* evidence is best effort; the job result is authoritative */ }
    };
    const timer = setInterval(report, evidenceMs);
    return { stop: async () => { clearInterval(timer); await report(); } };
  }
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
    let execution; let apiSummary;
    const stateDir = path.resolve(config.stateDir ?? '.agent-team-worker');
    const checkout = config.projects[job.projectId];
    const active = () => { if (control.signal.aborted) throw new Error('Execution interrupted'); };
    try {
      let client; let manifest; let ideaContext;
      // Jobs without an explicit engine run on the worker's configured default.
      let boundedJob = job.engine === undefined && config.engine !== undefined ? { ...job, engine: config.engine } : job;
      let skip = false;
      if (job.kind === 'ideation' || job.approvalRequired === true) {
        active();
        manifest = await loadManifest(checkout);
        const ideation = validateIdeation(manifest.ideation);
        client = await linear({ apiKey: process.env.LINEAR_API_KEY, fetchImpl: (url, init = {}) => {
          active();
          return fetch(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, control.signal]) : control.signal });
        } });
        active();
        if (job.kind === 'ideation') {
          if (!Number.isInteger(job.proposalLimit) || job.proposalLimit < 1 || job.proposalLimit > 10
            || job.issue || job.publish || job.autoMerge || job.approvalRequired) throw new Error('Invalid ideation job');
          const snapshot = await client.snapshot(manifest);
          active();
          if (!Number.isInteger(snapshot.remaining) || snapshot.remaining < 0) throw new Error('Invalid capacity');
          const limit = Math.min(job.proposalLimit, ideation.batchSize, snapshot.remaining);
          if (!limit) { skip = true; apiSummary = 'Idea backlog is full; no model started'; }
          else {
            boundedJob = { ...boundedJob, proposalLimit: limit };
            // The context becomes one prompt argument; keep it far below the 128 KiB argv limit.
            const issues = (snapshot.allIssues ?? snapshot.ideas ?? []).slice(0, 200);
            const inbox = typeof client.inboxComments === 'function' ? await client.inboxComments(manifest) : [];
            active();
            const context = { remaining: snapshot.remaining, proposalLimit: limit,
              existing: (snapshot.existing ?? []).filter(value => typeof value === 'string').slice(0, 400).map(value => value.slice(0, 200)),
              ideas: issues.map(issue => ({ title: String(issue.title ?? '').slice(0, 200), description: String(issue.description ?? '').slice(0, 400) })),
              ownerRequests: inbox.map(comment => ({ at: String(comment.createdAt ?? ''), author: String(comment.author ?? ''), text: String(comment.body ?? '').slice(0, 1500) })) };
            mkdirSync(stateDir, { recursive: true, mode: 0o700 });
            ideaContext = path.join(stateDir, `${job.id}.ideas.json`);
            // Atomic replacement supports inspected requeues without following symlinks.
            const temporary = `${ideaContext}.${randomUUID()}.tmp`;
            const fd = openSync(temporary, 'wx', 0o600);
            try { writeSync(fd, JSON.stringify(context)); } finally { closeSync(fd); }
            renameSync(temporary, ideaContext);
          }
        } else {
          if (!job.issue) throw new Error('Approval requires a pinned issue');
          const approval = await client.checkApproved(manifest, job.issue);
          active();
          if (approval.allowed !== true) { skip = true; apiSummary = 'Owner approval withdrawn or unavailable; no model started'; }
        }
      }
      active();
      if (job.kind === 'chat') {
        manifest ??= await loadManifest(checkout);
        client ??= await linear({ apiKey: process.env.LINEAR_API_KEY, fetchImpl: (url, init = {}) => { active(); return fetch(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, control.signal]) : control.signal }); } });
        const work = memberActivity({ projects: { [job.projectId]: checkout }, role: job.role, runLimit: 6 }).flatMap(item => [
          `${item.run.issue ?? 'ideation'} run ${item.run.id}: ${item.run.state}${item.run.delivery ? `, delivery ${item.run.delivery}` : ''}${item.run.prUrl ? ` (${item.run.prUrl})` : ''}`,
          ...item.steps.slice(-3).map(step => `${item.run.issue ?? 'ideation'}: ${step.text}`)]).slice(0, 18);
        const replied = await chatAnswer({ linear: client, manifest, role: job.role, issue: job.issue, message: job.message, cwd: latestWorktree(checkout) ?? checkout, work, runDir: path.join(stateDir, 'chat'), signal: control.signal });
        execution = { code: 0, journal: { outcome: 'ready' } }; apiSummary = replied.reply.slice(0, 1900);
      } else if (skip) execution = { code: 0, journal: { outcome: 'idle' } };
      else {
        const evidence = reporter(job, credentials, checkout);
        try { execution = await run({ job: boundedJob, args: runnerArgs(boundedJob, checkout, ideaContext), signal: control.signal, stateDir }); }
        finally { await evidence.stop(); }
      }
      active();
      if (!skip && job.kind === 'ideation' && execution.code === 0) {
        const journal = execution.journal;
        if (!journal || !['ready', 'idle'].includes(journal.outcome)) throw new Error('Invalid ideation journal');
        const report = validateResult({ outcome: journal.outcome, issue: journal.issue, prUrl: journal.prUrl,
          summary: journal.summary, proposals: journal.proposals }, { ideate: true, proposalLimit: boundedJob.proposalLimit });
        if (report.outcome === 'ready') {
          active();
          const published = await client.publishProposals(manifest, report.proposals, { jobId: job.id, limit: boundedJob.proposalLimit, signal: control.signal });
          active();
          const identifiers = published.created.map(issue => issue.identifier).filter(id => typeof id === 'string' && /^[A-Z][A-Z0-9]*-[1-9][0-9]*$/.test(id));
          apiSummary = `Ideas published: ${identifiers.join(', ') || 'none'}; skipped ${published.skipped}`.slice(0, 1900);
        }
      }
    }
    catch (error) {
      execution = { code: job.kind === 'ideation' || job.kind === 'chat' || job.approvalRequired ? 2 : 1 };
      apiSummary = error.message === 'LINEAR_API_KEY is required' ? error.message
        : job.kind === 'chat' ? `No reply: ${error.message}`.slice(0, 1900)
          : job.kind === 'ideation' || job.approvalRequired ? 'Idea workflow blocked: configuration, API, or report validation failed; inspect local evidence' : undefined;
    }
    finally {
      clearTimeout(cap); heartbeatControl.abort(); await heartbeat;
      signal.removeEventListener('abort', shutdown);
    }
    const outcome = interruption ? 'blocked' : execution.code === 0 ? (['ready', 'idle'].includes(execution.journal?.outcome) ? execution.journal.outcome : 'failed') : [2, 130].includes(execution.code) ? 'blocked' : 'failed';
    const summary = interruption ?? apiSummary ?? (execution.code === 0 && outcome === 'failed' ? 'Runner exited without a valid ready/idle journal' : `Runner ${outcome} (exit ${execution.code ?? 'signal'})`);
    const result = { outcome, summary };
    if (typeof execution.evidence === 'string' && execution.evidence.length <= 1024 && !/[\x00-\x1f\x7f]/.test(execution.evidence)) result.evidence = execution.evidence;
    try { await request(`/jobs/${job.id}/${['ready', 'idle'].includes(outcome) ? 'complete' : 'fail'}`, { ...credentials, result }); }
    catch (error) { onError(error); }
  }
  async function slot(kinds) {
    do {
      if (signal.aborted) return;
      try {
        const job = await request('/claim', { workerId: config.workerId, projectIds, kinds });
        if (job) await execute(job);
        else if (!once) await sleep(pollMs, signal);
      } catch (error) { onError(error); if (!once) await sleep(pollMs, signal); }
    } while (!once && !signal.aborted);
  }
  await register();
  const registration = once ? null : setInterval(register, registerMs);
  try {
    // Builds take their configured slots; one extra slot answers chat beside them.
    await Promise.all(once ? [slot(['development', 'ideation', 'chat'])]
      : [...Array.from({ length: config.concurrency ?? 1 }, () => slot(['development', 'ideation'])), slot(['chat'])]);
  } finally { if (registration) clearInterval(registration); }
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
