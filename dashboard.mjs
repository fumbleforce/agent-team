import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import * as fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { validBind } from './queue.mjs';
import { createClient } from './worker.mjs';
import { localToken } from './cli.mjs';

const UNITS = ['agent-team-coordinator', 'agent-team-worker', 'agent-team-intake'];
const RUN_ID = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9-]+Z-[a-f0-9]{8}$/;
const ACTIVE = ['queued', 'running', 'blocked', 'failed'];
const DAY = 86_400_000;
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

// One line per model step for either engine: what the coordinator said or which tool it
// called, and whether a subagent did it. Claude emits assistant/result/rate_limit events;
// OpenCode emits text/tool_use/step_finish parts.
export function eventSteps(text, limit = 40, worktree = null) {
  const local = value => worktree ? String(value).split(`${worktree}/`).join('') : String(value);
  const steps = []; let usage = null; let engineResult = null; let tokens = 0;
  const push = (scope, kind, value) => steps.push({ scope, kind, text: clip(local(value), kind === 'text' ? 300 : 200) });
  for (const line of text.split('\n')) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const scope = event.parent_tool_use_id ? 'subagent' : 'coordinator';
    if (event.type === 'assistant') {
      for (const block of event.message?.content ?? []) {
        if (block.type === 'text' && block.text?.trim()) push(scope, 'text', block.text);
        else if (block.type === 'tool_use') {
          const input = block.input ?? {};
          const detail = input.description ?? input.command ?? input.file_path ?? input.pattern ?? input.prompt ?? input.query ?? '';
          push(scope, 'tool', `${block.name}${input.subagent_type ? ` → ${input.subagent_type}` : ''}${detail ? `: ${detail}` : ''}`);
        }
      }
    } else if (event.type === 'rate_limit_event' && event.rate_limit_info) {
      const windows = event.rate_limit_info.unifiedWindows ?? {};
      usage = { status: event.rate_limit_info.status, fiveHour: windows.five_hour ?? null, sevenDay: windows.seven_day ?? null };
    } else if (event.type === 'result') {
      engineResult = { subtype: event.subtype, isError: event.is_error === true, durationMs: event.duration_ms, turns: event.num_turns };
    } else if (event.type === 'text' && event.part?.text?.trim()) push('coordinator', 'text', event.part.text);
    else if (event.type === 'tool_use' && event.part) {
      const input = event.part.state?.input ?? {};
      const detail = input.description ?? input.command ?? input.filePath ?? input.pattern ?? input.prompt ?? '';
      push(event.part.tool === 'task' ? 'subagent' : 'coordinator', 'tool', `${event.part.tool}${input.subagent_type ? ` → ${input.subagent_type}` : ''}${detail ? `: ${detail}` : ''}`);
    } else if (event.type === 'step_finish' && Number.isFinite(event.part?.tokens?.total)) tokens += event.part.tokens.total;
  }
  return { steps: steps.slice(-limit), usage, engineResult, tokens };
}

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

function runSummary(project, dir, id) {
  const journal = readJson(path.join(dir, 'journal.json'));
  if (!journal) return { project, id, state: 'unreadable' };
  // Running journals carry the pinned issue only in options; the final issue is recorded at the end.
  return { project, id, state: journal.state, engine: journal.engine ?? 'opencode', issue: journal.issue ?? journal.options?.issue ?? null,
    ideation: journal.options?.ideate === true, worktree: journal.worktree ?? null, prUrl: journal.prUrl ?? null,
    delivery: journal.delivery?.state ?? null, startedAt: journal.startedAt, finishedAt: journal.finishedAt ?? null,
    baseCommit: journal.baseCommit ? journal.baseCommit.slice(0, 8) : null, summary: clip(journal.summary ?? journal.error ?? '', 400),
    proposals: Array.isArray(journal.proposals) ? journal.proposals.map(p => p.title) : undefined };
}

