import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import * as fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { validBind } from './queue.mjs';

const UNITS = ['agent-team-coordinator', 'agent-team-worker', 'agent-team-intake'];
const RUN_ID = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9-]+Z-[a-f0-9]{8}$/;
const clip = (text, max) => { const value = String(text ?? '').replace(/\s+/g, ' ').trim(); return value.length > max ? `${value.slice(0, max - 1)}…` : value; };

function tail(file, bytes = 262144) {
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    try {
      const length = Math.min(size, bytes);
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, size - length);
      return buffer.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

// One line per model step: what the coordinator said or which tool it called, and for whom.
export function eventSteps(text, limit = 40) {
  const steps = []; let usage = null; let engineResult = null;
  for (const line of text.split('\n')) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const scope = event.parent_tool_use_id ? 'subagent' : 'coordinator';
    if (event.type === 'assistant') {
      for (const block of event.message?.content ?? []) {
        if (block.type === 'text' && block.text?.trim()) steps.push({ scope, kind: 'text', text: clip(block.text, 300) });
        else if (block.type === 'tool_use') {
          const input = block.input ?? {};
          const detail = input.description ?? input.command ?? input.file_path ?? input.pattern ?? input.prompt ?? input.query ?? '';
          steps.push({ scope, kind: 'tool', text: clip(`${block.name}${input.subagent_type ? ` → ${input.subagent_type}` : ''}${detail ? `: ${detail}` : ''}`, 200) });
        }
      }
    } else if (event.type === 'rate_limit_event' && event.rate_limit_info) {
      const windows = event.rate_limit_info.unifiedWindows ?? {};
      usage = { status: event.rate_limit_info.status, fiveHour: windows.five_hour ?? null, sevenDay: windows.seven_day ?? null };
    } else if (event.type === 'result') engineResult = { subtype: event.subtype, isError: event.is_error === true, durationMs: event.duration_ms, turns: event.num_turns };
  }
  return { steps: steps.slice(-limit), usage, engineResult };
}

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

function runSummary(project, dir, id) {
  const journal = readJson(path.join(dir, 'journal.json'));
  if (!journal) return { project, id, state: 'unreadable' };
  return { project, id, state: journal.state, engine: journal.engine ?? 'opencode', issue: journal.issue ?? null, prUrl: journal.prUrl ?? null,
    delivery: journal.delivery?.state ?? null, startedAt: journal.startedAt, finishedAt: journal.finishedAt ?? null,
    baseCommit: journal.baseCommit ? journal.baseCommit.slice(0, 8) : null, summary: clip(journal.summary ?? journal.error ?? '', 400),
    proposals: Array.isArray(journal.proposals) ? journal.proposals.map(p => p.title) : undefined };
}

