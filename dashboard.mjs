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
export function eventSteps(text, limit = 40, worktree = null) {
  const local = value => worktree ? String(value).split(`${worktree}/`).join('') : value;
  const steps = []; let usage = null; let engineResult = null;
  for (const line of text.split('\n')) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const scope = event.parent_tool_use_id ? 'subagent' : 'coordinator';
    if (event.type === 'assistant') {
      for (const block of event.message?.content ?? []) {
        if (block.type === 'text' && block.text?.trim()) steps.push({ scope, kind: 'text', text: clip(local(block.text), 300) });
        else if (block.type === 'tool_use') {
          const input = block.input ?? {};
          const detail = local(input.description ?? input.command ?? input.file_path ?? input.pattern ?? input.prompt ?? input.query ?? '');
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
  // Running journals carry the pinned issue only in options; the final issue is recorded at the end.
  return { project, id, state: journal.state, engine: journal.engine ?? 'opencode', issue: journal.issue ?? journal.options?.issue ?? null, ideation: journal.options?.ideate === true, worktree: journal.worktree ?? null, prUrl: journal.prUrl ?? null,
    delivery: journal.delivery?.state ?? null, startedAt: journal.startedAt, finishedAt: journal.finishedAt ?? null,
    baseCommit: journal.baseCommit ? journal.baseCommit.slice(0, 8) : null, summary: clip(journal.summary ?? journal.error ?? '', 400),
    proposals: Array.isArray(journal.proposals) ? journal.proposals.map(p => p.title) : undefined };
}

export function collectState({ dbPath, projects, stateDir, defaultEngine = 'opencode', systemctl = defaultSystemctl, runLimit = 12 }) {
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
        const parsed = eventSteps(tail(path.join(dir, 'events.jsonl')), 25, run.worktree);
        live.push({ project, id, issue: run.issue, ideation: run.ideation, engine: run.engine, startedAt: run.startedAt, steps: parsed.steps });
        usage = parsed.usage ?? usage;
      } else if (!usage) usage = eventSteps(tail(path.join(dir, 'events.jsonl'), 65536), 0).usage;
    }
  }
  runs.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
  const quarantined = [...new Set(jobs.filter(job => ['blocked', 'failed'].includes(job.state)).map(job => job.projectId))];
  // One card per configured project: the page must stay readable as projects are added.
  const overview = Object.keys(projects).map(project => {
    const own = jobs.filter(job => job.projectId === project);
    const running = live.find(run => run.project === project) ?? null;
    const delivered = runs.find(run => run.project === project && run.delivery === 'merged') ?? null;
    return { project, status: quarantined.includes(project) ? 'on hold' : running ? 'running' : own.some(job => job.state === 'queued') ? 'queued' : 'idle',
      running: running ? { id: running.id, issue: running.issue, ideation: running.ideation, startedAt: running.startedAt } : null,
      queued: own.filter(job => job.state === 'queued').length, blocked: own.filter(job => ['blocked', 'failed'].includes(job.state)).length,
      delivered: delivered ? { issue: delivered.issue, prUrl: delivered.prUrl, finishedAt: delivered.finishedAt } : null, runs: runs.filter(run => run.project === project).length };
  });
  return { generatedAt: new Date().toISOString(), services, overview, jobs, runs, live, locks, usage, quarantined, stateDir, defaultEngine };
}

export function runDetail({ projects, project, id }) {
  if (!Object.hasOwn(projects, project) || !RUN_ID.test(id)) return null;
  const dir = path.join(projects[project], '.agent-team', 'runs', id);
  if (!fs.existsSync(path.join(dir, 'journal.json'))) return null;
  const run = runSummary(project, dir, id);
  const parsed = eventSteps(tail(path.join(dir, 'events.jsonl'), 1048576), 200, run.worktree);
  let summary = ''; try { summary = fs.readFileSync(path.join(dir, 'summary.md'), 'utf8'); } catch { /* not written yet */ }
  return { run, summary, steps: parsed.steps, usage: parsed.usage, engineResult: parsed.engineResult, stderr: tail(path.join(dir, 'stderr.log'), 8192) };
}

