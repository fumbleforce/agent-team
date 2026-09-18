import { DatabaseSync } from 'node:sqlite';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ENGINES, validateBilling } from '../adapters/engine/index.mjs';
import { createLauncher } from '../adapters/launcher/index.mjs';
import { remoteBase } from './git-base.mjs';
import { ROSTER } from './roster.mjs';
import { createMemory, MemoryError, ITEM_TYPES } from './memory.mjs';
import { normalizeManifest, validateOverrides, OVERRIDABLE_SECTIONS } from './manifest.mjs';
import { trackerAdapter, trackerClient, DEFAULT_TRACKER } from '../adapters/tracker/index.mjs';

const KINDS = ['development', 'ideation', 'chat', 'graduate'];
const ISSUE = /^[A-Za-z][A-Za-z0-9_]*-[1-9][0-9]*$/;
const DECISION_KINDS = ['approve-issue', 'memory-decision', 'spend', 'enqueue', 'other'];
const DAY = 86_400_000;

export class QueueError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const reject = (message, status = 400) => { throw new QueueError(status, message); };
export function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) reject('Invalid object or unknown fields');
}
function text(value, name, max = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) reject(`Invalid ${name}`);
  return value;
}
export function requireToken(token) {
  if (typeof token !== 'string' || token.length < 24 || /\s/.test(token)) throw new Error('AGENT_TEAM_TOKEN must contain at least 24 non-whitespace characters');
  if (token.startsWith('job.') && !/^job\.[a-f0-9-]{36}\.[\w-]{43}$/.test(token)) throw new Error('AGENT_TEAM_TOKEN must not start with "job."; that prefix marks tokens derived for one job');
  return token;
}

// A job token is derived from the shared token and one job id. A launched worker receives it in
// place of the shared token, so a machine that runs model-driven commands can claim and report its
// own job and read its project's settings and memory, and nothing else. In particular it cannot
// register a manifest: autonomy, delivery authorization and worker size reach the coordinator only
// from holders of the shared token.
export function jobToken(token, jobId) {
  return `job.${jobId}.${createHmac('sha256', requireToken(token)).update(`agent-team-job:${jobId}`).digest('base64url')}`;
}
const JOB_ROUTES = ['heartbeat', 'complete', 'fail', 'evidence', 'events', 'injection', 'artifacts', 'proposals'];
function jobScopeAllows(scope, method, pathname) {
  if (method === 'GET') return pathname === '/health' || [`/projects/${scope.projectId}/settings`, `/projects/${scope.projectId}/memory/assemble`, `/projects/${scope.projectId}/memory/search`].includes(pathname);
  if (method !== 'POST') return false;
  return pathname === '/claim' || pathname === `/projects/${scope.projectId}/costs` || JOB_ROUTES.some(route => pathname === `/jobs/${scope.jobId}/${route}`);
}