export function collectState({ dbPath, projects, stateDir, systemctl = defaultSystemctl, runLimit = 12 }) {
  const services = Object.fromEntries(UNITS.map(unit => [unit, systemctl(unit)]));
  let jobs = [];
  if (dbPath && fs.existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      jobs = db.prepare('SELECT id, projectId, issue, request, state, workerId, createdAt, updatedAt, result FROM jobs ORDER BY createdAt DESC, rowid DESC LIMIT 50').all()
        .map(row => { const request = JSON.parse(row.request); const result = row.result ? JSON.parse(row.result) : null;
          return { id: row.id, projectId: row.projectId, kind: request.kind ?? 'development', issue: row.issue, engine: request.engine ?? null, base: request.base,
            publish: request.publish === true, autoMerge: request.autoMerge === true, state: row.state, workerId: row.workerId, createdAt: row.createdAt, updatedAt: row.updatedAt,
            outcome: result?.outcome ?? null, summary: clip(result?.summary ?? '', 300) }; });
    } finally { db.close(); }
  }
  const runs = []; const locks = {}; const live = [];
  let usage = null;
  for (const [project, checkout] of Object.entries(projects)) {
    const runsDir = path.join(checkout, '.agent-team', 'runs');
    locks[project] = fs.existsSync(path.join(checkout, '.agent-team', 'lock.json'));
    let ids = [];
    try { ids = fs.readdirSync(runsDir).filter(id => RUN_ID.test(id)).sort().reverse(); } catch { /* no runs yet */ }
    for (const id of ids.slice(0, runLimit)) {
      const dir = path.join(runsDir, id);
      const run = runSummary(project, dir, id);
      runs.push(run);
      if (run.state === 'running') {
        const parsed = eventSteps(tail(path.join(dir, 'events.jsonl')), 25);
        live.push({ project, id, issue: run.issue, engine: run.engine, startedAt: run.startedAt, steps: parsed.steps });
        usage = parsed.usage ?? usage;
      } else if (!usage) usage = eventSteps(tail(path.join(dir, 'events.jsonl'), 65536), 0).usage;
    }
  }
  runs.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
  const quarantined = [...new Set(jobs.filter(job => ['blocked', 'failed'].includes(job.state)).map(job => job.projectId))];
  return { generatedAt: new Date().toISOString(), services, jobs, runs, live, locks, usage, quarantined, stateDir };
}

export function runDetail({ projects, project, id }) {
  if (!Object.hasOwn(projects, project) || !RUN_ID.test(id)) return null;
  const dir = path.join(projects[project], '.agent-team', 'runs', id);
  if (!fs.existsSync(path.join(dir, 'journal.json'))) return null;
  const parsed = eventSteps(tail(path.join(dir, 'events.jsonl'), 1048576), 200);
  let summary = ''; try { summary = fs.readFileSync(path.join(dir, 'summary.md'), 'utf8'); } catch { /* not written yet */ }
  return { run: runSummary(project, dir, id), summary, steps: parsed.steps, usage: parsed.usage, engineResult: parsed.engineResult, stderr: tail(path.join(dir, 'stderr.log'), 8192) };
}

function defaultSystemctl(unit) {
  const result = spawnSync('systemctl', ['--user', 'is-active', `${unit}.service`], { encoding: 'utf8', timeout: 5000 });
  return result.error ? 'unknown' : (result.stdout.trim() || 'unknown');
}

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = iso => iso ? new Date(typeof iso === 'number' ? iso : iso).toISOString().replace('T', ' ').slice(0, 16) : '';
const pct = value => typeof value === 'number' ? `${Math.round(value * 100)}%` : '?';
const resets = at => at ? when(at * 1000) + ' UTC' : '';
const STYLE = `body{font:14px/1.45 system-ui,sans-serif;margin:0;padding:16px 20px;background:#f6f7f9;color:#1d2430}h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:22px 0 8px}
table{border-collapse:collapse;width:100%;background:#fff;border:1px solid #e1e4ea}th,td{text-align:left;padding:6px 8px;border-top:1px solid #eef0f3;vertical-align:top}th{background:#f0f2f5;font-weight:600}
.s{display:inline-block;padding:1px 8px;border-radius:10px;font-size:12px;background:#e5e7eb}.active,.ready,.completed,.merged{background:#d1fae5}.running,.queued{background:#dbeafe}.blocked,.failed,.inactive,.unknown{background:#fee2e2}.idle,.canceled{background:#e5e7eb}
.muted{color:#6b7280}.step{font-family:ui-monospace,monospace;font-size:12px;white-space:pre-wrap}.sub{color:#7c3aed}pre{background:#fff;border:1px solid #e1e4ea;padding:10px;overflow:auto;font-size:12px}a{color:#1d4ed8}.usage{display:flex;gap:24px;flex-wrap:wrap}`;
const badge = state => `<span class="s ${escape(state)}">${escape(state)}</span>`;

