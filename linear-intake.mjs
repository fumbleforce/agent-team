import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { createClient } from './worker.mjs';
import { approvalStatus, createLinearClient } from './linear-api.mjs';
import { validateIdeation } from './idea-schema.mjs';

export async function pollProject({ manifest, queue, linear, now = Date.now }) {
  const config = validateIdeation(manifest.ideation);
  if (typeof manifest.queueProjectId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(manifest.queueProjectId)) throw new Error('Invalid queueProjectId');
  const time = typeof now === 'function' ? now() : Number(now);
  if (!Number.isFinite(time)) throw new Error('Invalid intake clock');
  const snapshot = await linear.snapshot(manifest);
  const jobs = (await queue('/jobs')).filter(job => job.projectId === manifest.queueProjectId);
  const eligible = snapshot.ideas.filter(issue => approvalStatus(manifest, issue).allowed);
  const canceled = []; const enqueued = [];
  for (const job of jobs) {
    if (job.state === 'queued' && job.approvalRequired === true && !eligible.some(issue => issue.identifier === job.issue)) {
      await queue(`/jobs/${encodeURIComponent(job.id)}/cancel`, {});
      job.state = 'canceled'; canceled.push(job.id);
    }
  }
  // Automatic jobs build on the freshly fetched delivery branch, never the worker checkout's HEAD.
  const base = typeof manifest.delivery?.baseBranch === 'string' ? { base: `origin/${manifest.delivery.baseBranch}`, fetch: true } : {};
  // Project-wide ideation jobs overlap every issue; let them settle before enqueueing development.
  const overlapping = jobs.some(job => !job.issue && ['queued', 'running', 'blocked', 'failed'].includes(job.state));
  if (!overlapping) for (const issue of eligible) {
    if (jobs.some(job => (job.issue === issue.identifier || job.issue === issue.id) && settled(job))) continue;
    await linear.prepareApproved(manifest, issue.identifier);
    const job = await queue('/jobs', { projectId: manifest.queueProjectId, issue: issue.identifier, timeoutMinutes: 30, ...base,
      publish: true, autoMerge: manifest.delivery?.autoMergeAuthorized === true, kind: 'development', approvalRequired: true });
    enqueued.push(job); jobs.push(job);
  }
  const cooldown = config.minimumIntervalHours * 3_600_000;
  const active = jobs.some(job => ['queued', 'running', 'blocked', 'failed'].includes(job.state));
  const recent = jobs.some(job => job.kind === 'ideation' && (!Number.isFinite(Number(job.createdAt)) || time - Number(job.createdAt) < cooldown));
  if (snapshot.remaining > 0 && !active && !recent && !enqueued.length) {
    enqueued.push(await queue('/jobs', { projectId: manifest.queueProjectId, kind: 'ideation', proposalLimit: Math.min(config.batchSize, snapshot.remaining),
      timeoutMinutes: 10, ...base, idempotencyKey: `ideation:${manifest.queueProjectId}:${Math.floor(time / cooldown)}` }));
  }
  return { enqueued, canceled };
}

// Canceled jobs and no-model idle skips leave an approval free to be renewed later;
// active, quarantined and delivered (ready) jobs still own the issue.
function settled(job) {
  if (['queued', 'running', 'blocked', 'failed'].includes(job.state)) return true;
  return job.state === 'completed' && job.result?.outcome !== 'idle';
}

export async function runIntake(config, { once = false, signal = new AbortController().signal,
  queue, linear, now = Date.now, onError = () => console.error('Intake project poll failed; verify configuration, credentials, and service availability') } = {}) {
  if (!config || !Number.isInteger(config.pollSeconds ?? 60) || (config.pollSeconds ?? 60) < 1 || (config.pollSeconds ?? 60) > 3600) throw new Error('Invalid pollSeconds');
  const local = config.projects !== undefined;
  if (local && (typeof config.projects !== 'object' || Array.isArray(config.projects) || !Object.keys(config.projects).length || Object.values(config.projects).some(value => typeof value !== 'string' || !path.isAbsolute(value)))) throw new Error('Projects must map queue IDs to absolute checkout paths');
  linear ??= createLinearClient();
  queue ??= createClient(config.coordinatorUrl ?? 'http://127.0.0.1:4310', process.env.AGENT_TEAM_TOKEN);
  // Without local checkouts, manifests come from the coordinator's registry filled by workers.
  const sources = async () => local ? Object.entries(config.projects).map(([id, checkout]) => [id, () => JSON.parse(readFileSync(path.join(checkout, '.agent-team.json'), 'utf8'))])
    : (await queue('/projects')).filter(project => project.manifest).map(project => [project.id, () => project.manifest]);
  do {
    let entries = [];
    try { entries = await sources(); } catch { onError(new Error('Intake project poll failed')); if (once) throw new Error('Intake project poll failed'); }
    for (const [queueProjectId, read] of entries) {
      if (signal.aborted) return;
      try {
        const manifest = read();
        if (manifest.queueProjectId !== queueProjectId) throw new Error('Intake project routing mismatch');
        await pollProject({ manifest, queue, linear, now });
      } catch {
        // Fixed error text avoids credentials in malformed manifests, network errors, or paths.
        onError(new Error('Intake project poll failed'));
        if (once) throw new Error('Intake project poll failed');
      }
    }
    if (!once && !signal.aborted) await sleep((config.pollSeconds ?? 60) * 1000, undefined, { signal }).catch(error => { if (error.name !== 'AbortError') throw error; });
  } while (!once && !signal.aborted);
}

export async function main(args = process.argv.slice(2)) {
  let configPath; let once = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' && args[i + 1]) configPath = args[++i];
    else if (args[i] === '--once') once = true;
    else throw new Error('Unknown or incomplete intake option');
  }
  if (!configPath) throw new Error('Usage: node linear-intake.mjs --config intake.json [--once]');
  const linear = createLinearClient(); // Fail explicitly before starting if the key is absent.
  let config;
  try { config = JSON.parse(readFileSync(configPath, 'utf8')); } catch { throw new Error('Cannot read intake configuration'); }
  const control = new AbortController(); const stop = () => control.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try { await runIntake(config, { once, signal: control.signal, linear }); }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
