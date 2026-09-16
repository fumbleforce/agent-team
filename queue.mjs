import { DatabaseSync } from 'node:sqlite';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ENGINES } from './engines.mjs';
import { remoteBase } from './git-base.mjs';

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
  return token;
}

export function createQueue(dbPath, { projects = {}, now = Date.now, leaseMs = 90_000 } = {}) {
  if (!Number.isInteger(leaseMs) || leaseMs < 1) throw new Error('Invalid leaseMs');
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
    CREATE UNIQUE INDEX IF NOT EXISTS one_running_project ON jobs(projectId) WHERE state='running';`);
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
    object(input, ['projectId', 'issue', 'base', 'fetch', 'engine', 'model', 'timeoutMinutes', 'publish', 'autoMerge', 'idempotencyKey', 'kind', 'proposalLimit', 'approvalRequired']);
    const kind = input.kind ?? 'development';
    if (!['development', 'ideation'].includes(kind)) reject('Invalid kind');
    if (kind === 'ideation') {
      if (['issue', 'publish', 'autoMerge', 'approvalRequired'].some(key => input[key] !== undefined)) reject('Ideation forbids issue, publish, autoMerge and approvalRequired');
      if (!Number.isInteger(input.proposalLimit) || input.proposalLimit < 1 || input.proposalLimit > 10) reject('Ideation requires proposalLimit from 1 to 10');
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
    if (input.model !== undefined && text(input.model, 'model').startsWith('-')) reject('Invalid model');
    const timeoutMinutes = input.timeoutMinutes === undefined ? 45 : input.timeoutMinutes;
    if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 120) reject('Invalid timeoutMinutes');
    if (input.publish !== undefined && typeof input.publish !== 'boolean') reject('Invalid publish');
    if (input.autoMerge !== undefined && typeof input.autoMerge !== 'boolean') reject('Invalid autoMerge');
    if (input.autoMerge === true && input.publish !== true) reject('autoMerge requires publish: true');
    if (input.idempotencyKey !== undefined) text(input.idempotencyKey, 'idempotencyKey');
    return { projectId: input.projectId, kind, ...(kind === 'ideation' ? { proposalLimit: input.proposalLimit } : { approvalRequired: input.approvalRequired ?? false }), ...(input.issue === undefined ? {} : { issue: input.issue }), base,
      ...(input.fetch === true ? { fetch: true } : {}), ...(input.engine === undefined ? {} : { engine: input.engine }),
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
  return {
    close: () => db.close(),
    enqueue(input) {
      const request = normalize(input); const encoded = JSON.stringify(request);
      return tx(() => {
        if (input.idempotencyKey) {
          const prior = db.prepare('SELECT * FROM jobs WHERE idempotencyKey=?').get(input.idempotencyKey);
          if (prior) { if (JSON.stringify(normalize(JSON.parse(prior.request))) !== encoded) reject('Idempotency key reused with different request', 409); return view(prior); }
        }
        const duplicate = db.prepare(`SELECT id FROM jobs WHERE projectId=? AND state IN ('queued','running') AND (issue IS NULL OR ? IS NULL OR issue=?)`).get(request.projectId, request.issue ?? null, request.issue ?? null);
        if (duplicate) reject('Active overlapping job already exists', 409);
        const id = randomUUID();
        db.prepare(`INSERT INTO jobs(id,projectId,issue,request,idempotencyKey,state,createdAt,updatedAt) VALUES(?,?,?,?,?,'queued',?,?)`).run(id, request.projectId, request.issue ?? null, encoded, input.idempotencyKey ?? null, now(), now());
        return view(get(id));
      });
    },
    list: () => tx(() => db.prepare('SELECT * FROM jobs ORDER BY createdAt,rowid').all().map(view)),
    claim(input) {
      object(input, ['workerId', 'projectIds']); text(input.workerId, 'workerId');
      if (!Array.isArray(input.projectIds) || !input.projectIds.length || input.projectIds.length > 100) reject('Invalid projectIds');
      input.projectIds.forEach(registered);
      return tx(() => {
        // Expired/crashed workers may still be executing on another host. Quarantine
        // the entire project until an operator inspects execution and requeues.
        const row = db.prepare(`SELECT * FROM jobs j WHERE state='queued' AND projectId IN (${input.projectIds.map(() => '?').join(',')}) AND NOT EXISTS (SELECT 1 FROM jobs r WHERE r.projectId=j.projectId AND r.state IN ('running','blocked','failed')) ORDER BY createdAt,rowid LIMIT 1`).get(...input.projectIds);
        if (!row) return null;
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
    requeue(id, input = {}) {
      object(input, []);
      return tx(() => {
        const row = get(id);
        if (!['blocked', 'failed'].includes(row.state)) reject('Only blocked or failed jobs can be requeued after human inspection', 409);
        if (db.prepare(`SELECT id FROM jobs WHERE id<>? AND projectId=? AND state IN ('running','queued') AND (issue IS NULL OR ? IS NULL OR issue=?)`).get(id, row.projectId, row.issue, row.issue)) reject('Active overlapping job already exists', 409);
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
      const auth = Buffer.from(req.headers.authorization ?? ''); const expected = Buffer.from(`Bearer ${token}`);
      if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) { req.resume(); return reply(401, { error: 'Unauthorized' }); }
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') return reply(200, { ok: true });
      if (req.method === 'GET' && url.pathname === '/jobs') return reply(200, queue.list());
      if (req.method !== 'POST') reject('Not found', 404);
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > 65536) { reply(413, { error: 'JSON body exceeds 64KB' }); req.resume(); return; } chunks.push(chunk); }
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { reject('Invalid JSON'); }
      if (url.pathname === '/jobs') return reply(201, queue.enqueue(body));
      if (url.pathname === '/claim') return reply(200, queue.claim(body));
      const match = /^\/jobs\/([a-f0-9-]+)\/(heartbeat|complete|fail|requeue|cancel)$/.exec(url.pathname);
      if (!match) reject('Not found', 404);
      reply(200, queue[match[2]](match[1], body));
    } catch (error) { reply(error.status ?? 500, { error: error.status ? error.message : 'Internal server error' }); }
  });
}

export function validBind(host) {
  if (host === '127.0.0.1' || host === '::1' || host === 'localhost') return true;
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
  if (!validBind(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Use a loopback or Tailscale IPv4 bind address and valid port');
  validateRegistry(config.projects);
  requireToken(process.env.AGENT_TEAM_TOKEN);
  const queue = createQueue(config.db ?? '.agent-team-coordinator/queue.sqlite', { projects: config.projects });
  const server = createQueueServer(queue);
  server.on('error', error => { console.error(error.message); queue.close(); process.exitCode = 1; });
  server.listen(port, host, () => console.log(`Agent team coordinator listening on ${host}:${port}`));
  const stop = () => server.close(() => { queue.close(); });
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