export function collectState({ dbPath, projects, stateDir, defaultEngine = 'opencode', systemctl = defaultSystemctl, runLimit = 12, now = Date.now }) {
  const time = now();
  const services = Object.fromEntries(UNITS.map(unit => [unit, systemctl(unit)]));
  let jobs = [];
  if (dbPath && fs.existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      jobs = db.prepare('SELECT id, projectId, issue, request, state, workerId, createdAt, updatedAt, result FROM jobs ORDER BY createdAt DESC, rowid DESC LIMIT 60').all()
        .map(row => { const request = JSON.parse(row.request); const result = row.result ? JSON.parse(row.result) : null;
          return { id: row.id, projectId: row.projectId, kind: request.kind ?? 'development', issue: row.issue, engine: request.engine ?? null, base: request.base,
            proposalLimit: request.proposalLimit ?? null, publish: request.publish === true, autoMerge: request.autoMerge === true, state: row.state, workerId: row.workerId,
            createdAt: row.createdAt, updatedAt: row.updatedAt, outcome: result?.outcome ?? null, summary: clip(result?.summary ?? '', 300) }; });
    } finally { db.close(); }
  }
  const runs = []; const live = []; const openai = { day: 0, week: 0, lastRun: null };
  let usage = null;
  for (const [project, checkout] of Object.entries(projects)) {
    const runsDir = path.join(checkout, '.agent-team', 'runs');
    let ids = [];
    try { ids = fs.readdirSync(runsDir).filter(id => RUN_ID.test(id)).sort().reverse(); } catch { /* no runs yet */ }
    for (const id of ids.slice(0, runLimit)) {
      const dir = path.join(runsDir, id);
      const run = runSummary(project, dir, id);
      runs.push(run);
      const events = path.join(dir, 'events.jsonl');
      if (run.state === 'running') {
        const parsed = eventSteps(tail(events), 40, run.worktree);
        live.push({ project, id, issue: run.issue, ideation: run.ideation, engine: run.engine, startedAt: run.startedAt, steps: parsed.steps });
        usage = parsed.usage ?? usage;
      } else if (run.engine === 'claude' && !usage) usage = eventSteps(tail(events, 65536), 0).usage;
      if (run.engine === 'opencode') {
        const age = time - new Date(run.startedAt ?? 0).getTime();
        if (age <= 7 * DAY) {
          const { tokens } = eventSteps(fs.existsSync(events) ? fs.readFileSync(events, 'utf8') : '', 0);
          openai.week += tokens; if (age <= DAY) openai.day += tokens;
          openai.lastRun ??= { id, project, tokens, startedAt: run.startedAt };
        }
      }
    }
  }
  runs.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
  const quarantined = [...new Set(jobs.filter(job => ['blocked', 'failed'].includes(job.state)).map(job => job.projectId))];
  // One card per configured project plus what the intake would do next for it.
  const overview = Object.keys(projects).map(project => {
    const own = jobs.filter(job => job.projectId === project);
    const running = live.find(run => run.project === project) ?? null;
    const delivered = runs.find(run => run.project === project && run.delivery === 'merged') ?? null;
    const manifest = readJson(path.join(projects[project], '.agent-team.json'));
    const ideation = manifest?.ideation?.enabled === true ? manifest.ideation : null;
    const lastIdeas = own.find(job => job.kind === 'ideation' && job.state !== 'canceled');
    const cooldownEnds = ideation && lastIdeas ? Number(lastIdeas.createdAt) + ideation.minimumIntervalHours * 3_600_000 : null;
    const held = own.filter(job => ['blocked', 'failed'].includes(job.state));
    return { project, name: manifest?.name ?? project, status: held.length ? 'on hold' : running ? 'running' : own.some(job => job.state === 'queued') ? 'queued' : 'idle',
      running: running ? { id: running.id, issue: running.issue, ideation: running.ideation, startedAt: running.startedAt } : null,
      queued: own.filter(job => job.state === 'queued').map(job => ({ id: job.id, issue: job.issue, kind: job.kind, createdAt: job.createdAt })),
      held: held.map(job => ({ id: job.id, issue: job.issue, kind: job.kind, summary: job.summary })),
      delivered: delivered ? { issue: delivered.issue, prUrl: delivered.prUrl, finishedAt: delivered.finishedAt } : null, runs: runs.filter(run => run.project === project).length,
      ideation: ideation ? { batchSize: ideation.batchSize, backlogCap: ideation.backlogCap, cooldownEnds, blockedBy: held.length ? 'held job' : own.some(job => ACTIVE.includes(job.state)) ? 'active job' : cooldownEnds && cooldownEnds > time ? 'cooldown' : null } : null };
  });
  return { generatedAt: new Date(time).toISOString(), services, overview, jobs, runs, live, usage, openai, quarantined, stateDir, defaultEngine };
}