function defaultSystemctl(unit) {
  const result = spawnSync('systemctl', ['--user', 'is-active', `${unit}.service`], { encoding: 'utf8', timeout: 5000 });
  return result.error ? 'unknown' : (result.stdout.trim() || 'unknown');
}

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = iso => iso ? new Date(iso).toISOString().replace('T', ' ').slice(0, 16) : '';
const clock = iso => iso ? new Date(iso).toISOString().slice(11, 16) : '';
const pct = value => typeof value === 'number' ? Math.round(value * 100) : null;
const resets = at => at ? `resets ${clock(at * 1000)} UTC` : '';
const minutes = (from, to) => from ? Math.max(0, Math.round((new Date(to ?? Date.now()) - new Date(from)) / 60000)) : null;
const label = { development: 'build', ideation: 'ideas' };
const STYLE = `@import url('https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=IBM+Plex+Mono:wght@400;500&display=swap');
:root{--paper:#e6ebef;--card:#f4f6f8;--ink:#0f1a26;--ink-2:#4a5866;--ink-3:#8593a1;--line:#cbd3da;--run:#b45309;--ok:#1f6f4a;--bad:#b3261e;--wait:#2a5db0;--mono:'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,monospace;--serif:'Instrument Serif',Georgia,'Times New Roman',serif;--sans:system-ui,-apple-system,'Segoe UI',sans-serif}
*{box-sizing:border-box;min-width:0}body{margin:0;overflow-wrap:anywhere;background:var(--paper);color:var(--ink);font:15px/1.5 var(--sans);padding:28px clamp(16px,4vw,48px) 64px}
a{color:var(--wait);text-decoration:none;border-bottom:1px solid transparent}a:hover,a:focus-visible{border-bottom-color:currentColor}:focus-visible{outline:2px solid var(--run);outline-offset:2px}
header{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 24px;border-bottom:1px solid var(--ink);padding-bottom:14px}
h1{font:400 clamp(32px,5vw,48px)/1 var(--serif);margin:0;letter-spacing:-.01em}h1 em{font-style:italic;color:var(--ink-2)}
.meta{font:12px/1.4 var(--mono);color:var(--ink-3);margin-left:auto;text-align:right}
.units{display:flex;flex-wrap:wrap;gap:10px 22px;padding:14px 0 0;font:13px/1.4 var(--mono)}.units span{display:inline-flex;align-items:center;gap:8px}
.dot{width:8px;height:8px;border-radius:50%;background:var(--ink-3);flex:none}.dot.active{background:var(--ok)}.dot.inactive,.dot.failed,.dot.unknown{background:var(--bad)}
.alert{margin:18px 0 0;padding:12px 16px;background:#fbe9e7;border-left:3px solid var(--bad);font-size:14px}.alert code{font:13px var(--mono)}
.grid{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:32px;margin-top:36px}@media(max-width:860px){.grid{grid-template-columns:1fr}}
h2{font:400 22px/1.2 var(--serif);margin:0 0 12px;display:flex;align-items:baseline;gap:12px}h2 small{font:12px var(--mono);color:var(--ink-3)}
section+section{margin-top:40px}
.now{background:var(--card);border:1px solid var(--line);padding:18px 20px}.now h3{margin:0;font:400 20px/1.25 var(--serif)}.now h3 a{color:inherit}
.now .sub{font:12px var(--mono);color:var(--ink-2);margin:6px 0 14px;display:flex;flex-wrap:wrap;gap:6px 18px}
.pulse{display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--run);margin-right:10px;vertical-align:1px;animation:breathe 2.4s ease-in-out infinite}@keyframes breathe{0%,100%{box-shadow:0 0 0 0 rgba(180,83,9,.45)}50%{box-shadow:0 0 0 7px rgba(180,83,9,0)}}
@media(prefers-reduced-motion:reduce){.pulse{animation:none}}
.ticker{font:12.5px/1.55 var(--mono);border-top:1px solid var(--line);padding-top:10px;max-height:340px;overflow:auto}.ticker div{display:grid;grid-template-columns:30px minmax(0,1fr);gap:10px;padding:2px 0}.ticker i{font-style:normal;color:var(--ink-3);text-align:right}
.ticker .t{color:var(--ink)}.ticker .agent{color:var(--ink-2)}.ticker .agent::before{content:'↳ '}.ticker .say{color:var(--ink);font-family:var(--sans);font-size:13.5px}
.empty{color:var(--ink-2);font-size:14px;padding:14px 0}
.gauge{margin-bottom:18px}.gauge .lbl{display:flex;justify-content:space-between;font:12px var(--mono);color:var(--ink-2);margin-bottom:6px}.gauge .lbl b{color:var(--ink);font-weight:500}
.gauge .bar{height:6px;background:#d5dce2;position:relative}.gauge .bar i{position:absolute;inset:0 auto 0 0;background:var(--ink)}.gauge .bar i.hot{background:var(--run)}.gauge .bar i.full{background:var(--bad)}
.note{font:12px/1.5 var(--mono);color:var(--ink-3)}
.ledger{border-top:1px solid var(--ink)}.row{display:grid;grid-template-columns:52px 120px minmax(0,1fr) auto;gap:6px 16px;padding:12px 0;border-bottom:1px solid var(--line);align-items:baseline}
@media(max-width:640px){.row{grid-template-columns:44px minmax(0,1fr) auto}.row .what{grid-column:1/-1;padding-left:0}}
.row .at{font:12px var(--mono);color:var(--ink-3)}.row .who{font:13px var(--mono)}.row .who small{display:block;color:var(--ink-3);font-size:11px}
.row .what{font-size:14px;color:var(--ink-2)}.row .what b{color:var(--ink);font-weight:500}.row .what ul{margin:6px 0 0;padding-left:18px}
.st{font:11.5px/1 var(--mono);letter-spacing:.04em;text-transform:uppercase;padding:5px 9px;border:1px solid currentColor;border-radius:2px;white-space:nowrap}
.st.ready,.st.completed,.st.merged,.st.active{color:var(--ok)}.st.running{color:var(--run)}.st.queued{color:var(--wait)}.st.blocked,.st.failed{color:var(--bad)}.st.idle,.st.canceled,.st.interrupted,.st.unreadable{color:var(--ink-3)}
pre{background:var(--card);border:1px solid var(--line);padding:14px;overflow:auto;font:12.5px/1.5 var(--mono);white-space:pre-wrap}
.crumb{font:12px var(--mono);margin-bottom:22px}
.projects{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px}.project{background:var(--card);border:1px solid var(--line);border-top:3px solid var(--ink);padding:14px 16px}.project.hold{border-top-color:var(--bad)}
.pname{display:flex;justify-content:space-between;align-items:center;gap:10px;font:500 15px var(--mono);margin-bottom:8px}.pline{font-size:14px;color:var(--ink-2)}.pline+.pline{margin-top:4px}
.st.on\ hold{color:var(--bad)}`;
const tag = value => `<span class="st ${escape(value)}">${escape(value)}</span>`;
const ticker = steps => steps.length
  ? `<div class="ticker">${steps.map((step, index) => `<div><i>${index + 1}</i><span class="${step.kind === 'text' ? 'say' : step.scope === 'subagent' ? 'agent' : 't'}">${escape(step.text)}</span></div>`).join('')}</div>`
  : '<p class="empty">Started; waiting for the first model step.</p>';