export function createQueue(dbPath, { projects = {}, now = Date.now, leaseMs = 90_000, launcher = null, jobTokenFor = null, memory = null, claimTimeoutMs = 15 * 60_000, onLaunchError = error => console.error(error.message) } = {}) {
  if (!Number.isInteger(leaseMs) || leaseMs < 1) throw new Error('Invalid leaseMs');
  if (!Number.isInteger(claimTimeoutMs) || claimTimeoutMs < 1) throw new Error('Invalid claimTimeoutMs');
  const registered = id => {
    text(id, 'projectId', 80);
    if (!Object.hasOwn(projects, id)) reject('Unknown projectId');
  };
  if (dbPath !== ':memory:') mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  if (dbPath !== ':memory:') chmodSync(dbPath, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, projectId TEXT NOT NULL, issue TEXT, request TEXT NOT NULL,
      idempotencyKey TEXT UNIQUE, state TEXT NOT NULL, workerId TEXT, leaseToken TEXT,
      leaseUntil INTEGER, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, result TEXT);
    CREATE TABLE IF NOT EXISTS evidence (jobId TEXT PRIMARY KEY, projectId TEXT NOT NULL, updatedAt INTEGER NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, manifest TEXT NOT NULL, workerId TEXT, updatedAt INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS events (jobId TEXT NOT NULL, seq INTEGER NOT NULL, createdAt INTEGER NOT NULL, line TEXT NOT NULL, PRIMARY KEY(jobId, seq));`);
  // Chat jobs are read-only conversations and run beside builds, so the kind is a column.
  if (!db.prepare('PRAGMA table_info(jobs)').all().some(column => column.name === 'kind')) {
    db.exec(`ALTER TABLE jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'development'`);
    for (const row of db.prepare('SELECT id, request FROM jobs').all()) db.prepare('UPDATE jobs SET kind=? WHERE id=?').run(JSON.parse(row.request).kind ?? 'development', row.id);
  }
  db.exec(`DROP INDEX IF EXISTS one_running_project;
    CREATE UNIQUE INDEX IF NOT EXISTS one_running_build ON jobs(projectId) WHERE state='running' AND kind<>'chat';
    CREATE TABLE IF NOT EXISTS proposals (id TEXT PRIMARY KEY, jobId TEXT NOT NULL, projectId TEXT NOT NULL, createdAt INTEGER NOT NULL, state TEXT NOT NULL, item TEXT NOT NULL, resolvedAt INTEGER, resolution TEXT);
    CREATE TABLE IF NOT EXISTS injections (jobId TEXT PRIMARY KEY, projectId TEXT NOT NULL, sha TEXT NOT NULL, itemIds TEXT NOT NULL, tokens INTEGER NOT NULL, createdAt INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS launches (jobId TEXT PRIMARY KEY, projectId TEXT NOT NULL, kind TEXT NOT NULL, handle TEXT, startedAt INTEGER NOT NULL, state TEXT NOT NULL, error TEXT);
    CREATE TABLE IF NOT EXISTS artifacts (jobId TEXT PRIMARY KEY, projectId TEXT NOT NULL, payload TEXT NOT NULL, createdAt INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS settings (projectId TEXT PRIMARY KEY, overrides TEXT NOT NULL, author TEXT NOT NULL, updatedAt INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS settings_history (id INTEGER PRIMARY KEY AUTOINCREMENT, projectId TEXT NOT NULL, overrides TEXT NOT NULL, author TEXT NOT NULL, note TEXT, createdAt INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, title TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, threadId TEXT NOT NULL, projectId TEXT NOT NULL, author TEXT NOT NULL, body TEXT NOT NULL, createdAt INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'final', meta TEXT);
    CREATE TABLE IF NOT EXISTS decisions (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, options TEXT NOT NULL, createdAt INTEGER NOT NULL, state TEXT NOT NULL, choice TEXT, note TEXT, resolvedAt INTEGER, threadId TEXT, payload TEXT);
    CREATE TABLE IF NOT EXISTS costs (id INTEGER PRIMARY KEY AUTOINCREMENT, projectId TEXT NOT NULL, jobId TEXT, kind TEXT NOT NULL, usd REAL NOT NULL, tokens INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL);`);
  const expire = () => db.prepare(`UPDATE jobs SET state='blocked', leaseToken=NULL, leaseUntil=NULL,
    updatedAt=?, result=? WHERE state='running' AND leaseUntil<=?`).run(now(), JSON.stringify({ outcome: 'blocked', summary: 'Lease expired; inspect execution before manual requeue' }), now());
  const tx = fn => {
    db.exec('BEGIN IMMEDIATE');
    try { expire(); const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const view = row => {
    if (!row) return null;
    const { leaseToken, request, result, ...rest } = row;
    return { ...rest, kind: 'development', approvalRequired: false, autoMerge: false, ...JSON.parse(request), result: result ? JSON.parse(result) : null };
  };
  const get = id => { const row = db.prepare('SELECT * FROM jobs WHERE id=?').get(id); if (!row) reject('Job not found', 404); return row; };
  const normalize = input => {
    object(input, ['projectId', 'issue', 'base', 'fetch', 'engine', 'billing', 'model', 'timeoutMinutes', 'publish', 'autoMerge', 'idempotencyKey', 'kind', 'proposalLimit', 'approvalRequired', 'role', 'message']);
    const kind = input.kind ?? 'development';
    if (!KINDS.includes(kind)) reject('Invalid kind');
    if (kind !== 'chat' && (input.role !== undefined || input.message !== undefined)) reject('role and message require chat');
    if (kind === 'chat') {
      if (['publish', 'autoMerge', 'approvalRequired', 'proposalLimit', 'base', 'fetch', 'model'].some(key => input[key] !== undefined)) reject('Chat accepts only role, issue and message');
      if (!Object.hasOwn(ROSTER, input.role)) reject('Invalid role');
      if (!ISSUE.test(input.issue ?? '')) reject('Chat requires a tracker issue');
      text(input.message, 'message', 4000);
      registered(input.projectId);
      const timeoutMinutes = input.timeoutMinutes ?? 5;
      if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 15) reject('Invalid timeoutMinutes');
      if (input.idempotencyKey !== undefined) text(input.idempotencyKey, 'idempotencyKey');
      return { projectId: input.projectId, kind, issue: input.issue, role: input.role, message: input.message, timeoutMinutes, ...(input.engine === undefined ? {} : { engine: input.engine }) };
    }
    if (kind === 'ideation') {
      if (['issue', 'publish', 'autoMerge', 'approvalRequired'].some(key => input[key] !== undefined)) reject('Ideation forbids issue, publish, autoMerge and approvalRequired');
      if (!Number.isInteger(input.proposalLimit) || input.proposalLimit < 1 || input.proposalLimit > 10) reject('Ideation requires proposalLimit from 1 to 10');
    } else if (kind === 'graduate') {
      // Graduation moves proven memory items into the repository's own rules files through a change request.
      if (['issue', 'autoMerge', 'approvalRequired', 'proposalLimit'].some(key => input[key] !== undefined)) reject('Graduation forbids issue, autoMerge, approvalRequired and proposalLimit');
      if (input.publish !== true) reject('Graduation requires publish: true');
    } else {
      if (input.proposalLimit !== undefined) reject('proposalLimit requires ideation');
      if (input.approvalRequired !== undefined && typeof input.approvalRequired !== 'boolean') reject('Invalid approvalRequired');
      if (input.approvalRequired && !input.issue) reject('approvalRequired requires pinned issue');
    }
    registered(input.projectId);
    if (input.issue !== undefined && !/^[A-Z][A-Z0-9]*-[1-9][0-9]*$/.test(text(input.issue, 'issue', 80))) reject('Invalid issue');
    const base = input.base === undefined ? 'HEAD' : text(input.base, 'base');
    if (base.startsWith('-')) reject('Invalid base');
    if (input.fetch !== undefined && typeof input.fetch !== 'boolean') reject('Invalid fetch');
    if (input.fetch === true) { try { remoteBase(base); } catch { reject('fetch requires base REMOTE/BRANCH'); } }
    if (input.engine !== undefined && !ENGINES.includes(input.engine)) reject('Invalid engine');
    if (input.billing !== undefined) { if (input.engine === undefined) reject('billing requires engine'); try { validateBilling(input.engine, text(input.billing, 'billing', 40)); } catch { reject('Invalid billing'); } }
    if (input.model !== undefined && text(input.model, 'model').startsWith('-')) reject('Invalid model');
    const timeoutMinutes = input.timeoutMinutes === undefined ? 45 : input.timeoutMinutes;
    if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 120) reject('Invalid timeoutMinutes');
    if (input.publish !== undefined && typeof input.publish !== 'boolean') reject('Invalid publish');
    if (input.autoMerge !== undefined && typeof input.autoMerge !== 'boolean') reject('Invalid autoMerge');
    if (input.autoMerge === true && input.publish !== true) reject('autoMerge requires publish: true');
    if (input.idempotencyKey !== undefined) text(input.idempotencyKey, 'idempotencyKey');
    return { projectId: input.projectId, kind, ...(kind === 'ideation' ? { proposalLimit: input.proposalLimit } : kind === 'graduate' ? {} : { approvalRequired: input.approvalRequired ?? false }), ...(input.issue === undefined ? {} : { issue: input.issue }), base,
      ...(input.fetch === true ? { fetch: true } : {}), ...(input.engine === undefined ? {} : { engine: input.engine }), ...(input.billing === undefined ? {} : { billing: input.billing }),
      ...(input.model === undefined ? {} : { model: input.model }), timeoutMinutes, ...(kind === 'ideation' ? {} : { publish: input.publish ?? false, autoMerge: input.autoMerge ?? false }) };
  };
  const updateLease = (id, input, state) => {
    object(input, state ? ['workerId', 'leaseToken', 'result'] : ['workerId', 'leaseToken']);
    text(input.workerId, 'workerId'); text(input.leaseToken, 'leaseToken');
    let result;
    if (state) {
      object(input.result, ['outcome', 'summary', 'evidence']);
      const allowed = state === 'completed' ? ['ready', 'idle'] : ['blocked', 'failed'];
      if (!allowed.includes(input.result.outcome)) reject('Invalid result outcome');
      text(input.result.summary, 'summary', 2000);
      if (input.result.evidence !== undefined) text(input.result.evidence, 'evidence', 1024);
      result = JSON.stringify(input.result);
    }
    // Commit expiry even when a stale caller will subsequently be rejected.
    tx(() => {});
    return tx(() => {
      const row = get(id);
      if (row.state !== 'running' || row.workerId !== input.workerId || row.leaseToken !== input.leaseToken) reject('Lease lost or invalid', 409);
      if (state) db.prepare('UPDATE jobs SET state=?, result=?, leaseToken=NULL, leaseUntil=NULL, updatedAt=? WHERE id=?').run(state === 'completed' ? state : input.result.outcome, result, now(), id);
      else db.prepare('UPDATE jobs SET leaseUntil=?, updatedAt=? WHERE id=?').run(now() + leaseMs, now(), id);
      return view(get(id));
    });
  };
  // Launcher per project: the manifest's worker section selects the kind; coordinator-wide
  // launcher options (credentials, network, AMI defaults) come from `launcher`.
  const overridesOf = projectId => { const row = db.prepare('SELECT overrides FROM settings WHERE projectId=?').get(projectId); return row ? JSON.parse(row.overrides) : {}; };
  // The effective manifest: the repository's file with the owner's dashboard overrides applied.
  // Falls back to the stored document when normalization fails so an invalid override never hides a project.
  const effective = (projectId, stored) => { if (!stored) return null; try { return normalizeManifest(stored, overridesOf(projectId)); } catch { return stored; } };
  const manifestOf = projectId => { const row = db.prepare('SELECT manifest FROM projects WHERE id=?').get(projectId); return row ? effective(projectId, JSON.parse(row.manifest)) : null; };
  const launcherFor = projectId => {
    const kind = manifestOf(projectId)?.worker?.launcher ?? launcher?.kind ?? 'local';
    if (kind === 'local') return null;
    return createLauncher(kind, { ...(launcher?.options ?? {}), ...(launcher?.byKind?.[kind] ?? {}) });
  };
  const launch = job => {
    const worker = { ...(launcher?.options ?? {}), ...(manifestOf(job.projectId)?.worker ?? {}) };
    const instance = launcherFor(job.projectId);
    db.prepare(`INSERT INTO launches(jobId,projectId,kind,handle,startedAt,state) VALUES(?,?,?,?,?,'starting') ON CONFLICT(jobId) DO UPDATE SET kind=excluded.kind, startedAt=excluded.startedAt, state='starting', handle=NULL, error=NULL`).run(job.id, job.projectId, instance.kind, null, now());
    // Fire and forget: the queue never blocks on a cloud API. Failures are recorded and the watchdog fails the job.
    Promise.resolve().then(() => instance.start({ ...job, worker, ...(jobTokenFor ? { token: jobTokenFor(job.id) } : {}) }))
      .then(handle => db.prepare(`UPDATE launches SET handle=?, state=CASE WHEN state='claimed' THEN 'claimed' ELSE 'started' END WHERE jobId=?`).run(JSON.stringify(handle), job.id))
      .catch(error => { db.prepare(`UPDATE launches SET state='failed', error=? WHERE jobId=?`).run(String(error.message).slice(0, 400), job.id); onLaunchError(error); });
  };
  // Jobs whose launched worker never claimed them are failed and their machines stopped.
  const watchdog = async () => {
    const stale = db.prepare(`SELECT l.*, j.state AS jobState FROM launches l JOIN jobs j ON j.id=l.jobId WHERE l.state IN ('starting','started','failed') AND j.state='queued' AND l.startedAt<=?`).all(now() - claimTimeoutMs);
    const results = [];
    for (const row of stale) {
      const reason = row.state === 'failed' ? `Launcher failed: ${row.error}` : `Launched worker did not claim the job within ${Math.round(claimTimeoutMs / 60_000)} minutes`;
      tx(() => db.prepare(`UPDATE jobs SET state='failed', updatedAt=?, result=? WHERE id=? AND state='queued'`).run(now(), JSON.stringify({ outcome: 'failed', summary: reason }), row.jobId));
      let stopped = false;
      try { if (row.handle) { const instance = createLauncher(row.kind, { ...(launcher?.options ?? {}), ...(launcher?.byKind?.[row.kind] ?? {}) }); stopped = (await instance.stop(JSON.parse(row.handle))).stopped === true; } } catch (error) { onLaunchError(error); }
      db.prepare(`UPDATE launches SET state='abandoned' WHERE jobId=?`).run(row.jobId);
      results.push({ jobId: row.jobId, reason, stopped });
    }
    return results;
  };
  const memoryCall = fn => { try { return fn(); } catch (error) { if (error instanceof MemoryError) reject(error.message, error.status); throw error; } };
  const requireMemory = () => { if (!memory) reject('Memory is not configured on this coordinator', 501); return memory; };
  const lease = (id, input) => {
    const row = get(id);
    if (row.state !== 'running' || row.workerId !== input.workerId || row.leaseToken !== input.leaseToken) reject('Lease lost or invalid', 409);
    return row;
  };

  return {
    close: () => { db.close(); memory?.close(); },
    watchdog,
    leaseScope(jobId, workerId, leaseToken) {
      if (!/^[a-f0-9-]{36}$/.test(String(jobId))) return null;
      const row = db.prepare('SELECT projectId FROM jobs WHERE id=? AND state=? AND workerId=? AND leaseToken=?').get(jobId, 'running', String(workerId), String(leaseToken));
      return row ? { jobId, projectId: row.projectId } : null;
    },
    // A job token is honoured only while its job can still be claimed or is running.
    jobScope(jobId) {
      if (!/^[a-f0-9-]{36}$/.test(String(jobId))) return null;
      const row = db.prepare(`SELECT projectId FROM jobs WHERE id=? AND state IN ('queued','running')`).get(jobId);
      return row ? { jobId, projectId: row.projectId } : null;
    },
    launches: () => db.prepare('SELECT jobId, projectId, kind, handle, startedAt, state, error FROM launches ORDER BY startedAt DESC LIMIT 200').all().map(row => ({ ...row, handle: row.handle ? JSON.parse(row.handle) : null })),
    enqueue(input) {
      const request = normalize(input); const encoded = JSON.stringify(request);
      return tx(() => {
        if (input.idempotencyKey) {
          const prior = db.prepare('SELECT * FROM jobs WHERE idempotencyKey=?').get(input.idempotencyKey);
          if (prior) { if (JSON.stringify(normalize(JSON.parse(prior.request))) !== encoded) reject('Idempotency key reused with different request', 409); return view(prior); }
        }
        if (request.kind !== 'chat') {
          const duplicate = db.prepare(`SELECT id FROM jobs WHERE projectId=? AND kind<>'chat' AND state IN ('queued','running') AND (issue IS NULL OR ? IS NULL OR issue=?)`).get(request.projectId, request.issue ?? null, request.issue ?? null);
          if (duplicate) reject('Active overlapping job already exists', 409);
        }
        const id = randomUUID();
        db.prepare(`INSERT INTO jobs(id,projectId,issue,request,idempotencyKey,state,kind,createdAt,updatedAt) VALUES(?,?,?,?,?,'queued',?,?,?)`).run(id, request.projectId, request.issue ?? null, encoded, input.idempotencyKey ?? null, request.kind, now(), now());
        const job = view(get(id));
        if (launcherFor(request.projectId) && request.kind !== 'chat') launch(job);
        return job;
      });
    },
    list: () => tx(() => db.prepare('SELECT * FROM jobs ORDER BY createdAt,rowid').all().map(view)),
    // `job` restricts the claim to one id: an ephemeral worker started for that job claims
    // exactly it and nothing else, even when other work is queued for the project.
    claim(input) {
      object(input, ['workerId', 'projectIds', 'kinds', 'job']); text(input.workerId, 'workerId');
      if (!Array.isArray(input.projectIds) || !input.projectIds.length || input.projectIds.length > 100) reject('Invalid projectIds');
      input.projectIds.forEach(registered);
      const kinds = input.kinds ?? ['development', 'ideation', 'graduate'];
      if (!Array.isArray(kinds) || !kinds.length || kinds.some(kind => !KINDS.includes(kind))) reject('Invalid kinds');
      if (input.job !== undefined && !/^[a-f0-9-]{36}$/.test(String(input.job))) reject('Invalid job');
      return tx(() => {
        // Expired/crashed workers may still be executing on another host. Quarantine
        // the entire project until an operator inspects execution and requeues.
        // Chat jobs are read-only and stay claimable beside builds and held projects.
        const params = [...input.projectIds, ...kinds, ...(input.job ? [input.job] : [])];
        const row = db.prepare(`SELECT * FROM jobs j WHERE state='queued' AND projectId IN (${input.projectIds.map(() => '?').join(',')}) AND kind IN (${kinds.map(() => '?').join(',')})
          ${input.job ? 'AND j.id=?' : ''}
          AND (j.kind='chat' OR NOT EXISTS (SELECT 1 FROM jobs r WHERE r.projectId=j.projectId AND r.kind<>'chat' AND r.state IN ('running','blocked','failed'))) ORDER BY createdAt,rowid LIMIT 1`).get(...params);
        if (!row) return null;
        db.prepare(`UPDATE launches SET state='claimed' WHERE jobId=? AND state='started'`).run(row.id);
        const leaseToken = randomUUID();
        db.prepare(`UPDATE jobs SET state='running',workerId=?,leaseToken=?,leaseUntil=?,updatedAt=? WHERE id=?`).run(input.workerId, leaseToken, now() + leaseMs, now(), row.id);
        return { ...view(get(row.id)), leaseToken, leaseMs };
      });
    },
    heartbeat: (id, input) => updateLease(id, input),
    complete: (id, input) => updateLease(id, input, 'completed'),
    fail: (id, input) => updateLease(id, input, 'failed'),
    cancel(id, input = {}) {
      object(input, []);
      return tx(() => {
        if (get(id).state !== 'queued') reject('Only queued jobs can be canceled', 409);
        db.prepare("UPDATE jobs SET state='canceled',updatedAt=? WHERE id=?").run(now(), id);
        return view(get(id));
      });
    },
    evidence(id, input) {
      object(input, ['workerId', 'leaseToken', 'evidence']);
      text(input.workerId, 'workerId'); text(input.leaseToken, 'leaseToken');
      if (!input.evidence || typeof input.evidence !== 'object' || Array.isArray(input.evidence)) reject('Invalid evidence');
      const payload = JSON.stringify(input.evidence);
      if (payload.length > 600_000) reject('Evidence exceeds 600KB', 413);
      return tx(() => {
        const row = get(id);
        if (row.state !== 'running' || row.workerId !== input.workerId || row.leaseToken !== input.leaseToken) reject('Lease lost or invalid', 409);
        db.prepare('INSERT INTO evidence(jobId,projectId,updatedAt,payload) VALUES(?,?,?,?) ON CONFLICT(jobId) DO UPDATE SET updatedAt=excluded.updatedAt, payload=excluded.payload').run(id, row.projectId, now(), payload);
        return { ok: true };
      });
    },
    // Raw engine stream lines, appended by the owning worker while it holds the lease.
    appendEvents(id, input) {
      object(input, ['workerId', 'leaseToken', 'events']);
      text(input.workerId, 'workerId'); text(input.leaseToken, 'leaseToken');
      if (!Array.isArray(input.events) || input.events.length > 500 || input.events.some(line => typeof line !== 'string' || line.length > 8192)) reject('Invalid events');
      return tx(() => {
        const row = get(id);
        if (row.state !== 'running' || row.workerId !== input.workerId || row.leaseToken !== input.leaseToken) reject('Lease lost or invalid', 409);
        let seq = db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE jobId=?').get(id).seq;
        const insert = db.prepare('INSERT INTO events(jobId,seq,createdAt,line) VALUES(?,?,?,?)');
        for (const line of input.events) insert.run(id, ++seq, now(), line);
        // Streams are for watching, not archiving: drop lines of jobs finished more than 14 days ago.
        db.prepare(`DELETE FROM events WHERE jobId IN (SELECT id FROM jobs WHERE state NOT IN ('queued','running') AND updatedAt < ?)`).run(now() - 14 * 86_400_000);
        return { seq };
      });
    },
    eventsAfter(id, { after = 0, limit = 500 } = {}) {
      const row = get(id);
      if (!Number.isInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 2000) reject('Invalid event position');
      const events = db.prepare('SELECT seq, createdAt, line FROM events WHERE jobId=? AND seq>? ORDER BY seq LIMIT ?').all(id, after, limit);
      return { jobState: row.state, events };
    },
    evidenceFor(id) { get(id); const row = db.prepare('SELECT * FROM evidence WHERE jobId=?').get(id); return row ? { jobId: id, projectId: row.projectId, updatedAt: row.updatedAt, ...JSON.parse(row.payload) } : null; },
    // Completed and failed jobs stay claimable-free; the job view carries archived artifacts when present.
    evidenceList({ limit = 40 } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) reject('Invalid limit');
      return db.prepare('SELECT e.jobId, e.projectId, e.updatedAt, e.payload, j.state AS jobState FROM evidence e JOIN jobs j ON j.id=e.jobId ORDER BY e.updatedAt DESC LIMIT ?').all(limit)
        .map(row => { const payload = JSON.parse(row.payload); return { jobId: row.jobId, projectId: row.projectId, updatedAt: row.updatedAt, jobState: row.jobState, run: payload.run, steps: (payload.steps ?? []).slice(-40), members: payload.members ?? {}, active: payload.active ?? null, usage: payload.usage ?? null, tokens: payload.tokens ?? 0 }; });
    },
    registerProject(id, input) {
      registered(id); object(input, ['workerId', 'manifest']); text(input.workerId, 'workerId');
      if (!input.manifest || typeof input.manifest !== 'object' || Array.isArray(input.manifest)) reject('Invalid manifest');
      const manifest = JSON.stringify(input.manifest);
      if (manifest.length > 65536) reject('Manifest exceeds 64KB', 413);
      return tx(() => { db.prepare('INSERT INTO projects(id,manifest,workerId,updatedAt) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET manifest=excluded.manifest, workerId=excluded.workerId, updatedAt=excluded.updatedAt').run(id, manifest, input.workerId, now()); return { ok: true }; });
    },
    projectsList() {
      const rows = Object.fromEntries(db.prepare('SELECT * FROM projects').all().map(row => [row.id, row]));
      return Object.entries(projects).map(([id, project]) => {
        const stored = rows[id] ? JSON.parse(rows[id].manifest) : null;
        const overrides = overridesOf(id);
        return { id, repository: project.repository ?? null, manifest: effective(id, stored), repoManifest: stored, overrides, workerId: rows[id]?.workerId ?? null, seenAt: rows[id]?.updatedAt ?? null };
      });
    },
    // Owner overrides for the allowlisted manifest sections; validated against the stored repository
    // manifest when one is registered so a save that would break normalization is refused.
    settings(projectId) {
      registered(projectId);
      const row = db.prepare('SELECT * FROM settings WHERE projectId=?').get(projectId);
      const stored = db.prepare('SELECT manifest FROM projects WHERE id=?').get(projectId);
      const repoManifest = stored ? JSON.parse(stored.manifest) : null;
      let error = null; let manifest = null; let repo = repoManifest;
      if (repoManifest) {
        try { repo = normalizeManifest(repoManifest); } catch (failure) { error = failure.message; }
        try { manifest = normalizeManifest(repoManifest, row ? JSON.parse(row.overrides) : {}); } catch (failure) { error = failure.message; }
      }
      return { projectId, overrides: row ? JSON.parse(row.overrides) : {}, author: row?.author ?? null, updatedAt: row?.updatedAt ?? null, repoManifest: repo, manifest, error, sections: OVERRIDABLE_SECTIONS };
    },
    saveSettings(projectId, input) {
      registered(projectId); object(input, ['overrides', 'author', 'note']);
      let overrides;
      try { overrides = validateOverrides(input.overrides); } catch (failure) { reject(failure.message); }
      const author = typeof input.author === 'string' ? input.author : input.author?.name ?? 'owner';
      text(author, 'author', 120);
      if (input.note !== undefined && input.note !== null) text(input.note, 'note', 400);
      const stored = db.prepare('SELECT manifest FROM projects WHERE id=?').get(projectId);
      if (stored) { try { normalizeManifest(JSON.parse(stored.manifest), overrides); } catch (failure) { reject(`Settings rejected: ${failure.message}`); } }
      const serialized = JSON.stringify(overrides);
      if (serialized.length > 32768) reject('Settings exceed 32KB', 413);
      return tx(() => {
        db.prepare('INSERT INTO settings(projectId,overrides,author,updatedAt) VALUES(?,?,?,?) ON CONFLICT(projectId) DO UPDATE SET overrides=excluded.overrides, author=excluded.author, updatedAt=excluded.updatedAt').run(projectId, serialized, author, now());
        db.prepare('INSERT INTO settings_history(projectId,overrides,author,note,createdAt) VALUES(?,?,?,?,?)').run(projectId, serialized, author, input.note ?? null, now());
        return this.settings(projectId);
      });
    },
    settingsHistory(projectId, { limit = 30 } = {}) {
      registered(projectId);
      return db.prepare('SELECT id, overrides, author, note, createdAt FROM settings_history WHERE projectId=? ORDER BY id DESC LIMIT ?').all(projectId, Math.min(200, Math.max(1, limit)))
        .map(row => ({ id: row.id, overrides: JSON.parse(row.overrides), author: row.author, note: row.note, createdAt: row.createdAt }));
    },
    // Live tracker choices for the settings form (teams, projects, labels, states), through the
    // tracker adapter with the coordinator's own credential; absent credentials yield 501.
    async trackerLookup(projectId, params = {}) {
      registered(projectId);
      const manifest = manifestOf(projectId);
      const kind = manifest?.tracker?.kind ?? DEFAULT_TRACKER;
      const adapter = trackerAdapter(kind);
      if (!process.env[adapter.API_KEY_VARIABLE]) reject(`${adapter.API_KEY_VARIABLE} is not available to the coordinator`, 501);
      const client = trackerClient(kind);
      if (typeof client.lookup !== 'function') reject('Tracker adapter has no lookup', 501);
      return client.lookup({ teamId: params.teamId ?? manifest?.tracker?.teamId ?? null });
    },
    // Memory injected into a run, recorded by the worker before the runner starts.
    injection(id, input) {
      object(input, ['workerId', 'leaseToken', 'sha', 'itemIds', 'tokens']);
      text(input.workerId, 'workerId'); text(input.leaseToken, 'leaseToken');
      if (!/^[0-9a-f]{7,40}$/.test(String(input.sha))) reject('Invalid sha');
      if (!Array.isArray(input.itemIds) || input.itemIds.length > 500 || input.itemIds.some(value => typeof value !== 'string')) reject('Invalid itemIds');
      if (!Number.isInteger(input.tokens) || input.tokens < 0) reject('Invalid tokens');
      return tx(() => { const row = lease(id, input); db.prepare('INSERT INTO injections(jobId,projectId,sha,itemIds,tokens,createdAt) VALUES(?,?,?,?,?,?) ON CONFLICT(jobId) DO UPDATE SET sha=excluded.sha, itemIds=excluded.itemIds, tokens=excluded.tokens, createdAt=excluded.createdAt').run(id, row.projectId, input.sha, JSON.stringify(input.itemIds), input.tokens, now()); return { ok: true }; });
    },
    injectionFor(id) { get(id); const row = db.prepare('SELECT * FROM injections WHERE jobId=?').get(id); return row ? { jobId: id, projectId: row.projectId, sha: row.sha, itemIds: JSON.parse(row.itemIds), tokens: row.tokens, createdAt: row.createdAt } : null; },
    // Learnings a run proposes for memory; the PM (or owner) accepts, rewrites or discards them.
    propose(id, input) {
      object(input, ['workerId', 'leaseToken', 'items']);
      text(input.workerId, 'workerId'); text(input.leaseToken, 'leaseToken');
      if (!Array.isArray(input.items) || !input.items.length || input.items.length > 24) reject('Invalid items');
      return tx(() => {
        const row = lease(id, input);
        const insert = db.prepare(`INSERT INTO proposals(id,jobId,projectId,createdAt,state,item) VALUES(?,?,?,?,'pending',?)`);
        const ids = [];
        for (const item of input.items) {
          object(item, ['type', 'title', 'body', 'scope']);
          if (!ITEM_TYPES.includes(item.type ?? 'observation')) reject('Invalid item type');
          text(item.title, 'title', 160); text(item.body, 'body', 4000);
          if (item.scope !== undefined && (!Array.isArray(item.scope) || item.scope.length > 12 || item.scope.some(value => typeof value !== 'string' || value.length > 80))) reject('Invalid scope');
          const proposalId = randomUUID();
          insert.run(proposalId, id, row.projectId, now(), JSON.stringify({ type: item.type ?? 'observation', title: item.title, body: item.body, scope: item.scope ?? [], source: `run:${id}` }));
          ids.push(proposalId);
        }
        return { ids };
      });
    },
    proposals({ projectId, jobId, state = 'pending', limit = 100 } = {}) {
      const clauses = []; const params = [];
      if (projectId) { registered(projectId); clauses.push('projectId=?'); params.push(projectId); }
      if (jobId) { clauses.push('jobId=?'); params.push(jobId); }
      if (state) { clauses.push('state=?'); params.push(state); }
      return db.prepare(`SELECT * FROM proposals ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY createdAt LIMIT ?`).all(...params, Math.min(500, limit)).map(row => ({ id: row.id, jobId: row.jobId, projectId: row.projectId, createdAt: row.createdAt, state: row.state, item: JSON.parse(row.item), resolvedAt: row.resolvedAt, resolution: row.resolution }));
    },
    // Accepting writes the (possibly rewritten) item to memory; discarding only records the decision.
    // Several proposals from one run resolve in one memory commit.
    resolveProposals(input) {
      object(input, ['resolutions', 'author', 'message']);
      if (!Array.isArray(input.resolutions) || !input.resolutions.length || input.resolutions.length > 50) reject('Invalid resolutions');
      const rows = input.resolutions.map(resolution => {
        object(resolution, ['id', 'action', 'item']);
        if (!['accept', 'discard'].includes(resolution.action)) reject('Invalid action');
        const row = db.prepare('SELECT * FROM proposals WHERE id=?').get(resolution.id);
        if (!row) reject(`Proposal ${resolution.id} not found`, 404);
        if (row.state !== 'pending') reject('Proposal already resolved', 409);
        return { row, resolution };
      });
      const projectIds = new Set(rows.map(({ row }) => row.projectId));
      if (projectIds.size !== 1) reject('Resolutions must belong to one project');
      const accepted = rows.filter(({ resolution }) => resolution.action === 'accept').map(({ row, resolution }) => ({ ...JSON.parse(row.item), ...(resolution.item ?? {}) }));
      const written = accepted.length ? memoryCall(() => requireMemory().write([...projectIds][0], accepted, { author: input.author ?? { name: 'resident PM' }, message: input.message ?? `Curate ${accepted.length} learning${accepted.length === 1 ? '' : 's'} from run ${rows[0].row.jobId.slice(0, 8)}` })) : null;
      let position = 0;
      for (const { row, resolution } of rows) {
        const accept = resolution.action === 'accept';
        const resolved = accept && written ? JSON.stringify({ sha: written.sha, id: written.ids[position++] }) : null;
        db.prepare('UPDATE proposals SET state=?, resolvedAt=?, resolution=? WHERE id=?').run(accept ? 'accepted' : 'discarded', now(), resolved, row.id);
      }
      return { resolved: rows.length, written };
    },
    resolveProposal(id, input) {
      object(input, ['action', 'item', 'author']);
      if (!['accept', 'discard'].includes(input.action)) reject('Invalid action');
      const row = db.prepare('SELECT * FROM proposals WHERE id=?').get(id);
      if (!row) reject('Proposal not found', 404);
      if (row.state !== 'pending') reject('Proposal already resolved', 409);
      let written = null;
      if (input.action === 'accept') {
        const item = { ...JSON.parse(row.item), ...(input.item ?? {}) };
        written = memoryCall(() => requireMemory().write(row.projectId, item, { author: input.author ?? { name: 'resident PM' }, message: `Accept learning from run ${row.jobId.slice(0, 8)}: ${item.title}` }));
      }
      db.prepare('UPDATE proposals SET state=?, resolvedAt=?, resolution=? WHERE id=?').run(input.action === 'accept' ? 'accepted' : 'discarded', now(), written ? JSON.stringify(written) : null, id);
      return { id, state: input.action === 'accept' ? 'accepted' : 'discarded', written };
    },
    memory: {
      projects: () => memoryCall(() => requireMemory().projects()),
      head: () => memoryCall(() => requireMemory().head()),
      read: (projectId, sha) => { registered(projectId); return memoryCall(() => requireMemory().read(projectId, sha)); },
      readFile: (projectId, file, sha) => { registered(projectId); return memoryCall(() => requireMemory().readFile(projectId, file, sha)); },
      items: projectId => { registered(projectId); return memoryCall(() => requireMemory().items(projectId)); },
      search: (projectId, query, options) => { registered(projectId); return memoryCall(() => requireMemory().search(projectId, query, options)); },
      assemble: (projectId, scopes, cap) => { registered(projectId); return memoryCall(() => requireMemory().assemble(projectId, scopes, cap)); },
      write: (projectId, items, options) => { registered(projectId); return memoryCall(() => requireMemory().write(projectId, items, options)); },
      writeFile: (projectId, file, content, options) => { registered(projectId); return memoryCall(() => requireMemory().writeFile(projectId, file, content, options)); },
      writeRun: (projectId, ticket, content, options) => { registered(projectId); return memoryCall(() => requireMemory().writeRun(projectId, ticket, content, options)); },
      setStatus: (projectId, ids, status, options) => { registered(projectId); return memoryCall(() => requireMemory().setStatus(projectId, ids, status, options)); },
      bump: (projectId, ids, options) => { registered(projectId); return memoryCall(() => requireMemory().bump(projectId, ids, options)); },
      log: (projectId, options) => { registered(projectId); return memoryCall(() => requireMemory().log(projectId, options)); },
      diff: (projectId, sha, against) => { registered(projectId); return memoryCall(() => requireMemory().diff(projectId, sha, against)); },
      revert: (projectId, sha, options) => { registered(projectId); return memoryCall(() => requireMemory().revert(projectId, sha, options)); },
      seed: (projectId, files, options) => { registered(projectId); return memoryCall(() => requireMemory().seed(projectId, files, options)); },
      ensureProject: projectId => { registered(projectId); return memoryCall(() => requireMemory().ensureProject(projectId)); },
    },
    // Owner and PM conversation per project, and the decisions the PM must not take alone.
    threads(projectId) { registered(projectId); return db.prepare('SELECT * FROM threads WHERE projectId=? ORDER BY updatedAt DESC LIMIT 50').all(projectId); },
    thread(projectId, { threadId } = {}) {
      registered(projectId);
      let row = threadId ? db.prepare('SELECT * FROM threads WHERE id=? AND projectId=?').get(threadId, projectId) : db.prepare('SELECT * FROM threads WHERE projectId=? ORDER BY updatedAt DESC LIMIT 1').get(projectId);
      if (!row) { const id = randomUUID(); db.prepare('INSERT INTO threads(id,projectId,title,createdAt,updatedAt) VALUES(?,?,?,?,?)').run(id, projectId, 'Conversation', now(), now()); row = db.prepare('SELECT * FROM threads WHERE id=?').get(id); }
      const messages = db.prepare('SELECT * FROM messages WHERE threadId=? ORDER BY createdAt, rowid').all(row.id).map(message => ({ ...message, meta: message.meta ? JSON.parse(message.meta) : null }));
      return { ...row, messages };
    },
    postMessage(projectId, input) {
      registered(projectId); object(input, ['threadId', 'author', 'body', 'state', 'meta', 'id']);
      text(input.author, 'author', 80); text(input.body, 'body', 12000);
      if (input.state !== undefined && !['pending', 'streaming', 'final', 'failed'].includes(input.state)) reject('Invalid state');
      const thread = this.thread(projectId, { threadId: input.threadId });
      const id = input.id ?? randomUUID();
      if (input.id) text(input.id, 'id', 64);
      tx(() => {
        db.prepare('INSERT INTO messages(id,threadId,projectId,author,body,createdAt,state,meta) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body, state=excluded.state, meta=excluded.meta').run(id, thread.id, projectId, input.author, input.body, now(), input.state ?? 'final', input.meta ? JSON.stringify(input.meta) : null);
        db.prepare('UPDATE threads SET updatedAt=? WHERE id=?').run(now(), thread.id);
      });
      return { id, threadId: thread.id };
    },
    updateMessage(id, input) {
      object(input, ['body', 'state', 'meta']);
      const row = db.prepare('SELECT * FROM messages WHERE id=?').get(id);
      if (!row) reject('Message not found', 404);
      if (input.body !== undefined) text(input.body, 'body', 12000);
      if (input.state !== undefined && !['pending', 'streaming', 'final', 'failed'].includes(input.state)) reject('Invalid state');
      db.prepare('UPDATE messages SET body=COALESCE(?, body), state=COALESCE(?, state), meta=COALESCE(?, meta) WHERE id=?').run(input.body ?? null, input.state ?? null, input.meta ? JSON.stringify(input.meta) : null, id);
      return { ok: true };
    },
    pendingOwnerMessages(projectId) { registered(projectId); return db.prepare(`SELECT * FROM messages WHERE projectId=? AND author='owner' AND state='pending' ORDER BY createdAt`).all(projectId); },
    openDecision(projectId, input) {
      registered(projectId); object(input, ['kind', 'title', 'body', 'options', 'threadId', 'payload']);
      if (!DECISION_KINDS.includes(input.kind)) reject('Invalid decision kind');
      text(input.title, 'title', 200); text(input.body, 'body', 8000);
      if (!Array.isArray(input.options) || input.options.length < 1 || input.options.length > 6 || input.options.some(option => typeof option !== 'string' || !option.trim() || option.length > 120)) reject('Invalid options');
      const id = randomUUID();
      db.prepare(`INSERT INTO decisions(id,projectId,kind,title,body,options,createdAt,state,threadId,payload) VALUES(?,?,?,?,?,?,?,'open',?,?)`).run(id, projectId, input.kind, input.title, input.body, JSON.stringify(input.options), now(), input.threadId ?? null, input.payload ? JSON.stringify(input.payload) : null);
      return { id };
    },
    decisions({ projectId, state = 'open', limit = 100 } = {}) {
      const clauses = []; const params = [];
      if (projectId) { registered(projectId); clauses.push('projectId=?'); params.push(projectId); }
      if (state) { clauses.push('state=?'); params.push(state); }
      return db.prepare(`SELECT * FROM decisions ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY createdAt DESC LIMIT ?`).all(...params, Math.min(500, limit)).map(row => ({ ...row, options: JSON.parse(row.options), payload: row.payload ? JSON.parse(row.payload) : null }));
    },
    resolveDecision(id, input) {
      object(input, ['choice', 'note']);
      const row = db.prepare('SELECT * FROM decisions WHERE id=?').get(id);
      if (!row) reject('Decision not found', 404);
      if (row.state !== 'open') reject('Decision already resolved', 409);
      const options = JSON.parse(row.options);
      if (!options.includes(input.choice)) reject('Choice must be one of the offered options');
      if (input.note !== undefined) text(input.note, 'note', 4000);
      db.prepare(`UPDATE decisions SET state='resolved', choice=?, note=?, resolvedAt=? WHERE id=?`).run(input.choice, input.note ?? null, now(), id);
      return { ...row, options, payload: row.payload ? JSON.parse(row.payload) : null, state: 'resolved', choice: input.choice, note: input.note ?? null };
    },
    // Spend by project; runs report cost when the engine exposes it, the PM reports its own sessions.
    recordCost(projectId, input) {
      registered(projectId); object(input, ['jobId', 'kind', 'usd', 'tokens']);
      text(input.kind, 'kind', 40);
      if (!Number.isFinite(input.usd) || input.usd < 0) reject('Invalid usd');
      if (input.tokens !== undefined && (!Number.isInteger(input.tokens) || input.tokens < 0)) reject('Invalid tokens');
      db.prepare('INSERT INTO costs(projectId,jobId,kind,usd,tokens,createdAt) VALUES(?,?,?,?,?,?)').run(projectId, input.jobId ?? null, input.kind, input.usd, input.tokens ?? 0, now());
      return { ok: true };
    },
    costs(projectId) {
      registered(projectId);
      const sum = since => db.prepare('SELECT COALESCE(SUM(usd),0) AS usd, COALESCE(SUM(tokens),0) AS tokens, COUNT(*) AS entries FROM costs WHERE projectId=? AND createdAt>=?').get(projectId, since);
      return { day: sum(now() - DAY), week: sum(now() - 7 * DAY), month: sum(now() - 30 * DAY) };
    },
    // Archived run files; the dashboard links to them when the live tail has been pruned.
    artifacts(id, input) {
      object(input, ['workerId', 'leaseToken', 'artifacts']);
      text(input.workerId, 'workerId'); text(input.leaseToken, 'leaseToken');
      if (!input.artifacts || typeof input.artifacts !== 'object' || Array.isArray(input.artifacts)) reject('Invalid artifacts');
      const payload = JSON.stringify(input.artifacts);
      if (payload.length > 65536) reject('Artifacts exceed 64KB', 413);
      return tx(() => { const row = lease(id, input); db.prepare('INSERT INTO artifacts(jobId,projectId,payload,createdAt) VALUES(?,?,?,?) ON CONFLICT(jobId) DO UPDATE SET payload=excluded.payload, createdAt=excluded.createdAt').run(id, row.projectId, payload, now()); return { ok: true }; });
    },
    artifactsFor(id) { get(id); const row = db.prepare('SELECT * FROM artifacts WHERE jobId=?').get(id); return row ? { jobId: id, ...JSON.parse(row.payload), createdAt: row.createdAt } : null; },
    requeue(id, input = {}) {
      object(input, []);
      return tx(() => {
        const row = get(id);
        if (!['blocked', 'failed'].includes(row.state)) reject('Only blocked or failed jobs can be requeued after human inspection', 409);
        if (row.kind !== 'chat' && db.prepare(`SELECT id FROM jobs WHERE id<>? AND projectId=? AND kind<>'chat' AND state IN ('running','queued') AND (issue IS NULL OR ? IS NULL OR issue=?)`).get(id, row.projectId, row.issue, row.issue)) reject('Active overlapping job already exists', 409);
        db.prepare(`UPDATE jobs SET state='queued',workerId=NULL,leaseToken=NULL,leaseUntil=NULL,result=NULL,updatedAt=? WHERE id=?`).run(now(), id);
        return view(get(id));
      });
    },
  };
}

export function createQueueServer(queue, { token = process.env.AGENT_TEAM_TOKEN } = {}) {
  requireToken(token);
  return createServer(async (req, res) => {
    const reply = (status, data) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
    try {
      const url = new URL(req.url, 'http://localhost');
      const header = req.headers.authorization ?? '';
      let jobScope = null;
      // A running job's lease grants a model process two routes only: memory search for its own
      // project and proposals for its own job. Everything else needs the shared token.
      if (header.startsWith('Lease ')) {
        const [jobId, workerId, leaseToken] = header.slice(6).split(':');
        const scope = queue.leaseScope?.(jobId, workerId, leaseToken);
        const searchMatch = /^\/projects\/([A-Za-z0-9][A-Za-z0-9_-]{0,79})\/memory\/search$/.exec(url.pathname);
        const allowed = scope && ((req.method === 'GET' && searchMatch && searchMatch[1] === scope.projectId) || (req.method === 'POST' && url.pathname === `/jobs/${scope.jobId}/proposals`));
        if (!allowed) { req.resume(); return reply(401, { error: 'Unauthorized' }); }
      } else if (header.startsWith('Bearer job.')) {
        const [, jobId] = header.slice(7).split('.');
        const auth = Buffer.from(header); const expected = Buffer.from(`Bearer ${/^[a-f0-9-]{36}$/.test(jobId ?? '') ? jobToken(token, jobId) : ''}`);
        jobScope = auth.length === expected.length && timingSafeEqual(auth, expected) ? queue.jobScope?.(jobId) ?? null : null;
        if (!jobScope) { req.resume(); return reply(401, { error: 'Unauthorized' }); }
        if (!jobScopeAllows(jobScope, req.method, url.pathname)) { req.resume(); return reply(403, { error: 'This token is limited to its own job' }); }
      } else {
        const auth = Buffer.from(header); const expected = Buffer.from(`Bearer ${token}`);
        if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) { req.resume(); return reply(401, { error: 'Unauthorized' }); }
      }
      if (req.method === 'GET' && url.pathname === '/health') return reply(200, { ok: true });
      if (req.method === 'GET' && url.pathname === '/jobs') return reply(200, queue.list());
      if (req.method === 'GET' && url.pathname === '/projects') return reply(200, queue.projectsList());
      const settingsGet = /^\/projects\/([A-Za-z0-9][A-Za-z0-9_-]{0,79})\/(settings|settings\/history|tracker\/lookup)$/.exec(url.pathname);
      if (req.method === 'GET' && settingsGet) {
        const [, projectId, what] = settingsGet;
        if (what === 'settings') return reply(200, queue.settings(projectId));
        if (what === 'settings/history') return reply(200, queue.settingsHistory(projectId, { limit: Number(url.searchParams.get('limit') ?? 30) }));
        return reply(200, await queue.trackerLookup(projectId, { teamId: url.searchParams.get('team') ?? undefined }));
      }
      if (req.method === 'GET' && url.pathname === '/evidence') return reply(200, queue.evidenceList({ limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 40 }));
      const evidenceMatch = /^\/jobs\/([a-f0-9-]+)\/evidence$/.exec(url.pathname);
      if (req.method === 'GET' && evidenceMatch) { const found = queue.evidenceFor(evidenceMatch[1]); return found ? reply(200, found) : reject('No evidence yet', 404); }
      const eventsMatch = /^\/jobs\/([a-f0-9-]+)\/events$/.exec(url.pathname);
      if (req.method === 'GET' && eventsMatch) return reply(200, queue.eventsAfter(eventsMatch[1], { after: Number(url.searchParams.get('after') ?? 0), limit: Number(url.searchParams.get('limit') ?? 500) }));
      const jobSub = /^\/jobs\/([a-f0-9-]{36})\/(injection|proposals|artifacts)$/.exec(url.pathname);
      if (req.method === 'GET' && jobSub) {
        const found = jobSub[2] === 'injection' ? queue.injectionFor(jobSub[1]) : jobSub[2] === 'artifacts' ? queue.artifactsFor(jobSub[1]) : queue.proposals({ jobId: jobSub[1], state: url.searchParams.get('state') ?? undefined });
        return found ? reply(200, found) : reject('Not recorded', 404);
      }
      if (req.method === 'GET' && url.pathname === '/launches') return reply(200, queue.launches());
      if (req.method === 'GET' && url.pathname === '/proposals') return reply(200, queue.proposals({ projectId: url.searchParams.get('project') ?? undefined, state: url.searchParams.get('state') ?? 'pending' }));
      if (req.method === 'GET' && url.pathname === '/decisions') return reply(200, queue.decisions({ projectId: url.searchParams.get('project') ?? undefined, state: url.searchParams.get('state') ?? 'open' }));
      const projectGet = /^\/projects\/([A-Za-z0-9][A-Za-z0-9_-]{0,79})\/(thread|threads|costs|memory(?:\/.*)?)$/.exec(url.pathname);
      if (req.method === 'GET' && projectGet) {
        const [, projectId, what] = projectGet;
        if (what === 'thread') return reply(200, queue.thread(projectId, { threadId: url.searchParams.get('thread') ?? undefined }));
        if (what === 'threads') return reply(200, queue.threads(projectId));
        if (what === 'costs') return reply(200, queue.costs(projectId));
        const sub = what.slice('memory'.length + 1);
        const sha = url.searchParams.get('sha') ?? undefined;
        if (!sub) return reply(200, { head: queue.memory.head(), items: queue.memory.items(projectId), files: Object.keys(queue.memory.read(projectId, sha)) });
        if (sub === 'search') return reply(200, queue.memory.search(projectId, url.searchParams.get('q') ?? '', { scope: url.searchParams.getAll('scope'), limit: Number(url.searchParams.get('limit') ?? 20) }));
        if (sub === 'assemble') return reply(200, queue.memory.assemble(projectId, url.searchParams.getAll('scope'), Number(url.searchParams.get('cap') ?? 4000)));
        if (sub === 'log') return reply(200, queue.memory.log(projectId, { limit: Number(url.searchParams.get('limit') ?? 50) }));
        if (sub === 'tree') return reply(200, queue.memory.read(projectId, sha));
        const diff = /^diff\/([0-9a-f]{7,40})$/.exec(sub);
        if (diff) return reply(200, { sha: diff[1], diff: queue.memory.diff(projectId, diff[1], url.searchParams.get('against') ?? undefined) });
        const file = /^file\/(.+)$/.exec(sub);
        if (file) { const content = queue.memory.readFile(projectId, decodeURIComponent(file[1]), sha); return content === null ? reject('Not found', 404) : reply(200, { file: decodeURIComponent(file[1]), sha: sha ?? queue.memory.head(), content }); }
        reject('Not found', 404);
      }
      if (req.method !== 'POST') reject('Not found', 404);
      const limit = evidenceMatch ? 700_000 : eventsMatch ? 4_200_000 : url.pathname.includes('/memory/') ? 400_000 : 65536;
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > limit) { reply(413, { error: `JSON body exceeds ${limit} bytes` }); req.resume(); return; } chunks.push(chunk); }
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { reject('Invalid JSON'); }
      if (jobScope && url.pathname === '/claim' && !(body?.job === jobScope.jobId && Array.isArray(body.projectIds) && body.projectIds.length === 1 && body.projectIds[0] === jobScope.projectId)) reject('This token is limited to its own job', 403);
      if (jobScope && url.pathname.endsWith('/costs') && body?.jobId !== jobScope.jobId) reject('This token is limited to its own job', 403);
      if (url.pathname === '/jobs') return reply(201, queue.enqueue(body));
      if (url.pathname === '/claim') return reply(200, queue.claim(body));
      if (evidenceMatch) return reply(200, queue.evidence(evidenceMatch[1], body));
      if (eventsMatch) return reply(200, queue.appendEvents(eventsMatch[1], body));
      if (jobSub) return reply(200, jobSub[2] === 'injection' ? queue.injection(jobSub[1], body) : jobSub[2] === 'artifacts' ? queue.artifacts(jobSub[1], body) : queue.propose(jobSub[1], body));
      if (url.pathname === '/proposals/resolve') return reply(200, queue.resolveProposals(body));
      const proposal = /^\/proposals\/([a-f0-9-]{36})\/resolve$/.exec(url.pathname);
      if (proposal) return reply(200, queue.resolveProposal(proposal[1], body));
      const decision = /^\/decisions\/([a-f0-9-]{36})\/resolve$/.exec(url.pathname);
      if (decision) return reply(200, queue.resolveDecision(decision[1], body));
      const message = /^\/messages\/([A-Za-z0-9-]{1,64})$/.exec(url.pathname);
      if (message) return reply(200, queue.updateMessage(message[1], body));
      const projectPost = /^\/projects\/([A-Za-z0-9][A-Za-z0-9_-]{0,79})\/(manifest|settings|messages|decisions|costs|memory\/[a-z]+)$/.exec(url.pathname);
      if (projectPost) {
        const [, projectId, what] = projectPost;
        if (what === 'manifest') return reply(200, queue.registerProject(projectId, body));
        if (what === 'settings') return reply(200, queue.saveSettings(projectId, body));
        if (what === 'messages') return reply(201, queue.postMessage(projectId, body));
        if (what === 'decisions') return reply(201, queue.openDecision(projectId, body));
        if (what === 'costs') return reply(200, queue.recordCost(projectId, body));
        const action = what.slice('memory/'.length);
        const author = body.author ?? { name: 'owner' };
        if (action === 'items') return reply(200, queue.memory.write(projectId, body.items, { author, message: body.message }));
        if (action === 'file') return reply(200, queue.memory.writeFile(projectId, body.file, body.content, { author, message: body.message }));
        if (action === 'run') return reply(200, queue.memory.writeRun(projectId, body.ticket, body.content, { author }));
        if (action === 'status') return reply(200, queue.memory.setStatus(projectId, body.ids, body.status, { author }));
        if (action === 'bump') return reply(200, queue.memory.bump(projectId, body.ids, { author }));
        if (action === 'revert') return reply(200, queue.memory.revert(projectId, body.sha, { author }));
        if (action === 'seed') return reply(200, queue.memory.seed(projectId, body.files, { author }));
        if (action === 'init') return reply(200, { sha: queue.memory.ensureProject(projectId) });
        reject('Not found', 404);
      }
      const match = /^\/jobs\/([a-f0-9-]+)\/(heartbeat|complete|fail|requeue|cancel)$/.exec(url.pathname);
      if (!match) reject('Not found', 404);
      reply(200, queue[match[2]](match[1], body));
    } catch (error) { reply(error.status ?? 500, { error: error.status ? error.message : 'Internal server error' }); }
  });
}

// 0.0.0.0 is only for containers behind a TLS-terminating proxy that enforces auth.
export function validBind(host) {
  if (host === '127.0.0.1' || host === '::1' || host === 'localhost') return true;
  if (host === '0.0.0.0' && process.env.AGENT_TEAM_PUBLIC_BIND === '1') return true;
  const parts = host.split('.');
  return parts.length === 4 && parts.every(p => /^\d{1,3}$/.test(p) && Number(p) <= 255) && Number(parts[0]) === 100 && Number(parts[1]) >= 64 && Number(parts[1]) <= 127;
}
export function validateRegistry(projects) {
  if (!projects || typeof projects !== 'object' || Array.isArray(projects) || !Object.keys(projects).length) throw new Error('Configure a nonempty projects registry');
  for (const [id, project] of Object.entries(projects)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id) || !project || typeof project !== 'object' || Array.isArray(project)) throw new Error('Invalid project registry entry');
    text(project.repository, 'project repository', 2048);
  }
}
export async function main(args = process.argv.slice(2)) {
  let config = {}; const overrides = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]; const value = args[++i];
    if (!value) throw new Error(`Missing value for ${flag}`);
    if (flag === '--config') config = JSON.parse(readFileSync(value, 'utf8'));
    else if (['--host', '--port', '--db'].includes(flag)) overrides[flag.slice(2)] = value;
    else throw new Error(`Unknown option ${flag}`);
  }
  config = { ...config, ...overrides };
  const host = config.host ?? '127.0.0.1'; const port = Number(config.port ?? 4310);
  if (!validBind(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Use a loopback or private-network IPv4 bind address and valid port');
  validateRegistry(config.projects);
  requireToken(process.env.AGENT_TEAM_TOKEN);
  const dbPath = config.db ?? '.agent-team-coordinator/queue.sqlite';
  const dataDir = config.dataDir ?? path.dirname(path.resolve(dbPath));
  const memory = config.memory === false ? null : createMemory({ dataDir });
  const queue = createQueue(dbPath, { projects: config.projects, memory, launcher: config.launcher ?? null, jobTokenFor: id => jobToken(process.env.AGENT_TEAM_TOKEN, id), claimTimeoutMs: (config.claimTimeoutMinutes ?? 15) * 60_000 });
  const server = createQueueServer(queue);
  server.on('error', error => { console.error(error.message); queue.close(); process.exitCode = 1; });
  server.listen(port, host, () => console.log(`Agent team coordinator listening on ${host}:${port}`));
  const watchdog = setInterval(() => queue.watchdog().catch(error => console.error(error.message)), 60_000);
  const stop = () => { clearInterval(watchdog); server.close(() => { queue.close(); }); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