export function runDetail({ projects, project, id }) {
  if (!Object.hasOwn(projects, project) || !RUN_ID.test(id)) return null;
  const dir = path.join(projects[project], '.agent-team', 'runs', id);
  if (!fs.existsSync(path.join(dir, 'journal.json'))) return null;
  const run = runSummary(project, dir, id);
  const parsed = eventSteps(tail(path.join(dir, 'events.jsonl'), 1048576), 300, run.worktree);
  let summary = ''; try { summary = fs.readFileSync(path.join(dir, 'summary.md'), 'utf8'); } catch { /* not written yet */ }
  return { run, summary, steps: parsed.steps, usage: parsed.usage, engineResult: parsed.engineResult, tokens: parsed.tokens, stderr: tail(path.join(dir, 'stderr.log'), 8192) };
}

function defaultSystemctl(unit) {
  const result = spawnSync('systemctl', ['--user', 'is-active', `${unit}.service`], { encoding: 'utf8', timeout: 5000 });
  return result.error ? 'unknown' : (result.stdout.trim() || 'unknown');
}

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = iso => iso ? new Date(iso).toISOString().replace('T', ' ').slice(0, 16) : '';
const clock = iso => iso ? new Date(iso).toISOString().slice(11, 16) : '';
const pct = value => typeof value === 'number' ? Math.round(value * 100) : null;
const minutes = (from, to) => from ? Math.max(0, Math.round((new Date(to ?? Date.now()) - new Date(from)) / 60000)) : null;
const compact = n => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
const short = url => escape(/\/pull\/(\d+)$/.test(url) ? `#${url.match(/\/pull\/(\d+)$/)[1]}` : url.replace(/^https:\/\/github\.com\//, ''));
const STYLE = `:root{--bg:#10161d;--panel:#161e27;--panel-2:#1c2632;--line:#27333f;--text:#dde4ea;--muted:#8a98a6;--dim:#5c6975;--run:#e5a53a;--ok:#4cc38a;--bad:#f0616a;--wait:#79b8ff;--sans:system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace}
*{box-sizing:border-box;min-width:0}html{color-scheme:dark}body{margin:0;background:var(--bg);color:var(--text);font:13.5px/1.45 var(--sans);padding:14px clamp(12px,2.5vw,28px) 40px;overflow-wrap:anywhere}
a{color:var(--wait);text-decoration:none}a:hover{text-decoration:underline}:focus-visible{outline:2px solid var(--run);outline-offset:2px}
header{display:grid;grid-template-columns:auto 1fr auto;gap:12px 28px;align-items:center;padding-bottom:12px;border-bottom:1px solid var(--line)}
h1{font:600 18px/1 var(--sans);margin:0;letter-spacing:-.01em}h1 span{color:var(--muted);font-weight:400}
.units{display:flex;flex-wrap:wrap;gap:6px 18px;font:12px var(--mono);color:var(--muted);padding:10px 0 0}.units span{display:inline-flex;align-items:center;gap:7px}
.dot{width:7px;height:7px;border-radius:50%;background:var(--dim)}.dot.active{background:var(--ok)}.dot.inactive,.dot.failed,.dot.unknown{background:var(--bad)}
.usage{display:flex;gap:22px;flex-wrap:wrap}.g{min-width:150px}.g .l{display:flex;justify-content:space-between;gap:10px;font:11.5px var(--mono);color:var(--muted)}.g .l b{color:var(--text);font-weight:500}
.g .bar{height:4px;background:var(--line);margin:5px 0 3px;position:relative}.g .bar i{position:absolute;inset:0 auto 0 0;background:var(--wait)}.g .bar i.hot{background:var(--run)}.g .bar i.full{background:var(--bad)}.g .n{font:11px var(--mono);color:var(--dim)}
.meta{font:11.5px var(--mono);color:var(--dim);text-align:right}@media(max-width:900px){header{grid-template-columns:1fr 1fr}.meta{grid-column:1/-1;text-align:left}}
.flash{margin:12px 0 0;padding:8px 12px;border-left:3px solid var(--wait);background:var(--panel);font-size:13px}.flash.err{border-color:var(--bad)}
.projects{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px;margin:14px 0}
.card{background:var(--panel);border:1px solid var(--line);padding:10px 12px}.card.hold{border-color:#5a2b2f}.card .top{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px}.card .top b{font:600 13.5px var(--sans)}
.card p{margin:2px 0;color:var(--muted);font-size:12.5px}.card p.n{font:11.5px var(--mono);color:var(--dim)}.card form{margin-top:8px;display:flex;gap:6px;flex-wrap:wrap}
button{font:12px var(--mono);color:var(--text);background:var(--panel-2);border:1px solid var(--line);padding:5px 10px;cursor:pointer;border-radius:3px}button:hover{border-color:var(--muted)}button[disabled]{opacity:.45;cursor:default}
.cols{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,2fr);gap:16px;align-items:start}.cols.even{grid-template-columns:1fr 1fr}@media(max-width:900px){.cols,.cols.even{grid-template-columns:1fr}}
h2{font:600 12px/1 var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:16px 0 8px;display:flex;gap:10px;align-items:baseline}h2 small{font-weight:400;text-transform:none;letter-spacing:0;color:var(--dim)}
.now{background:var(--panel);border:1px solid var(--line);padding:10px 12px}.now+.now{margin-top:10px}.now h3{margin:0;font:600 15px var(--sans);display:flex;align-items:center;gap:9px}.now h3 a{color:inherit}
.now .sub{font:11.5px var(--mono);color:var(--muted);margin:4px 0 8px;display:flex;flex-wrap:wrap;gap:4px 14px}
.pulse{width:9px;height:9px;border-radius:50%;background:var(--run);animation:breathe 2.2s ease-in-out infinite;flex:none;display:inline-block}@keyframes breathe{0%,100%{box-shadow:0 0 0 0 rgba(229,165,58,.5)}50%{box-shadow:0 0 0 7px rgba(229,165,58,0)}}
@media(prefers-reduced-motion:reduce){.pulse{animation:none}.ticker{scroll-behavior:auto}}
.ticker{font:12px/1.5 var(--mono);border-top:1px solid var(--line);padding-top:8px;max-height:380px;overflow-y:auto;scroll-behavior:smooth}.ticker.full{max-height:none}.ticker div{display:grid;grid-template-columns:28px minmax(0,1fr);gap:8px;padding:1px 0}.ticker i{font-style:normal;color:var(--dim);text-align:right}
.ticker .t{color:var(--text)}.ticker .agent{color:var(--muted)}.ticker .agent::before{content:'↳ '}.ticker .say{color:var(--wait);font-family:var(--sans);font-size:13px}
.empty{color:var(--muted);font-size:13px;padding:8px 0}
.list{border-top:1px solid var(--line)}.row{display:grid;grid-template-columns:40px minmax(90px,130px) minmax(0,1fr) auto;gap:4px 12px;padding:7px 0;border-bottom:1px solid var(--line);align-items:baseline}
.row .at{font:11.5px var(--mono);color:var(--dim)}.row .who{font:12.5px var(--mono)}.row .who small{display:block;color:var(--dim);font-size:11px}.row .what{font-size:12.5px;color:var(--muted)}.row .what b{color:var(--text);font-weight:500}.row .what ul{margin:4px 0 0;padding-left:16px}
.st{font:10.5px/1 var(--mono);letter-spacing:.05em;text-transform:uppercase;padding:4px 7px;border:1px solid currentColor;border-radius:2px;white-space:nowrap;color:var(--dim)}
.st.ready,.st.completed,.st.merged,.st.active{color:var(--ok)}.st.running{color:var(--run)}.st.queued{color:var(--wait)}.st.blocked,.st.failed,.st.on\\ hold{color:var(--bad)}
.up{background:var(--panel);border:1px solid var(--line);padding:8px 12px}.up .item{display:grid;grid-template-columns:24px minmax(0,1fr);gap:8px;padding:5px 0;border-bottom:1px solid var(--line);font-size:12.5px}.up .item:last-child{border:0}.up i{font-style:normal;color:var(--dim);font:11.5px var(--mono);text-align:right}.up small{display:block;color:var(--dim);font:11px var(--mono)}
pre{background:var(--panel);border:1px solid var(--line);padding:12px;overflow:auto;font:12px/1.5 var(--mono);white-space:pre-wrap;color:var(--muted)}
.crumb{font:12px var(--mono);margin-bottom:12px}`;
const tag = value => `<span class="st ${escape(value)}">${escape(value)}</span>`;
const ticker = (steps, id, full = false) => steps.length
  ? `<div class="ticker ${full ? 'full' : ''}" data-ticker="${escape(id)}">${steps.map((step, index) => `<div><i>${index + 1}</i><span class="${step.kind === 'text' ? 'say' : step.scope === 'subagent' ? 'agent' : 't'}">${escape(step.text)}</span></div>`).join('')}</div>`
  : '<p class="empty">Started; waiting for the first model step.</p>';
const gauge = (name, value, note, kind = 'pct') => `<div class="g"><div class="l"><span>${escape(name)}</span><b>${value === null ? 'no data' : kind === 'pct' ? `${value}% used` : escape(value)}</b></div><div class="bar"><i class="${kind === 'pct' && value >= 95 ? 'full' : kind === 'pct' && value >= 75 ? 'hot' : ''}" style="width:${kind === 'pct' ? (value ?? 0) : 0}%"></i></div><div class="n">${escape(note)}</div></div>`;
// Live refresh swaps <main> from a fresh render; tickers that were at the bottom glide to the new bottom.
const SCRIPT = `(function(){var near={};var all=function(){return document.querySelectorAll('[data-ticker]')};
all().forEach(function(t){t.scrollTop=t.scrollHeight});
function refresh(){if(document.hidden)return;all().forEach(function(t){near[t.dataset.ticker]=t.scrollHeight-t.scrollTop-t.clientHeight<48});
fetch(location.pathname,{cache:'no-store'}).then(function(r){return r.text()}).then(function(html){var doc=new DOMParser().parseFromString(html,'text/html');var next=doc.querySelector('main'),cur=document.querySelector('main');if(!next||!cur)return;
var keep={};all().forEach(function(t){keep[t.dataset.ticker]=t.scrollTop});cur.replaceWith(next);
all().forEach(function(t){var id=t.dataset.ticker;if(near[id]===false&&keep[id]!==undefined)t.scrollTop=keep[id];else t.scrollTo({top:t.scrollHeight,behavior:'smooth'})});
var m=doc.querySelector('.meta'),c=document.querySelector('.meta');if(m&&c)c.innerHTML=m.innerHTML;var u=doc.querySelector('.usage'),cu=document.querySelector('.usage');if(u&&cu)cu.innerHTML=u.innerHTML;}).catch(function(){})}
setInterval(refresh,REFRESH);})();`;

const page = (title, body, refreshMs) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>${STYLE}</style></head><body>${body}${refreshMs ? `<script>${SCRIPT.replace('REFRESH', String(refreshMs))}</script>` : ''}</body></html>`;

export function renderIndex(state, flash = null) {
  const units = Object.entries(state.services).map(([unit, status]) => `<span><i class="dot ${escape(status)}"></i>${escape(unit.replace('agent-team-', ''))}</span>`).join('');
  const claude = state.usage;
  const usage = `<div class="usage">${gauge('Claude 5h', pct(claude?.fiveHour?.utilization), claude?.fiveHour?.resetsAt ? `resets ${clock(claude.fiveHour.resetsAt * 1000)} UTC` : 'from the last Claude run')}${gauge('Claude 7d', pct(claude?.sevenDay?.utilization), claude?.sevenDay?.resetsAt ? `resets ${clock(claude.sevenDay.resetsAt * 1000)} UTC` : '')}${gauge('OpenCode tokens 24h', state.openai.week ? compact(state.openai.day) : null, 'OpenCode reports tokens, not plan limits', 'raw')}${gauge('OpenCode tokens 7d', state.openai.week ? compact(state.openai.week) : null, state.openai.lastRun ? `last run ${compact(state.openai.lastRun.tokens)} tokens` : 'no OpenCode runs this week', 'raw')}</div>`;
  const cards = state.overview.map(p => {
    const ideas = p.ideation ? (p.ideation.blockedBy ? `<button disabled title="${escape(p.ideation.blockedBy === 'cooldown' ? `Cooldown until ${when(p.ideation.cooldownEnds)} UTC` : `Waiting: ${p.ideation.blockedBy}`)}">Propose ideas</button>` : `<button type="submit" name="action" value="ideate">Propose ${p.ideation.batchSize} ideas</button>`) : '';
    const release = p.held.length ? `<button type="submit" name="action" value="requeue" title="Rerun the held job after you have inspected it">Release and rerun</button>` : '';
    return `<div class="card ${p.status === 'on hold' ? 'hold' : ''}"><div class="top"><b>${escape(p.name)}</b>${tag(p.status)}</div>
<p>${p.running ? `${p.running.issue ? 'Building' : 'Running'} <a href="/runs/${escape(p.project)}/${escape(p.running.id)}">${escape(p.running.issue ?? (p.running.ideation ? 'ideation' : 'unpinned cycle'))}</a> · ${minutes(p.running.startedAt)} min` : p.status === 'on hold' ? `${p.held.length} job${p.held.length === 1 ? '' : 's'} on hold: ${escape(p.held[0].summary || p.held[0].issue || 'inspect the run')}` : p.queued.length ? `${p.queued.length} queued: ${escape(p.queued.map(job => job.issue ?? 'ideas').join(', '))}` : 'Idle, waiting for approved work'}</p>
<p class="n">${p.delivered ? `shipped ${escape(p.delivered.issue ?? 'run')} ${p.delivered.prUrl ? `<a href="${escape(p.delivered.prUrl)}">${short(p.delivered.prUrl)}</a>` : ''} ${escape(when(p.delivered.finishedAt))}` : 'nothing shipped yet'} · ${p.runs} runs</p>
${ideas || release ? `<form method="post" action="/actions"><input type="hidden" name="project" value="${escape(p.project)}">${p.held[0] ? `<input type="hidden" name="job" value="${escape(p.held[0].id)}">` : ''}${ideas}${release}</form>` : ''}</div>`;
  }).join('') || '<p class="empty">No projects are mapped in worker.json.</p>';
  const now = state.live.length ? state.live.map(run => `<div class="now"><h3><span class="pulse"></span><a href="/runs/${escape(run.project)}/${escape(run.id)}">${escape(run.issue ?? (run.ideation ? 'Proposing ideas' : 'Unpinned cycle'))}</a></h3>
<div class="sub"><span>${escape(run.project)}</span><span>${escape(run.engine)}</span><span>started ${escape(clock(run.startedAt))} UTC · ${minutes(run.startedAt)} min</span></div>${ticker(run.steps, run.id)}</div>`).join('')
    : '<div class="now"><p class="empty">Nothing running. The team is idle until a card is approved or a job is queued.</p></div>';
  const upcoming = [];
  for (const p of state.overview) {
    for (const job of p.queued) upcoming.push({ at: Number(job.createdAt), text: `${job.issue ? `Build ${job.issue}` : 'Propose ideas'} · ${p.name}`, note: 'queued, starts when the worker is free' });
    if (p.ideation && !p.held.length) {
      const busy = p.running || p.queued.length; const later = p.ideation.cooldownEnds && p.ideation.cooldownEnds > Date.now();
      upcoming.push({ at: Math.max(p.ideation.cooldownEnds ?? 0, busy ? Date.now() + 1 : 0), text: `Propose up to ${p.ideation.batchSize} ideas · ${p.name}`,
        note: `${later ? `from ${when(p.ideation.cooldownEnds)} UTC` : busy ? 'after the current work' : 'on the next intake poll'}, if fewer than ${p.ideation.backlogCap} ideas are open` });
    }
  }
  upcoming.sort((a, b) => a.at - b.at);
  const upcomingHtml = upcoming.length ? upcoming.map((item, index) => `<div class="item"><i>${index + 1}</i><span>${escape(item.text)}<small>${escape(item.note)}</small></span></div>`).join('') : '<p class="empty">Nothing scheduled. Approving an idea in Linear queues a build within a minute.</p>';
  const jobs = state.jobs.map(job => `<div class="row"><span class="at">${escape(clock(job.createdAt))}</span><span class="who">${escape(job.issue ?? (job.kind === 'ideation' ? 'ideas' : 'cycle'))}<small>${escape(job.projectId)} · ${escape(job.engine ?? `${state.defaultEngine} (default)`)}${job.autoMerge ? ' · auto-merge' : job.publish ? ' · publish' : ''}</small></span><span class="what">${escape(job.summary) || (job.state === 'queued' ? 'Waiting for the worker.' : job.state === 'running' ? 'In progress.' : '')}</span>${tag(job.state)}</div>`).join('');
  const runs = state.runs.map(run => `<div class="row"><span class="at">${escape(clock(run.startedAt))}</span><span class="who"><a href="/runs/${escape(run.project)}/${escape(run.id)}">${escape(run.issue ?? (run.ideation || run.proposals ? 'ideas' : 'cycle'))}</a><small>${escape(run.project)} · ${escape(run.engine)} · ${minutes(run.startedAt, run.finishedAt) ?? '?'} min</small></span><span class="what">${run.delivery ? `<b>${escape(run.delivery)}</b> · ` : ''}${run.prUrl ? `<a href="${escape(run.prUrl)}">${short(run.prUrl)}</a> · ` : ''}${escape(run.summary)}${run.proposals?.length ? `<ul>${run.proposals.map(title => `<li>${escape(title)}</li>`).join('')}</ul>` : ''}</span>${tag(run.state)}</div>`).join('');
  const body = `<header><h1>Agent team <span>x3d</span></h1>${usage}<div class="meta">${escape(when(state.generatedAt))} UTC · live · <a href="/api/state">JSON</a></div></header>
<div class="units">${units}</div>
<main>${flash ? `<div class="flash ${flash.error ? 'err' : ''}">${escape(flash.text)}</div>` : ''}
<div class="projects">${cards}</div>
<div class="cols"><section><h2>Now</h2>${now}</section><section><h2>Upcoming <small>automatic runs in order</small></h2><div class="up">${upcomingHtml}</div></section></div>
<div class="cols even"><section><h2>Queue <small>${state.jobs.filter(job => ['queued', 'running'].includes(job.state)).length || 'no'} active</small></h2><div class="list">${jobs || '<p class="empty">No jobs yet.</p>'}</div></section>
<section><h2>Runs <small>latest ${state.runs.length}</small></h2><div class="list">${runs || '<p class="empty">No runs recorded yet.</p>'}</div></section></div></main>`;
  return page('Agent team', body, 10_000);
}

export function renderRun(detail) {
  const { run } = detail;
  const result = detail.engineResult ? `${escape(detail.engineResult.subtype ?? '')}${detail.engineResult.isError ? ' (error)' : ''} · ${escape(detail.engineResult.turns ?? '?')} turns · ${Math.round((detail.engineResult.durationMs ?? 0) / 60000)} min of model time` : detail.tokens ? `${compact(detail.tokens)} tokens` : '';
  const body = `<div class="crumb"><a href="/">← Agent team</a></div>
<header><h1>${run.state === 'running' ? '<span class="pulse"></span> ' : ''}${escape(run.issue ?? (run.ideation ? 'Proposing ideas' : 'Unpinned cycle'))} <span>${escape(run.project)}</span></h1>
<div class="usage">${detail.usage ? gauge('Claude 5h', pct(detail.usage.fiveHour?.utilization), 'at the time of this run') + gauge('Claude 7d', pct(detail.usage.sevenDay?.utilization), '') : ''}</div><div class="meta">${tag(run.state)}${run.delivery ? ` ${tag(run.delivery)}` : ''}</div></header>
<div class="units"><span>${escape(run.engine)}</span><span>base ${escape(run.baseCommit ?? '')}</span><span>${escape(when(run.startedAt))} → ${escape(run.finishedAt ? clock(run.finishedAt) : 'running')} UTC · ${minutes(run.startedAt, run.finishedAt) ?? '?'} min</span>${run.prUrl ? `<span><a href="${escape(run.prUrl)}">${short(run.prUrl)}</a></span>` : ''}${result ? `<span>${result}</span>` : ''}<span>${escape(run.id)}</span></div>
<main><section><h2>Steps <small>${detail.steps.length} shown</small></h2><div class="now">${ticker(detail.steps, run.id, true)}</div></section>
<section><h2>Summary</h2><pre>${escape(detail.summary || 'Not written yet.')}</pre></section>
${detail.stderr.trim() ? `<section><h2>Errors and warnings</h2><pre>${escape(detail.stderr)}</pre></section>` : ''}</main>`;
  return page(`${run.issue ?? 'run'} · ${run.id}`, body, run.state === 'running' ? 10_000 : 0);
}

// Actions are the two operator commands the CLI also offers; the browser must be same-origin.
async function performAction({ form, config, state }) {
  const project = state.overview.find(p => p.project === form.get('project'));
  if (!project) return { error: true, text: 'Unknown project.' };
  const enqueue = config.enqueue ?? createClient(config.coordinatorUrl, config.token);
  if (form.get('action') === 'ideate') {
    if (!project.ideation) return { error: true, text: `${project.name} has no ideation configuration.` };
    if (project.ideation.blockedBy) return { error: true, text: `Ideation for ${project.name} is waiting on: ${project.ideation.blockedBy}.` };
    const job = await enqueue('/jobs', { projectId: project.project, kind: 'ideation', proposalLimit: project.ideation.batchSize, timeoutMinutes: 10, ...(config.base?.[project.project] ?? {}) });
    return { text: `Queued ideation for ${project.name} (${project.ideation.batchSize} proposals). Job ${job.id}.` };
  }
  if (form.get('action') === 'requeue') {
    const job = project.held.find(job => job.id === form.get('job'));
    if (!job) return { error: true, text: 'That job is no longer on hold.' };
    await enqueue(`/jobs/${job.id}/requeue`, {});
    return { text: `Released ${project.name}: job ${job.id} is queued again.` };
  }
  return { error: true, text: 'Unknown action.' };
}

export function createDashboardServer(config) {
  const projects = config.projects;
  const state = () => collectState({ dbPath: config.db, projects, stateDir: config.stateDir, defaultEngine: config.defaultEngine, systemctl: config.systemctl });
  const sameOrigin = req => { const site = req.headers['sec-fetch-site']; const origin = req.headers.origin; return site ? ['same-origin', 'none'].includes(site) : !origin || origin === `http://${req.headers.host}`; };
  return createServer(async (req, res) => {
    const reply = (status, type, body) => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'POST') {
        if (url.pathname !== '/actions') return reply(404, 'text/plain', 'Not found');
        if (!sameOrigin(req)) { req.resume(); return reply(403, 'text/plain', 'Actions are accepted from the dashboard page only'); }
        let size = 0; const chunks = [];
        for await (const chunk of req) { size += chunk.length; if (size > 4096) return reply(413, 'text/plain', 'Too large'); chunks.push(chunk); }
        const form = new URLSearchParams(Buffer.concat(chunks).toString());
        let flash;
        try { flash = await performAction({ form, config, state: state() }); } catch (error) { flash = { error: true, text: `The coordinator refused: ${error.message}` }; }
        res.writeHead(303, { location: `/?${flash.error ? 'error' : 'ok'}=${encodeURIComponent(flash.text)}` }); return res.end();
      }
      if (req.method !== 'GET') return reply(405, 'text/plain', 'GET only');
      if (url.pathname === '/') {
        const flash = url.searchParams.has('ok') ? { text: url.searchParams.get('ok') } : url.searchParams.has('error') ? { error: true, text: url.searchParams.get('error') } : null;
        return reply(200, 'text/html; charset=utf-8', renderIndex(state(), flash));
      }
      if (url.pathname === '/api/state') return reply(200, 'application/json', JSON.stringify(state()));
      const match = /^\/runs\/([A-Za-z0-9][A-Za-z0-9_-]{0,79})\/([^/]+)$/.exec(url.pathname);
      const detail = match && runDetail({ projects, project: match[1], id: match[2] });
      if (!detail) return reply(404, 'text/plain', 'Not found');
      if (url.searchParams.get('format') === 'json') return reply(200, 'application/json', JSON.stringify(detail));
      return reply(200, 'text/html; charset=utf-8', renderRun(detail));
    } catch (error) { reply(500, 'text/plain', 'Dashboard error; see service log'); console.error(error.message); }
  });
}