const gauge = (name, window) => {
  const value = pct(window?.utilization);
  return `<div class="gauge"><div class="lbl"><span>${name}</span><b>${value === null ? 'no data' : `${value}% used`}</b></div><div class="bar"><i class="${value >= 95 ? 'full' : value >= 75 ? 'hot' : ''}" style="width:${value ?? 0}%"></i></div><div class="note">${escape(resets(window?.resetsAt))}</div></div>`;
};

export function renderIndex(state) {
  const units = Object.entries(state.services).map(([unit, status]) => `<span><i class="dot ${escape(status)}"></i>${escape(unit.replace('agent-team-', ''))}</span>`).join('');
  const alert = state.quarantined.length ? `<div class="alert"><b>${escape(state.quarantined.join(', '))}</b> is on hold: a job ended blocked or failed, so nothing new starts for that project. Read the run below, then <code>node cli.mjs requeue JOB</code> to release it.</div>` : '';
  const now = state.live.length ? state.live.map(run => `<div class="now"><h3><span class="pulse"></span><a href="/runs/${escape(run.project)}/${escape(run.id)}">${escape(run.issue ?? (run.ideation ? 'Proposing ideas' : 'Unpinned cycle'))}</a></h3>
<div class="sub"><span>${escape(run.project)}</span><span>${escape(run.engine)}</span><span>started ${escape(clock(run.startedAt))} UTC · ${minutes(run.startedAt)} min</span></div>${ticker(run.steps)}</div>`).join('')
    : '<div class="now"><p class="empty" style="padding:4px 0">Nothing running. The team is idle until a card is approved or a job is queued.</p></div>';
  const queue = state.jobs.filter(job => ['queued', 'running'].includes(job.state));
  const jobs = state.jobs.map(job => `<div class="row"><span class="at">${escape(clock(job.createdAt))}</span><span class="who">${escape(job.issue ?? label[job.kind] ?? job.kind)}<small>${escape(job.projectId)} · ${escape(job.engine ?? `${state.defaultEngine ?? 'opencode'} (default)`)}${job.autoMerge ? ' · auto-merge' : job.publish ? ' · publish' : ''}</small></span><span class="what">${escape(job.summary) || (job.state === 'queued' ? 'Waiting for the worker.' : job.state === 'running' ? 'In progress.' : '')}</span>${tag(job.state)}</div>`).join('');
  const runs = state.runs.map(run => `<div class="row"><span class="at">${escape(clock(run.startedAt))}</span><span class="who"><a href="/runs/${escape(run.project)}/${escape(run.id)}">${escape(run.issue ?? (run.ideation || run.proposals ? 'ideas' : 'run'))}</a><small>${escape(run.project)} · ${escape(run.engine)} · ${minutes(run.startedAt, run.finishedAt) ?? '?'} min</small></span><span class="what">${run.delivery ? `<b>${escape(run.delivery)}</b>${run.prUrl ? ` · <a href="${escape(run.prUrl)}">${escape(run.prUrl.replace(/^https:\/\/github\.com\//, ''))}</a>` : ''} · ` : run.prUrl ? `<a href="${escape(run.prUrl)}">${escape(run.prUrl.replace(/^https:\/\/github\.com\//, ''))}</a> · ` : ''}${escape(run.summary)}${run.proposals?.length ? `<ul>${run.proposals.map(title => `<li>${escape(title)}</li>`).join('')}</ul>` : ''}</span>${tag(run.state)}</div>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="20"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent team</title><style>${STYLE}</style></head><body>
<header><h1>Agent team <em>on x3d</em></h1><div class="meta">${escape(when(state.generatedAt))} UTC · refreshes every 20 s<br><a href="/api/state">JSON</a></div></header>
<div class="units">${units}</div>${alert}
<section style="margin-top:30px"><h2>Projects <small>${state.overview.length} configured on this worker</small></h2><div class="projects">${state.overview.map(p => `<div class="project ${p.status === 'on hold' ? 'hold' : ''}"><div class="pname">${escape(p.project)} ${tag(p.status)}</div><div class="pline">${p.running ? `${p.running.issue ? 'Building' : 'Running'} <a href="/runs/${escape(p.project)}/${escape(p.running.id)}">${escape(p.running.issue ?? (p.running.ideation ? 'ideation' : 'unpinned cycle'))}</a> for ${minutes(p.running.startedAt)} min` : p.status === 'on hold' ? `${p.blocked} job${p.blocked === 1 ? '' : 's'} need${p.blocked === 1 ? 's' : ''} inspection` : p.queued ? `${p.queued} job${p.queued === 1 ? '' : 's'} waiting` : 'Waiting for approved work'}</div><div class="pline note">${p.delivered ? `Last shipped ${escape(p.delivered.issue ?? 'run')}${p.delivered.prUrl ? ` · <a href="${escape(p.delivered.prUrl)}">PR</a>` : ''} · ${escape(when(p.delivered.finishedAt))}` : 'Nothing shipped yet'} · ${p.runs} run${p.runs === 1 ? '' : 's'}</div></div>`).join('') || '<p class="empty">No projects are mapped in worker.json.</p>'}</div></section>
<div class="grid"><section><h2>Now</h2>${now}</section>
<aside><h2>Subscription</h2>${state.usage ? gauge('5-hour window', state.usage.fiveHour) + gauge('7-day window', state.usage.sevenDay) + '<p class="note">As reported by the most recent Claude run. A full window ends the running job as blocked; it is not retried.</p>' : '<p class="empty">No Claude run has reported usage yet.</p>'}</aside></div>
<section><h2>Queue <small>${queue.length ? `${queue.length} waiting or running` : 'empty'}</small></h2><div class="ledger">${jobs || '<p class="empty">No jobs yet. Approve an idea in Linear or queue one with the CLI.</p>'}</div></section>
<section><h2>Runs <small>latest ${state.runs.length}</small></h2><div class="ledger">${runs || '<p class="empty">No runs recorded yet.</p>'}</div></section>
</body></html>`;
}

export function renderRun(detail) {
  const { run } = detail;
  const result = detail.engineResult ? `${escape(detail.engineResult.subtype ?? '')}${detail.engineResult.isError ? ' (error)' : ''} · ${escape(detail.engineResult.turns ?? '?')} turns · ${Math.round((detail.engineResult.durationMs ?? 0) / 60000)} min of model time` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">${run.state === 'running' ? '<meta http-equiv="refresh" content="15">' : ''}<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(run.issue ?? 'run')} · ${escape(run.id)}</title><style>${STYLE}</style></head><body>
<div class="crumb"><a href="/">← Agent team</a></div>
<header><h1>${run.state === 'running' ? '<span class="pulse"></span>' : ''}${escape(run.issue ?? (run.ideation ? 'Proposing ideas' : 'Unpinned cycle'))} <em>${escape(run.project)}</em></h1><div class="meta">${tag(run.state)}${run.delivery ? ` ${tag(run.delivery)}` : ''}</div></header>
<div class="units"><span>${escape(run.engine)}</span><span>base ${escape(run.baseCommit ?? '')}</span><span>${escape(when(run.startedAt))} → ${escape(run.finishedAt ? clock(run.finishedAt) : 'running')} UTC · ${minutes(run.startedAt, run.finishedAt) ?? '?'} min</span>${run.prUrl ? `<span><a href="${escape(run.prUrl)}">${escape(run.prUrl.replace(/^https:\/\/github\.com\//, ''))}</a></span>` : ''}${result ? `<span>${result}</span>` : ''}<span class="note">${escape(run.id)}</span></div>
<div class="grid"><section><h2>Steps <small>${detail.steps.length} shown</small></h2>${ticker(detail.steps)}</section>
<aside><h2>Usage</h2>${detail.usage ? gauge('5-hour window', detail.usage.fiveHour) + gauge('7-day window', detail.usage.sevenDay) : '<p class="empty">Not reported for this run.</p>'}</aside></div>
<section><h2>Summary</h2><pre>${escape(detail.summary || 'Not written yet.')}</pre></section>
${detail.stderr.trim() ? `<section><h2>Errors and warnings</h2><pre>${escape(detail.stderr)}</pre></section>` : ''}
</body></html>`;
}

export function createDashboardServer(config) {
  const projects = config.projects;
  return createServer((req, res) => {
    const reply = (status, type, body) => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
    try {
      if (req.method !== 'GET') return reply(405, 'text/plain', 'GET only');
      const url = new URL(req.url, 'http://localhost');
      const state = () => collectState({ dbPath: config.db, projects, stateDir: config.stateDir, defaultEngine: config.defaultEngine, systemctl: config.systemctl });
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
  return { host, port, db: path.resolve(path.dirname(config.coordinator), coordinator.db ?? '.agent-team-coordinator/queue.sqlite'), projects: worker.projects, stateDir: worker.stateDir, defaultEngine: worker.engine ?? 'opencode' };
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