export function renderIndex(state) {
  const usage = state.usage ? `<div class="usage"><div>5-hour window: <b>${pct(state.usage.fiveHour?.utilization)}</b> used <span class="muted">resets ${escape(resets(state.usage.fiveHour?.resetsAt))}</span></div><div>7-day window: <b>${pct(state.usage.sevenDay?.utilization)}</b> used <span class="muted">resets ${escape(resets(state.usage.sevenDay?.resetsAt))}</span></div><div class="muted">from the last Claude run's own report</div></div>` : '<p class="muted">No Claude usage report yet.</p>';
  const live = state.live.length ? state.live.map(run => `<h3>${escape(run.project)} · ${escape(run.issue ?? 'unpinned')} · <a href="/runs/${escape(run.project)}/${escape(run.id)}">${escape(run.id)}</a> <span class="muted">since ${escape(when(run.startedAt))}</span></h3>
<div>${run.steps.map(step => `<div class="step"><span class="${step.scope === 'subagent' ? 'sub' : ''}">${step.scope === 'subagent' ? '↳ ' : ''}</span>${escape(step.text)}</div>`).join('') || '<div class="muted">Waiting for the first model event…</div>'}</div>`).join('') : '<p class="muted">Nothing is executing right now.</p>';
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="20"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent team</title><style>${STYLE}</style></head><body>
<h1>Agent team</h1><div class="muted">Read-only view · refreshed ${escape(when(state.generatedAt))} UTC · <a href="/api/state">JSON</a></div>
<h2>Services</h2><div>${Object.entries(state.services).map(([unit, status]) => `${escape(unit.replace('agent-team-', ''))} ${badge(status)}`).join(' &nbsp; ')}${state.quarantined.length ? ` &nbsp; <b>Quarantined:</b> ${state.quarantined.map(escape).join(', ')} <span class="muted">(blocked or failed job; inspect, then <code>node cli.mjs requeue JOB</code>)</span>` : ''}</div>
<h2>Claude subscription usage</h2>${usage}
<h2>Executing now</h2>${live}
<h2>Queue</h2><table><tr><th>Created</th><th>Project</th><th>Kind</th><th>Issue</th><th>Engine</th><th>Flags</th><th>State</th><th>Result</th></tr>
${state.jobs.map(job => `<tr><td>${escape(when(job.createdAt))}</td><td>${escape(job.projectId)}</td><td>${escape(job.kind)}</td><td>${escape(job.issue ?? '')}</td><td>${escape(job.engine ?? 'worker default')}</td><td>${job.publish ? 'publish ' : ''}${job.autoMerge ? 'auto-merge' : ''}</td><td>${badge(job.state)}</td><td>${escape(job.summary)}<div class="muted">${escape(job.id)}</div></td></tr>`).join('') || '<tr><td colspan="8" class="muted">No jobs yet.</td></tr>'}</table>
<h2>Runs</h2><table><tr><th>Started</th><th>Project</th><th>Issue</th><th>Engine</th><th>State</th><th>Delivery</th><th>Summary</th></tr>
${state.runs.map(run => `<tr><td>${escape(when(run.startedAt))}</td><td>${escape(run.project)}</td><td>${escape(run.issue ?? (run.proposals ? 'ideation' : ''))}</td><td>${escape(run.engine)}</td><td>${badge(run.state)}</td><td>${run.delivery ? badge(run.delivery) : ''}${run.prUrl ? ` <a href="${escape(run.prUrl)}">PR</a>` : ''}</td><td><a href="/runs/${escape(run.project)}/${escape(run.id)}">details</a> ${escape(run.summary)}${run.proposals?.length ? `<ul>${run.proposals.map(title => `<li>${escape(title)}</li>`).join('')}</ul>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">No runs yet.</td></tr>'}</table>
</body></html>`;
}

export function renderRun(detail) {
  const { run } = detail;
  return `<!doctype html><html><head><meta charset="utf-8">${run.state === 'running' ? '<meta http-equiv="refresh" content="15">' : ''}<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(run.id)}</title><style>${STYLE}</style></head><body>
<div><a href="/">← Agent team</a></div><h1>${escape(run.project)} · ${escape(run.issue ?? 'ideation')} ${badge(run.state)}</h1>
<div class="muted">${escape(run.id)} · engine ${escape(run.engine)} · base ${escape(run.baseCommit ?? '')} · ${escape(when(run.startedAt))} → ${escape(when(run.finishedAt) || 'running')}${run.prUrl ? ` · <a href="${escape(run.prUrl)}">${escape(run.prUrl)}</a>` : ''}</div>
${detail.engineResult ? `<p>Engine result: ${escape(detail.engineResult.subtype ?? '')}${detail.engineResult.isError ? ' (error)' : ''}, ${escape(detail.engineResult.turns ?? '?')} turns, ${Math.round((detail.engineResult.durationMs ?? 0) / 60000)} min</p>` : ''}
<h2>Model steps</h2><div>${detail.steps.map(step => `<div class="step"><span class="${step.scope === 'subagent' ? 'sub' : ''}">${step.scope === 'subagent' ? '↳ ' : ''}</span>${escape(step.text)}</div>`).join('') || '<div class="muted">No events recorded.</div>'}</div>
<h2>Summary</h2><pre>${escape(detail.summary || 'Not written yet.')}</pre>
${detail.stderr.trim() ? `<h2>stderr (tail)</h2><pre>${escape(detail.stderr)}</pre>` : ''}
</body></html>`;
}

export function createDashboardServer(config) {
  const projects = config.projects;
  return createServer((req, res) => {
    const reply = (status, type, body) => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
    try {
      if (req.method !== 'GET') return reply(405, 'text/plain', 'GET only');
      const url = new URL(req.url, 'http://localhost');
      const state = () => collectState({ dbPath: config.db, projects, stateDir: config.stateDir, systemctl: config.systemctl });
      if (url.pathname === '/') return reply(200, 'text/html; charset=utf-8', renderIndex(state()));
      if (url.pathname === '/api/state') return reply(200, 'application/json', JSON.stringify(state()));
      const match = /^\/runs\/([A-Za-z0-9][A-Za-z0-9_-]{0,79})\/([^/]+)$/.exec(url.pathname);
      const detail = match && runDetail({ projects, project: match[1], id: match[2] });
      if (!detail) return reply(404, 'text/plain', 'Not found');
      if (url.searchParams.get('format') === 'json') return reply(200, 'application/json', JSON.stringify(detail));
      return reply(200, 'text/html; charset=utf-8', renderRun(detail));
    } catch (error) { reply(500, 'text/plain', 'Dashboard error; see service log'); console.error(error.message); }
  });
}

// The dashboard reads the coordinator database and worker checkouts; it never writes or executes.
export function loadConfig(file) {
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  const coordinator = JSON.parse(fs.readFileSync(config.coordinator, 'utf8'));
  const worker = JSON.parse(fs.readFileSync(config.worker, 'utf8'));
  const host = config.host ?? '127.0.0.1'; const port = Number(config.port ?? 4311);
  if (!validBind(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Use a loopback or Tailscale IPv4 bind address and valid port');
  if (!worker.projects || typeof worker.projects !== 'object') throw new Error('worker.json must map projects');
  return { host, port, db: path.resolve(path.dirname(config.coordinator), coordinator.db ?? '.agent-team-coordinator/queue.sqlite'), projects: worker.projects, stateDir: worker.stateDir };
}

export async function main(args = process.argv.slice(2)) {
  let file;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' && args[i + 1]) file = args[++i];
    else throw new Error('Usage: node dashboard.mjs --config dashboard.json');
  }
  if (!file) throw new Error('Usage: node dashboard.mjs --config dashboard.json');
  const config = loadConfig(file);
  const server = createDashboardServer(config);
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  server.listen(config.port, config.host, () => console.log(`Agent team dashboard on http://${config.host}:${config.port}`));
  const stop = () => server.close();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