// The dashboard reads the coordinator database and worker checkouts; its only writes are
// the two operator actions, sent to the coordinator with the same token the CLI uses.
export function loadConfig(file) {
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  const coordinator = JSON.parse(fs.readFileSync(config.coordinator, 'utf8'));
  const worker = JSON.parse(fs.readFileSync(config.worker, 'utf8'));
  const host = config.host ?? '127.0.0.1'; const port = Number(config.port ?? 4311);
  if (!validBind(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Use a loopback or Tailscale IPv4 bind address and valid port');
  if (!worker.projects || typeof worker.projects !== 'object') throw new Error('worker.json must map projects');
  const base = {};
  for (const [project, checkout] of Object.entries(worker.projects)) {
    const manifest = readJson(path.join(checkout, '.agent-team.json'));
    if (typeof manifest?.delivery?.baseBranch === 'string') base[project] = { base: `origin/${manifest.delivery.baseBranch}`, fetch: true };
  }
  return { host, port, db: path.resolve(path.dirname(config.coordinator), coordinator.db ?? '.agent-team-coordinator/queue.sqlite'), projects: worker.projects,
    stateDir: worker.stateDir, defaultEngine: worker.engine ?? 'opencode', coordinatorUrl: worker.coordinatorUrl ?? 'http://127.0.0.1:4310', token: localToken(), base };
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
