import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validBind } from './queue.mjs';
import { createClient } from './worker.mjs';
import { localToken } from './cli.mjs';
import { DEFAULT_ROSTER } from './roster.mjs';
import { blueprintFile } from './blueprint.mjs';
import { CAPABILITIES, LAUNCHER_FIELDS } from './environments.mjs';
import { TIGHTENINGS } from './teams.mjs';

// Names and voices of every role any stored team defines; refreshed from the coordinator with
// each state collection so renamed or added members appear without a restart.
const ROSTER = { ...DEFAULT_ROSTER };
import { clip, eventSteps } from './evidence.mjs';
import { linkText } from '../adapters/scm/index.mjs';
import { ITEM_TYPES, ITEM_STATUS } from './memory.mjs';
import { overridesFromForm, renderSettingsForm, renderSettingsHistory } from './settings.mjs';

const PM = 'team-pm';
const ACTIVE = ['queued', 'running', 'blocked', 'failed'];
const DAY = 86_400_000;

// Everything the page shows comes from the coordinator API: jobs, run evidence reported by
// workers, and the project registry workers fill from their manifests. No local disk is read.
export async function collectState({ request, now = Date.now }) {
  const time = now();
  const [jobsRaw, evidence, registry, decisions, roster] = await Promise.all([request('/jobs'), request('/evidence?limit=60'), request('/projects'), request('/decisions?state=open').catch(() => []), request('/roster').catch(() => null)]);
  if (roster && typeof roster === 'object') { for (const key of Object.keys(ROSTER)) if (!roster[key]) delete ROSTER[key]; Object.assign(ROSTER, roster); }
  const jobs = jobsRaw.map(job => ({ id: job.id, projectId: job.projectId, kind: job.kind ?? 'development', issue: job.issue ?? null, engine: job.engine ?? null, base: job.base ?? null,
    role: job.role ?? null, message: job.message ?? null, publish: job.publish === true, autoMerge: job.autoMerge === true, state: job.state, workerId: job.workerId ?? null,
    createdAt: job.createdAt, updatedAt: job.updatedAt, outcome: job.result?.outcome ?? null, summary: clip(job.result?.summary ?? '', job.kind === 'chat' ? 4000 : 300) })).sort((a, b) => b.createdAt - a.createdAt);
  const runs = evidence.map(item => ({ ...item.run, jobId: item.jobId, jobState: item.jobState, steps: item.steps, members: item.members, active: item.active, usage: item.usage, tokens: item.tokens, updatedAt: item.updatedAt }))
    .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
  const live = runs.filter(run => run.state === 'running' && run.jobState === 'running');
  // Subscription windows come from whichever engine reports them; token totals from engines that count.
  const usageRun = live.find(run => run.usage) ?? runs.find(run => run.usage) ?? null;
  const usage = usageRun ? { ...usageRun.usage, engine: usageRun.engine } : null;
  const tokens = { day: 0, week: 0, lastRun: null, engines: [...new Set(runs.filter(run => run.tokens).map(run => run.engine))] };
  for (const run of runs) {
    if (!run.tokens) continue;
    const age = time - new Date(run.startedAt ?? 0).getTime();
    if (age <= 7 * DAY) { tokens.week += run.tokens ?? 0; if (age <= DAY) tokens.day += run.tokens ?? 0; tokens.lastRun ??= { jobId: run.jobId, project: run.project, tokens: run.tokens ?? 0 }; }
  }
  const costs = {};
  for (const project of registry) costs[project.id] = await request(`/projects/${project.id}/costs`).catch(() => null);
  const quarantined = [...new Set(jobs.filter(job => job.kind !== 'chat' && ['blocked', 'failed'].includes(job.state)).map(job => job.projectId))];
  const team = Object.entries(ROSTER).filter(([role]) => role !== 'team-owner').map(([role, member]) => {
    const busy = live.find(run => run.active === role || (role === 'team-coordinator' && run.active && !run.ideation && !(run.active in ROSTER)));
    const chatting = jobs.find(job => job.kind === 'chat' && job.role === role && job.state === 'running');
    return { role, name: member.name, title: member.title, working: busy ? { project: busy.project, jobId: busy.jobId, issue: busy.issue ?? (busy.ideation ? 'ideas' : 'cycle') } : chatting ? { project: chatting.projectId, jobId: chatting.id, issue: `chat on ${chatting.issue}` } : null,
      steps: live.reduce((sum, run) => sum + (run.members?.[role] ?? 0), 0) };
  });
  const overview = registry.map(project => {
    const own = jobs.filter(job => job.projectId === project.id && job.kind !== 'chat');
    const running = live.find(run => run.project === project.id) ?? null;
    const delivered = runs.find(run => run.project === project.id && run.delivery === 'merged') ?? null;
    const manifest = project.manifest ?? {};
    const ideation = manifest.ideation?.enabled === true ? manifest.ideation : null;
    const lastIdeas = own.find(job => job.kind === 'ideation' && job.state !== 'canceled');
    const cooldownEnds = ideation && lastIdeas ? Number(lastIdeas.createdAt) + ideation.minimumIntervalHours * 3_600_000 : null;
    const held = own.filter(job => ['blocked', 'failed'].includes(job.state));
    return { project: project.id, name: manifest.name ?? project.id, inbox: manifest.tracker?.ownerInboxIssue ?? manifest.ownerInboxIssue ?? null, workerId: project.workerId, seenAt: project.seenAt,
      scm: manifest.scm?.kind ?? null, tracker: manifest.tracker?.kind ?? null, engine: manifest.engine?.default ?? null, launcher: manifest.worker?.launcher ?? 'local', autonomy: manifest.pm?.autonomy ?? null,
      team: manifest.team?.blueprint ?? 'default', environment: manifest.worker?.environment ?? 'standard',
      costs: costs[project.id], decisions: decisions.filter(decision => decision.projectId === project.id).length,
      online: project.seenAt ? time - project.seenAt < 180_000 : false,
      status: held.length ? 'on hold' : running ? 'running' : own.some(job => job.state === 'queued') ? 'queued' : 'idle',
      running: running ? { jobId: running.jobId, issue: running.issue, ideation: running.ideation, startedAt: running.startedAt } : null,
      queued: own.filter(job => job.state === 'queued').map(job => ({ id: job.id, issue: job.issue, kind: job.kind, createdAt: job.createdAt })),
      held: held.map(job => ({ id: job.id, issue: job.issue, kind: job.kind, summary: job.summary })),
      delivered: delivered ? { issue: delivered.issue, prUrl: delivered.prUrl, finishedAt: delivered.finishedAt } : null, runs: runs.filter(run => run.project === project.id).length,
      ideation: ideation ? { batchSize: ideation.batchSize, backlogCap: ideation.backlogCap, cooldownEnds, blockedBy: held.length ? 'held job' : own.some(job => ACTIVE.includes(job.state)) ? 'active job' : cooldownEnds && cooldownEnds > time ? 'cooldown' : null } : null };
  });
  return { generatedAt: new Date(time).toISOString(), overview, team, jobs, runs, live, usage, tokens, quarantined, decisions };
}

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = iso => iso ? new Date(iso).toISOString().replace('T', ' ').slice(0, 16) : '';
const clock = iso => iso ? new Date(iso).toISOString().slice(11, 16) : '';
const pct = value => typeof value === 'number' ? Math.round(value * 100) : null;
const minutes = (from, to) => from ? Math.max(0, Math.round((new Date(to ?? Date.now()) - new Date(from)) / 60000)) : null;
const ago = ms => ms === null || ms === undefined ? 'never' : ms < 90_000 ? `${Math.round(ms / 1000)} s ago` : ms < 5_400_000 ? `${Math.round(ms / 60000)} min ago` : `${Math.round(ms / 3_600_000)} h ago`;
const compact = n => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
const short = url => escape(linkText(url));
const usd = value => typeof value === 'number' ? `$${value.toFixed(2)}` : '—';
const STYLE = `:root{--bg:#10161d;--panel:#161e27;--panel-2:#1c2632;--line:#27333f;--text:#dde4ea;--muted:#8a98a6;--dim:#5c6975;--run:#e5a53a;--ok:#4cc38a;--bad:#f0616a;--wait:#79b8ff;--sans:system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace}
*{box-sizing:border-box;min-width:0}html{color-scheme:dark}body{margin:0;background:var(--bg);color:var(--text);font:13.5px/1.45 var(--sans);padding:14px clamp(12px,2.5vw,28px) 40px;overflow-wrap:anywhere}
a{color:var(--wait);text-decoration:none}a:hover{text-decoration:underline}:focus-visible{outline:2px solid var(--run);outline-offset:2px}
header{display:grid;grid-template-columns:auto 1fr auto;gap:12px 28px;align-items:center;padding-bottom:12px;border-bottom:1px solid var(--line)}
h1{font:600 18px/1 var(--sans);margin:0;letter-spacing:-.01em}h1 span{color:var(--muted);font-weight:400}
.units{display:flex;flex-wrap:wrap;gap:6px 18px;font:12px var(--mono);color:var(--muted);padding:10px 0 0}.units span{display:inline-flex;align-items:center;gap:7px}
.dot{width:7px;height:7px;border-radius:50%;background:var(--dim)}.dot.on{background:var(--ok)}.dot.off{background:var(--bad)}
.usage{display:flex;gap:22px;flex-wrap:wrap}.g{min-width:150px}.g .l{display:flex;justify-content:space-between;gap:10px;font:11.5px var(--mono);color:var(--muted)}.g .l b{color:var(--text);font-weight:500}
.g .bar{height:4px;background:var(--line);margin:5px 0 3px;position:relative}.g .bar i{position:absolute;inset:0 auto 0 0;background:var(--wait)}.g .bar i.hot{background:var(--run)}.g .bar i.full{background:var(--bad)}.g .n{font:11px var(--mono);color:var(--dim)}
.meta{font:11.5px var(--mono);color:var(--dim);text-align:right}@media(max-width:900px){header{grid-template-columns:1fr 1fr}.meta{grid-column:1/-1;text-align:left}}
.flash{margin:12px 0 0;padding:8px 12px;border-left:3px solid var(--wait);background:var(--panel);font-size:13px}.flash.err{border-color:var(--bad)}
.team{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin:14px 0 0}.member{background:var(--panel);border:1px solid var(--line);padding:8px 10px;font-size:12px;color:var(--muted);display:flex;gap:10px;align-items:center}.member.busy{border-color:#6b5a2c}
.av{border-radius:50%;object-fit:cover;flex:none;vertical-align:-3px;margin-right:5px;background:var(--panel-2)}.member .av{margin:0;width:44px;height:44px}.member .name{display:block;color:var(--text);font-size:13px;font-weight:600}.member .name:hover{text-decoration:underline}.member>a{display:flex;flex:none}.member small{display:block;font:11px var(--mono);color:var(--dim);margin-bottom:4px}.member.busy span{color:var(--run)}
.projects{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px;margin:14px 0}
.card{background:var(--panel);border:1px solid var(--line);padding:10px 12px}.card.hold{border-color:#5a2b2f}.card .top{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px}.card .top b{font:600 13.5px var(--sans)}
.card p{margin:2px 0;color:var(--muted);font-size:12.5px}.card p.n{font:11.5px var(--mono);color:var(--dim)}.card form{margin-top:8px;display:flex;gap:6px 10px;flex-wrap:wrap;align-items:center}.why{font:11.5px var(--mono);color:var(--dim)}
button{font:12px var(--mono);color:var(--text);background:var(--panel-2);border:1px solid var(--line);padding:5px 10px;cursor:pointer;border-radius:3px}button:hover{border-color:var(--muted)}button[disabled]{opacity:.45;cursor:default}
.cols{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,2fr);gap:16px;align-items:start}.cols.even{grid-template-columns:1fr 1fr}@media(max-width:900px){.cols,.cols.even{grid-template-columns:1fr}}
h2{font:600 12px/1 var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:16px 0 8px;display:flex;gap:10px;align-items:baseline}h2 small{font-weight:400;text-transform:none;letter-spacing:0;color:var(--dim)}
.now{background:var(--panel);border:1px solid var(--line);padding:10px 12px}.now+.now{margin-top:10px}.now h3{margin:0;font:600 15px var(--sans);display:flex;align-items:center;gap:9px}.now h3 a{color:inherit}
.now .sub{font:11.5px var(--mono);color:var(--muted);margin:4px 0 8px;display:flex;flex-wrap:wrap;gap:4px 14px}
.pulse{width:9px;height:9px;border-radius:50%;background:var(--run);animation:breathe 2.2s ease-in-out infinite;flex:none;display:inline-block}@keyframes breathe{0%,100%{box-shadow:0 0 0 0 rgba(229,165,58,.5)}50%{box-shadow:0 0 0 7px rgba(229,165,58,0)}}
@media(prefers-reduced-motion:reduce){.pulse{animation:none}.ticker,.chat{scroll-behavior:auto}}
.ticker{font:12px/1.5 var(--mono);border-top:1px solid var(--line);padding-top:8px;max-height:380px;overflow-y:auto;scroll-behavior:smooth}.ticker.full{max-height:none}.ticker div{display:grid;grid-template-columns:28px minmax(0,1fr);gap:8px;padding:1px 0}.ticker i{font-style:normal;color:var(--dim);text-align:right}
.ticker .t{color:var(--text)}.ticker .agent{color:var(--muted)}.ticker .agent::before{content:'↳ '}.ticker b{color:var(--text);font-weight:500}.ticker .say{color:var(--wait);font-family:var(--sans);font-size:13px}.ticker .res{color:var(--dim)}.ticker .res::before{content:'← '}
.empty{color:var(--muted);font-size:13px;padding:8px 0}
.list{border-top:1px solid var(--line)}.row{display:grid;grid-template-columns:40px minmax(90px,130px) minmax(0,1fr) auto;gap:4px 12px;padding:7px 0;border-bottom:1px solid var(--line);align-items:baseline}
.row .at{font:11.5px var(--mono);color:var(--dim)}.row .who{font:12.5px var(--mono)}.row .who small{display:block;color:var(--dim);font-size:11px}.row .what{font-size:12.5px;color:var(--muted)}.row .what b{color:var(--text);font-weight:500}.row .what ul{margin:4px 0 0;padding-left:16px}
.st{font:10.5px/1 var(--mono);letter-spacing:.05em;text-transform:uppercase;padding:4px 7px;border:1px solid currentColor;border-radius:2px;white-space:nowrap;color:var(--dim)}
.st.ready,.st.completed,.st.merged{color:var(--ok)}.st.running{color:var(--run)}.st.queued{color:var(--wait)}.st.blocked,.st.failed,.st.on\\ hold{color:var(--bad)}
.up{background:var(--panel);border:1px solid var(--line);padding:8px 12px}.up .item{display:grid;grid-template-columns:24px minmax(0,1fr);gap:8px;padding:5px 0;border-bottom:1px solid var(--line);font-size:12.5px}.up .item:last-child{border:0}.up i{font-style:normal;color:var(--dim);font:11.5px var(--mono);text-align:right}.up small{display:block;color:var(--dim);font:11px var(--mono)}
pre{background:var(--panel);border:1px solid var(--line);padding:12px;overflow:auto;font:12px/1.5 var(--mono);white-space:pre-wrap;color:var(--muted)}
.crumb{font:12px var(--mono);margin-bottom:12px}
.mh{grid-template-columns:auto 1fr;align-items:start}.mh .av{width:96px;height:96px;margin:0}.voice{margin:6px 0;color:var(--muted);max-width:70ch}.mh p.n{font:11.5px var(--mono);color:var(--dim);margin:0}
.chat{background:var(--panel);border:1px solid var(--line);padding:10px 12px;max-height:480px;overflow-y:auto;scroll-behavior:smooth}.msg{display:flex;gap:8px;padding:8px 0;border-bottom:1px solid var(--line);font-size:13px;white-space:pre-wrap}.msg:last-child{border:0}.msg .who{font:11.5px var(--mono);color:var(--dim);margin-bottom:2px;white-space:normal}.msg.owner .who{color:var(--wait)}.msg.failed,.msg.blocked{color:var(--bad)}.msg .av{margin-top:2px}
.talk{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:12px}.talk select{background:var(--panel-2);color:var(--text);border:1px solid var(--line);padding:5px;font:12px var(--mono);border-radius:3px}
.compose{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}.compose textarea,.compose select,.compose input{grid-column:1/-1;background:var(--panel-2);color:var(--text);border:1px solid var(--line);padding:8px;font:13px var(--sans);border-radius:3px}.compose select,.compose input{grid-column:auto}.compose button{grid-column:1/-1;justify-self:end}
.settings fieldset{border:1px solid var(--line);border-radius:4px;padding:10px 14px;margin:14px 0;display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px 18px}.settings legend{color:var(--muted);text-transform:uppercase;font-size:11px;letter-spacing:.08em;padding:0 6px}.settings legend small{text-transform:none;letter-spacing:0;margin-left:6px}
.settings .field.wide{grid-column:1/-1}.settings textarea{width:100%;box-sizing:border-box;font:12px var(--mono,monospace)}label.inline{display:inline-flex;gap:4px;align-items:center;margin-right:8px;text-transform:none;letter-spacing:0}form.inline{display:inline}
.field{display:flex;flex-direction:column;gap:4px}.field label{font-size:12px;color:var(--muted)}.field input[type=text],.field input[type=number],.field select{background:var(--panel-2);color:var(--text);border:1px solid var(--line);padding:7px;font:13px var(--sans);border-radius:3px}.field small{color:var(--dim);font-size:11px}.field input[type=checkbox]{width:16px;height:16px;align-self:start}
.roles{border:0;padding:0;margin:0;display:flex;flex-wrap:wrap;gap:6px 12px}.roles label{font-size:12px;display:inline-flex;gap:4px;align-items:center}.sr{position:absolute;left:-9999px}
.actions{display:flex;gap:10px;justify-content:flex-end;margin-top:8px}.actions .secondary{background:transparent;color:var(--muted);border:1px solid var(--line)}
.st.act{background:var(--run);color:#1a1200;font-size:10px;padding:1px 5px;border-radius:3px}`;
const avatar = (role, size = 20) => Object.hasOwn(ROSTER, role) ? `<img class="av" src="/portraits/${role}.webp" width="${size}" height="${size}" alt="">` : '';
const tag = value => `<span class="st ${escape(value)}">${escape(value)}</span>`;
const ticker = (steps, id, full = false) => steps.length
  ? `<div class="ticker ${full ? 'full' : ''}" data-ticker="${escape(id)}">${steps.map((step, index) => `<div><i>${index + 1}</i><span class="${step.kind === 'text' ? 'say' : step.scope === 'subagent' ? 'agent' : 't'}">${step.member ? `${avatar(step.member, 16)}<b>${escape(ROSTER[step.member]?.name ?? step.member)}</b> ` : ''}${escape(step.text)}</span></div>`).join('')}</div>`
  : '<p class="empty">Started; waiting for the first reported step.</p>';
const gauge = (name, value, note, kind = 'pct') => `<div class="g"><div class="l"><span>${escape(name)}</span><b>${value === null ? 'no data' : kind === 'pct' ? `${value}% used` : escape(value)}</b></div><div class="bar"><i class="${kind === 'pct' && value >= 95 ? 'full' : kind === 'pct' && value >= 75 ? 'hot' : ''}" style="width:${kind === 'pct' ? (value ?? 0) : 0}%"></i></div><div class="n">${escape(note)}</div></div>`;
const SCRIPT = `(function(){var near={};var all=function(){return document.querySelectorAll('[data-ticker]')};
all().forEach(function(t){t.scrollTop=t.scrollHeight});
function refresh(){if(document.hidden)return;all().forEach(function(t){near[t.dataset.ticker]=t.scrollHeight-t.scrollTop-t.clientHeight<48});
fetch(location.pathname+location.search.replace(/[?&](ok|error)=[^&]*/g,''),{cache:'no-store'}).then(function(r){return r.text()}).then(function(html){var doc=new DOMParser().parseFromString(html,'text/html');var next=doc.querySelector('main'),cur=document.querySelector('main');if(!next||!cur)return;
var keep={};all().forEach(function(t){keep[t.dataset.ticker]=t.scrollTop});cur.replaceWith(next);
all().forEach(function(t){var id=t.dataset.ticker;if(near[id]===false&&keep[id]!==undefined)t.scrollTop=keep[id];else t.scrollTo({top:t.scrollHeight,behavior:'smooth'})});
['.meta','.usage','.units'].forEach(function(sel){var m=doc.querySelector(sel),c=document.querySelector(sel);if(m&&c)c.innerHTML=m.innerHTML});}).catch(function(){})}
setInterval(refresh,REFRESH);})();`;
const page = (title, body, refreshMs) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>${STYLE}</style></head><body>${body}${refreshMs ? `<script>${SCRIPT.replace('REFRESH', String(refreshMs))}</script>` : ''}</body></html>`;

export function renderIndex(state, flash = null, hostname = 'local') {
  const units = state.overview.map(p => `<span><i class="dot ${p.online ? 'on' : 'off'}"></i>${escape(p.workerId ?? (p.launcher !== 'local' ? `${p.launcher} on demand` : 'no worker'))} for ${escape(p.name)} · seen ${escape(ago(p.seenAt ? Date.now() - p.seenAt : null))}</span>`).join('') || '<span><i class="dot"></i>no workers registered yet</span>';
  const window = state.usage; const label = window?.engine ? `${window.engine} ` : '';
  const usage = `<div class="usage">${gauge(`${label}5h`, pct(window?.fiveHour?.utilization), window?.fiveHour?.resetsAt ? `resets ${clock(window.fiveHour.resetsAt * 1000)} UTC` : 'subscription window from the last run')}${gauge(`${label}7d`, pct(window?.sevenDay?.utilization), window?.sevenDay?.resetsAt ? `resets ${clock(window.sevenDay.resetsAt * 1000)} UTC` : '')}${gauge('Tokens 24h', state.tokens.week ? compact(state.tokens.day) : null, state.tokens.engines.length ? `${state.tokens.engines.join(', ')} report tokens, not plan limits` : 'no token-counting runs', 'raw')}${gauge('Tokens 7d', state.tokens.week ? compact(state.tokens.week) : null, state.tokens.lastRun ? `last run ${compact(state.tokens.lastRun.tokens)} tokens` : 'no runs this week', 'raw')}</div>`;
  const cards = state.overview.map(p => {
    const why = { 'held job': 'release the held job first', 'active job': 'available when the current job finishes' };
    const hold = p.ideation?.blockedBy && p.ideation.blockedBy !== 'cooldown' ? p.ideation.blockedBy : null;
    const ideas = p.ideation ? (hold ? `<button disabled>Propose ideas</button><span class="why">${escape(why[hold] ?? hold)}</span>` : `<button type="submit" name="action" value="ideate">Propose ${p.ideation.batchSize} ideas</button>${p.ideation.blockedBy === 'cooldown' ? `<span class="why">automatic refill waits until ${escape(when(p.ideation.cooldownEnds))} UTC</span>` : ''}`) : '';
    const release = p.held.length ? `<button type="submit" name="action" value="requeue" title="Rerun the held job after you have inspected it">Release and rerun</button>` : '';
    return `<div class="card ${p.status === 'on hold' ? 'hold' : ''}"><div class="top"><b>${escape(p.name)}</b>${tag(p.status)}</div>
<p>${p.running ? `${p.running.issue ? 'Building' : 'Running'} <a href="/runs/${escape(p.running.jobId)}">${escape(p.running.issue ?? (p.running.ideation ? 'ideation' : 'unpinned cycle'))}</a> · ${minutes(p.running.startedAt)} min` : p.status === 'on hold' ? `${p.held.length} job${p.held.length === 1 ? '' : 's'} on hold: ${escape(p.held[0].summary || p.held[0].issue || 'inspect the run')}` : p.queued.length ? `${p.queued.length} queued: ${escape(p.queued.map(job => job.issue ?? 'ideas').join(', '))}` : p.online ? 'Idle, waiting for approved work' : 'No worker online; queued work waits'}</p>
<p class="n"><a href="/projects/${escape(p.project)}">Talk to ${escape(ROSTER[PM].name)}</a> · <a href="/projects/${escape(p.project)}/memory">memory</a>${p.decisions ? ` · <a href="/projects/${escape(p.project)}#decisions">${p.decisions} decision${p.decisions === 1 ? '' : 's'} waiting</a>` : ''} · ${p.delivered ? `shipped ${escape(p.delivered.issue ?? 'run')} ${p.delivered.prUrl ? `<a href="${escape(p.delivered.prUrl)}">${short(p.delivered.prUrl)}</a>` : ''} ${escape(when(p.delivered.finishedAt))}` : 'nothing shipped yet'} · ${p.runs} runs</p>
<p class="n">${escape([p.scm, p.tracker, p.engine, p.launcher !== 'local' ? `${p.launcher} workers` : null, p.team !== 'default' ? `team ${p.team}` : null, p.environment !== 'standard' ? `${p.environment} environment` : null].filter(Boolean).join(' · '))}${p.costs ? ` · spend ${escape(usd(p.costs.day?.usd))} today, ${escape(usd(p.costs.week?.usd))} 7d` : ''}${p.autonomy ? ` · PM ${escape(p.autonomy)}` : ''}</p>
${ideas || release ? `<form method="post" action="/actions"><input type="hidden" name="project" value="${escape(p.project)}">${p.held[0] ? `<input type="hidden" name="job" value="${escape(p.held[0].id)}">` : ''}${ideas}${release}</form>` : ''}</div>`;
  }).join('') || '<p class="empty">No projects registered. Start a worker with a mapped checkout and it registers its manifest here.</p>';
  const now = state.live.length ? state.live.map(run => `<div class="now"><h3><span class="pulse"></span><a href="/runs/${escape(run.jobId)}">${escape(run.issue ?? (run.ideation ? 'Proposing ideas' : 'Unpinned cycle'))}</a></h3>
<div class="sub"><span>${escape(run.project)}</span><span>${escape(run.engine)}</span><span>started ${escape(clock(run.startedAt))} UTC · ${minutes(run.startedAt)} min</span><span>reported ${escape(ago(Date.now() - run.updatedAt))}</span></div>${ticker(run.steps, run.jobId)}</div>${streamScript(run.jobId, run.jobId)}`).join('')
    : '<div class="now"><p class="empty">Nothing running. The team is idle until a card is approved or a job is queued.</p></div>';
  const upcoming = [];
  for (const p of state.overview) {
    for (const job of p.queued) upcoming.push({ at: Number(job.createdAt), text: `${job.issue ? `Build ${job.issue}` : 'Propose ideas'} · ${p.name}`, note: p.online ? 'queued, starts when the worker is free' : 'queued, waits for a worker to come online' });
    if (p.ideation && !p.held.length) {
      const busy = p.running || p.queued.length; const later = p.ideation.cooldownEnds && p.ideation.cooldownEnds > Date.now();
      upcoming.push({ at: Math.max(p.ideation.cooldownEnds ?? 0, busy ? Date.now() + 1 : 0), text: `Propose up to ${p.ideation.batchSize} ideas · ${p.name}`,
        note: `${later ? `from ${when(p.ideation.cooldownEnds)} UTC` : busy ? 'after the current work' : 'on the next intake poll'}, if fewer than ${p.ideation.backlogCap} ideas are open` });
    }
  }
  upcoming.sort((a, b) => a.at - b.at);
  const upcomingHtml = upcoming.length ? upcoming.map((item, index) => `<div class="item"><i>${index + 1}</i><span>${escape(item.text)}<small>${escape(item.note)}</small></span></div>`).join('') : '<p class="empty">Nothing scheduled. Approving an idea in the tracker queues a build within a minute.</p>';
  const jobs = state.jobs.filter(job => job.kind !== 'chat').map(job => `<div class="row"><span class="at">${escape(clock(job.createdAt))}</span><span class="who">${escape(job.issue ?? (job.kind === 'ideation' ? 'ideas' : 'cycle'))}<small>${escape(job.projectId)} · ${escape(job.engine ?? 'worker default')}${job.autoMerge ? ' · auto-merge' : job.publish ? ' · publish' : ''}</small></span><span class="what">${escape(job.summary) || (job.state === 'queued' ? 'Waiting for a worker.' : job.state === 'running' ? 'In progress.' : '')}</span>${tag(job.state)}</div>`).join('');
  const runs = state.runs.map(run => `<div class="row"><span class="at">${escape(clock(run.startedAt))}</span><span class="who"><a href="/runs/${escape(run.jobId)}">${escape(run.issue ?? (run.ideation || run.proposals ? 'ideas' : 'cycle'))}</a><small>${escape(run.project)} · ${escape(run.engine)} · ${minutes(run.startedAt, run.finishedAt) ?? '?'} min</small></span><span class="what">${run.delivery ? `<b>${escape(run.delivery)}</b> · ` : ''}${run.prUrl ? `<a href="${escape(run.prUrl)}">${short(run.prUrl)}</a> · ` : ''}${escape(run.summary)}${run.proposals?.length ? `<ul>${run.proposals.map(title => `<li>${escape(title)}</li>`).join('')}</ul>` : ''}</span>${tag(run.state)}</div>`).join('');
  const inbox = state.decisions.length ? `<section><h2>Decisions <small>${state.decisions.length} waiting for you</small></h2><div class="up">${state.decisions.slice(0, 8).map(d => `<div class="item"><i>!</i><span><a href="/projects/${escape(d.projectId)}#decisions">${escape(d.title)}</a><small>${escape(d.projectId)} · ${escape(d.kind)} · ${escape(when(new Date(d.createdAt).toISOString()))}</small></span></div>`).join('')}</div></section>` : '';
  const body = `<header><h1>Agent team <span>${escape(hostname)}</span></h1>${usage}<div class="meta">${escape(when(state.generatedAt))} UTC · live · <a href="/teams">Teams</a> · <a href="/environments">Environments</a> · <a href="/api/state">JSON</a></div></header>
<div class="units">${units}</div>
<main>${flash ? `<div class="flash ${flash.error ? 'err' : ''}">${escape(flash.text)}</div>` : ''}${inbox}
<div class="team">${state.team.map(m => `<div class="member ${m.working ? 'busy' : ''}"><a href="/team/${escape(m.role)}">${avatar(m.role, 44)}</a><div><a class="name" href="/team/${escape(m.role)}">${escape(m.name)}</a><small>${escape(m.title)}</small><span>${m.working ? `on <a href="/runs/${escape(m.working.jobId)}">${escape(m.working.issue)}</a>${m.steps ? ` · ${m.steps} steps` : ''}` : 'idle'}</span></div></div>`).join('')}</div>
<div class="projects">${cards}</div>
<div class="cols"><section><h2>Now</h2>${now}</section><section><h2>Upcoming <small>automatic runs in order</small></h2><div class="up">${upcomingHtml}</div></section></div>
<div class="cols even"><section><h2>Queue <small>jobs asked of the coordinator · ${state.jobs.filter(job => job.kind !== 'chat' && ['queued', 'running'].includes(job.state)).length || 'none'} active</small></h2><div class="list">${jobs || '<p class="empty">No jobs yet.</p>'}</div></section>
<section><h2>Runs <small>what workers actually executed · latest ${state.runs.length}</small></h2><div class="list">${runs || '<p class="empty">No runs reported yet.</p>'}</div></section></div></main>`;
  return page('Agent team', body, 10_000);
}

export function renderRun(detail, extras = {}) {
  const { run } = detail;
  const injection = extras.injection ? `<section><h2>Injected memory <small>at ${escape(extras.injection.sha.slice(0, 8))} · ${extras.injection.tokens} tokens</small></h2><div class="up">${extras.injection.itemIds.length ? extras.injection.itemIds.map((id, index) => `<div class="item"><i>${index + 1}</i><span><a href="/projects/${escape(run.project)}/memory/file?path=items/${escape(id)}.md&sha=${escape(extras.injection.sha)}">${escape(id)}</a></span></div>`).join('') : '<p class="empty">Only the charter was injected.</p>'}</div></section>` : '';
  const artifacts = extras.artifacts?.links ? `<section><h2>Archived artifacts <small>${escape(extras.artifacts.kind)} · ${escape(extras.artifacts.location ?? '')}</small></h2><div class="up">${Object.entries(extras.artifacts.links).map(([name, link], index) => `<div class="item"><i>${index + 1}</i><span><a href="${escape(link)}">${escape(name)}</a></span></div>`).join('')}</div></section>` : '';
  const proposals = extras.proposals?.length ? `<section><h2>Learnings proposed <small>${extras.proposals.length}</small></h2><div class="up">${extras.proposals.map((p, index) => `<div class="item"><i>${index + 1}</i><span>${escape(p.item.title)} <span class="st ${escape(p.state)}">${escape(p.state)}</span><small>${escape(p.item.type)}${p.item.scope?.length ? ` · ${escape(p.item.scope.join(', '))}` : ''}</small></span></div>`).join('')}</div></section>` : '';
  const result = detail.engineResult ? `${escape(detail.engineResult.subtype ?? '')}${detail.engineResult.isError ? ' (error)' : ''} · ${escape(detail.engineResult.turns ?? '?')} turns · ${Math.round((detail.engineResult.durationMs ?? 0) / 60000)} min of model time` : detail.tokens ? `${compact(detail.tokens)} tokens` : '';
  const body = `<div class="crumb"><a href="/">← Agent team</a></div>
<header><h1>${run.state === 'running' ? '<span class="pulse"></span> ' : ''}${escape(run.issue ?? (run.ideation ? 'Proposing ideas' : 'Unpinned cycle'))} <span>${escape(run.project)}</span></h1>
<div class="usage">${detail.usage ? gauge('Engine 5h', pct(detail.usage.fiveHour?.utilization), 'at the time of this run') + gauge('Engine 7d', pct(detail.usage.sevenDay?.utilization), '') : ''}</div><div class="meta">${tag(run.state)}${run.delivery ? ` ${tag(run.delivery)}` : ''}</div></header>
<div class="units"><span>${escape(run.engine)}${run.billing ? ` (${escape(run.billing)})` : ''}</span><span>base ${escape(run.baseCommit ?? '')}</span><span>${escape(when(run.startedAt))} → ${escape(run.finishedAt ? clock(run.finishedAt) : 'running')} UTC · ${minutes(run.startedAt, run.finishedAt) ?? '?'} min</span>${run.prUrl ? `<span><a href="${escape(run.prUrl)}">${short(run.prUrl)}</a></span>` : ''}${result ? `<span>${result}</span>` : ''}<span>${escape(run.id)}</span><span>reported ${escape(ago(Date.now() - detail.updatedAt))}</span></div>
<main><section><h2>Steps <small>${detail.steps.length} shown</small></h2><div class="now">${ticker(detail.steps, detail.jobId, true)}</div></section>
<section><h2>Summary</h2><pre>${escape(detail.summary || 'Not written yet.')}</pre></section>
${injection}${proposals}${artifacts}
${detail.stderr?.trim() ? `<section><h2>Errors and warnings</h2><pre>${escape(detail.stderr)}</pre></section>` : ''}</main>`;
  return page(`${run.issue ?? 'run'} · ${run.id}`, body + (run.state === 'running' ? streamScript(detail.jobId, detail.jobId) : ''), run.state === 'running' ? 10_000 : 0);
}

// Appends streamed steps to a ticker without waiting for the next full refresh.
const streamScript = (jobId, tickerId, mode = 'steps') => `<script>(function(){var t=document.querySelector('[data-ticker="${escape(tickerId)}"]');if(!t||!window.EventSource)return;
var seen=t.querySelectorAll('div').length;var es=new EventSource('/runs/${escape(jobId)}/stream');var esc=function(s){return String(s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})};
es.addEventListener('steps',function(e){var d=JSON.parse(e.data);var near=t.scrollHeight-t.scrollTop-t.clientHeight<48;d.steps.forEach(function(s){
 if('${mode}'==='chat'){if(s.kind!=='delta')return;var last=t.querySelector('.msg.member.running div:last-child');if(last)last.textContent+=s.text;return;}
 seen++;var row=document.createElement('div');row.innerHTML='<i>'+seen+'</i><span class="'+(s.kind==='text'?'say':s.kind==='result'?'res':s.scope==='subagent'?'agent':'t')+'">'+(s.member?'<b>'+esc(s.member)+'</b> ':'')+esc(s.text)+'</span>';t.appendChild(row);});
 if(near)t.scrollTo({top:t.scrollHeight,behavior:'smooth'})});
es.addEventListener('done',function(){es.close()});})();</script>`;

export function renderMember({ role, state, activity, selected, thread, flash }) {
  const member = ROSTER[role];
  const working = state.team.find(m => m.role === role)?.working ?? null;
  const options = state.overview.map(p => `<option value="${escape(p.project)}" ${p.project === selected.project ? 'selected' : ''}>${escape(p.name)}</option>`).join('');
  const label = { queued: 'queued for a worker', running: 'thinking', blocked: 'failed', failed: 'failed', canceled: 'canceled' };
  const bubbles = thread.flatMap(job => [
    `<div class="msg owner"><div><div class="who">You <span>${escape(when(new Date(job.createdAt).toISOString()))}</span>${['queued', 'running'].includes(job.state) ? ` · ${label[job.state]}${job.state === 'running' ? ' <span class="pulse"></span>' : ''}` : ''}</div>${escape(job.message)}</div></div>`,
    job.state === 'completed' || ['blocked', 'failed'].includes(job.state) ? `<div class="msg member ${job.state}">${avatar(role, 22)}<div><div class="who">${escape(member.name)} <span>${escape(when(new Date(job.updatedAt).toISOString()))}</span>${job.state !== 'completed' ? ` · ${label[job.state]}` : ''}</div>${escape(job.summary)}</div></div>`
      : job.state === 'running' ? `<div class="msg member running">${avatar(role, 22)}<div><div class="who">${escape(member.name)} <span class="pulse"></span> writing</div><div></div></div></div>` : '']);
  const running = thread.find(job => job.state === 'running');
  const body = `<div class="crumb"><a href="/">← Agent team</a></div>
<header class="mh">${avatar(role, 96)}<div><h1>${escape(member.name)} <span>${escape(member.title)}</span></h1><p class="voice">${escape(member.voice)}</p><p class="n">${working ? `Working on <a href="/runs/${escape(working.jobId)}">${escape(working.issue)}</a> in ${escape(working.project)}` : 'Idle right now'}</p></div></header>
<main><div class="cols"><section><h2>Conversation <small>${escape(selected.issue || 'choose a card')} · ${escape(state.overview.find(p => p.project === selected.project)?.name ?? selected.project ?? '')}</small></h2>
${flash ? `<div class="flash ${flash.error ? 'err' : ''}">${escape(flash.text)}</div>` : ''}
<div class="chat" data-ticker="chat">${bubbles.join('') || `<p class="empty">No messages yet. What you write is posted on ${escape(selected.issue || 'the card')} in the tracker by the project's worker; ${escape(member.name)} answers there and here.</p>`}</div>
${state.overview.length ? `<div class="talk"><button type="button" id="talk" data-name="${escape(member.name)}">Talk to ${escape(member.name)}</button><select id="talk-lang"><option value="en-US">English</option><option value="nb-NO">Norsk</option></select><span id="talk-state" class="why">hands-free: speak, pause to send, hear the reply</span></div>
<form method="post" action="/chat" class="compose" id="compose"><input type="hidden" name="role" value="${escape(role)}"><select name="project">${options}</select><input name="issue" value="${escape(selected.issue ?? '')}" pattern="[A-Z][A-Z0-9]*-[1-9][0-9]*" title="Tracker issue, e.g. the owner inbox" required><textarea name="message" rows="3" maxlength="4000" placeholder="Ask ${escape(member.name)} something, or give direction. It lands on the tracker card." required></textarea><button type="submit">Send to ${escape(member.name)}</button></form>` : '<p class="empty">No project is registered yet, so there is nowhere to send a message.</p>'}</section>
<section><h2>Recent work <small>${activity.length} runs</small></h2>${activity.map(item => `<div class="now"><h3><a href="/runs/${escape(item.jobId)}">${escape(item.issue ?? (item.ideation ? 'Proposing ideas' : 'cycle'))}</a> ${tag(item.state)}</h3><div class="sub"><span>${escape(item.project)}</span><span>${escape(when(item.startedAt))}</span><span>${item.count} steps</span>${item.prUrl ? `<span><a href="${escape(item.prUrl)}">${short(item.prUrl)}</a></span>` : ''}</div>${ticker(item.steps, item.jobId, true)}</div>`).join('') || '<p class="empty">No reported steps yet.</p>'}</section></div></main>`;
  return page(`${member.name} · ${member.title}`, body + (running ? streamScript(running.id, 'chat', 'chat') : '') + TALK_SCRIPT, 10_000);
}

// Hands-free voice in the browser: continuous speech recognition, send on a pause, stream the
// reply and read it aloud. Recognition pauses while speaking so the page does not hear itself.
const TALK_SCRIPT = `<script>(function(){var btn=document.getElementById('talk');if(!btn)return;var SR=window.SpeechRecognition||window.webkitSpeechRecognition;var state=document.getElementById('talk-state');var lang=document.getElementById('talk-lang');
try{lang.value=localStorage.getItem('talk-lang')||lang.value}catch(e){}lang.onchange=function(){try{localStorage.setItem('talk-lang',lang.value)}catch(e){}};
if(!SR||!window.speechSynthesis){btn.disabled=true;state.textContent='this browser has no speech recognition; Chrome, Edge or Safari do';return;}
var on=false,rec=null,pending='',timer=null,speaking=false,name=btn.dataset.name;
function say(t){state.textContent=t}
function speak(text,done){if(!text.trim()){done&&done();return}speaking=true;stop();var u=new SpeechSynthesisUtterance(text);u.lang=lang.value;var v=speechSynthesis.getVoices().find(function(x){return x.lang===lang.value})||speechSynthesis.getVoices().find(function(x){return x.lang.slice(0,2)===lang.value.slice(0,2)});if(v)u.voice=v;u.onend=function(){speaking=false;done&&done()};u.onerror=u.onend;speechSynthesis.speak(u)}
function stop(){if(rec){rec.onend=null;try{rec.stop()}catch(e){}rec=null}}
function listen(){if(!on||speaking)return;stop();rec=new SR();rec.lang=lang.value;rec.continuous=true;rec.interimResults=true;
rec.onresult=function(e){var finalText='';for(var i=e.resultIndex;i<e.results.length;i++){if(e.results[i].isFinal)finalText+=e.results[i][0].transcript;}
 if(finalText){pending+=(pending?' ':'')+finalText.trim();say('heard: '+pending);clearTimeout(timer);timer=setTimeout(send,1400)}};
rec.onerror=function(e){if(e.error==='not-allowed'){say('microphone access denied');on=false;btn.textContent='Talk to '+name}};
rec.onend=function(){if(on&&!speaking)setTimeout(listen,250)};
try{rec.start();say('listening…')}catch(e){}}
function send(){var text=pending.trim();pending='';if(!text)return;stop();say('sending…');
var form=document.getElementById('compose');var body=new URLSearchParams({role:form.role.value,project:form.project.value,issue:form.issue.value,message:text});
fetch('/chat',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',accept:'application/json'},body:body.toString()}).then(function(r){return r.json()}).then(function(d){
 if(d.error){speak(d.error,listen);return}var chat=document.querySelector('[data-ticker="chat"]');if(chat){var you=document.createElement('div');you.className='msg owner';you.innerHTML='<div><div class="who">You</div>'+esc(text)+'</div>';chat.appendChild(you);chat.scrollTop=chat.scrollHeight}
 if(!d.online){speak(name+' will answer when a worker is online.',listen);return}say(name+' is thinking…');follow(d.jobId)}).catch(function(){say('could not send');listen()})}
function follow(jobId){var es=new EventSource('/runs/'+jobId+'/stream');var buf='',full='',chat=document.querySelector('[data-ticker="chat"]'),bubble=null,queue=[],busy=false;
 function drain(){if(busy||!queue.length)return;busy=true;var next=queue.shift();speak(next,function(){busy=false;drain()})}
 es.addEventListener('steps',function(e){JSON.parse(e.data).steps.forEach(function(s){if(s.kind!=='delta')return;buf+=s.text;full+=s.text;
  if(!bubble&&chat){bubble=document.createElement('div');bubble.className='msg member';bubble.innerHTML='<div><div class="who">'+esc(name)+'</div><div></div></div>';chat.appendChild(bubble)}if(bubble){bubble.lastChild.lastChild.textContent=full;chat.scrollTop=chat.scrollHeight}
  var m=buf.match(/^[\s\S]*?[.!?](\s|$)/);if(m){queue.push(m[0]);buf=buf.slice(m[0].length);drain()}})});
 es.addEventListener('done',function(){es.close();if(buf.trim())queue.push(buf);buf='';if(!full)queue.push(name+' did not answer.');var wait=setInterval(function(){if(!busy&&!queue.length){clearInterval(wait);say('listening…');listen()}else drain()},300)});
 es.onerror=function(){es.close();listen()}}
function esc(v){return String(v).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
btn.onclick=function(){on=!on;btn.textContent=on?'Stop talking':'Talk to '+name;if(on){speechSynthesis.getVoices();listen()}else{stop();speechSynthesis.cancel();say('off')}};
})();</script>`;

// Landing page per project: the conversation with the resident PM, the decision inbox, a board
// mirror from the PM's last status line, spend, and links into memory.
export function renderProject({ project, state, thread, decisions, costs, flash, channel = [] }) {
  const pm = ROSTER[PM];
  const bubbles = thread.messages.slice(-60).map(message => {
    const owner = message.author === 'owner';
    const meta = message.meta?.actions?.length ? `<div class="who">${message.meta.actions.map(action => escape(action.type === 'error' ? `${action.action} failed: ${action.error}` : action.type === 'decision' ? `asked: ${action.title}` : action.type === 'enqueue' ? `queued ${action.issue}` : action.type === 'memory' ? `wrote ${action.ids?.length ?? 0} memory item(s)` : action.type === 'proposal' ? `${action.action}ed a learning` : action.type)).join(' · ')}</div>` : '';
    return `<div class="msg ${owner ? 'owner' : `member ${message.state}`}">${owner ? '' : avatar(PM, 22)}<div><div class="who">${owner ? 'You' : escape(pm.name)} <span>${escape(when(new Date(message.createdAt).toISOString()))}</span>${message.state === 'pending' ? ' · waiting for the PM' : message.state === 'streaming' ? ' · writing <span class="pulse"></span>' : message.state === 'failed' ? ' · failed' : ''}${message.meta?.event?.kind && message.meta.event.kind !== 'owner' ? ` · ${escape(message.meta.event.kind)}` : ''}</div>${escape(message.body)}${meta}</div></div>`;
  }).join('');
  const inbox = decisions.length ? decisions.map(d => `<div class="now" id="d-${escape(d.id)}"><h3>${escape(d.title)} <span class="st ${escape(d.kind)}">${escape(d.kind)}</span></h3><div class="sub"><span>${escape(when(new Date(d.createdAt).toISOString()))} UTC</span></div><pre>${escape(d.body)}</pre>
<form method="post" action="/projects/${escape(project.project)}/decision" class="compose"><input type="hidden" name="id" value="${escape(d.id)}"><input type="hidden" name="title" value="${escape(d.title)}"><select name="choice">${d.options.map(option => `<option value="${escape(option)}">${escape(option)}</option>`).join('')}</select><input name="note" placeholder="optional note for the PM" maxlength="4000"><button type="submit">Decide</button></form></div>`).join('')
    : '<p class="empty">Nothing waiting on you.</p>';
  const spend = costs ? `<div class="usage">${gauge('Spend today', usd(costs.day?.usd), `${costs.day?.entries ?? 0} entries`, 'raw')}${gauge('Spend 7d', usd(costs.week?.usd), `${compact(costs.week?.tokens ?? 0)} tokens`, 'raw')}${gauge('Spend 30d', usd(costs.month?.usd), '', 'raw')}</div>` : '';
  const feed = channel.slice(-40).map(post => `<div class="row" id="c-${post.seq}"><span class="at">${escape(clock(post.createdAt))}</span><span class="who">${post.author === 'owner' ? 'You' : `${avatar(post.author, 16)}${escape(ROSTER[post.author]?.name ?? post.author)}`}</span><span class="what">${post.kind !== 'note' ? `<b>${escape(post.kind)}</b> ` : ''}${escape(post.body)}</span></div>`).join('');
  const board = state.jobs.filter(job => job.projectId === project.project && job.kind !== 'chat').slice(0, 12).map(job => `<div class="row"><span class="at">${escape(clock(job.createdAt))}</span><span class="who">${escape(job.issue ?? job.kind)}</span><span class="what">${escape(job.summary) || (job.state === 'queued' ? 'Waiting for a worker.' : job.state === 'running' ? 'In progress.' : '')}</span>${tag(job.state)}</div>`).join('');
  const body = `<div class="crumb"><a href="/">← Agent team</a> · <a href="/projects/${escape(project.project)}/memory">Memory</a> · <a href="/projects/${escape(project.project)}/settings">Settings</a> · <a href="/team/${PM}?project=${escape(project.project)}">Tracker thread</a></div>
<header class="mh">${avatar(PM, 96)}<div><h1>${escape(project.name)} <span>with ${escape(pm.name)}, ${escape(pm.title)}</span></h1><p class="voice">${escape(pm.voice)}</p><p class="n">${escape([project.scm, project.tracker, project.engine, `PM autonomy ${project.autonomy ?? 'suggest'}`, project.status].filter(Boolean).join(' · '))}</p></div></header>
${spend}
<main>${flash ? `<div class="flash ${flash.error ? 'err' : ''}">${escape(flash.text)}</div>` : ''}
<div class="cols"><section><h2>Conversation</h2><div class="chat" data-ticker="pm">${bubbles || `<p class="empty">Say hello. ${escape(pm.name)} reads the board, the runs and project memory before answering.</p>`}</div>
<form method="post" action="/projects/${escape(project.project)}/message" class="compose"><textarea name="message" rows="3" maxlength="12000" placeholder="Ask what is going on, give direction, or decide something." required></textarea><button type="submit">Send to ${escape(pm.name)}</button></form></section>
<section><h2 id="decisions">Decisions <small>${decisions.length} open</small></h2>${inbox}
<h2 id="channel">Team channel <small>what active agents tell each other</small></h2><div class="list" data-ticker="channel">${feed || '<p class="empty">Quiet so far. Running agents post claims, blockers and hand-offs here; you can too.</p>'}</div>
<form method="post" action="/projects/${escape(project.project)}/channel" class="compose"><input name="body" maxlength="4000" placeholder="Tell every active agent something (read at each cycle start), or start with @Name to ask one member now." required><button type="submit">Post</button></form>
<h2>Board mirror <small>latest jobs</small></h2><div class="list">${board || '<p class="empty">No jobs yet.</p>'}</div></section></div></main>`;
  return page(`${project.name} · ${pm.name}`, body, 8_000);
}

// Stored teams: the personas one project runs with. Permissions are not editable here: the
// committed roles file is the ceiling and a team can only tighten it (the deny boxes).
export function renderTeams({ teams, flash }) {
  const rows = teams.map(team => `<div class="row"><span class="who"><a href="/teams/${escape(team.id)}">${escape(team.name)}</a><small>${escape(team.id)} · v${team.version}</small></span><span class="what">${escape(team.description || '')} <small>${escape(Object.keys(team.agents).join(', '))}</small></span></div>`).join('');
  const body = `<div class="crumb"><a href="/">← Agent team</a> · Teams</div>
<header><h1>Teams <span>stored personas</span></h1><div></div><div class="meta"><a href="/environments">Environments</a></div></header>
<main>${flash ? `<div class="flash ${flash.error ? 'err' : ''}">${escape(flash.text)}</div>` : ''}
<p class="n">A team is the set of roles, names, voices and prompts a project runs with; a project chooses one in its settings. Every change is a new version a run records. Permissions stay in the repository's roles file; a team can only add restrictions.</p>
<div class="list">${rows || '<p class="empty">No teams stored yet.</p>'}</div>
<h2>New team</h2><form method="get" action="/teams/new" class="compose" onsubmit="location.href='/teams/'+this.id.value.trim();return false"><input name="id" pattern="[a-z][a-z0-9-]{0,63}" placeholder="team id, lowercase and dashes" required><button type="submit">Create</button></form></main>`;
  return page('Teams', body, 0);
}

export function renderTeam({ team, id, history, flash }) {
  const doc = team ?? { id, name: id.replace(/-/g, ' '), description: '', roster: { ...DEFAULT_ROSTER }, defaultRoles: null, agents: {} };
  const roles = Object.keys(doc.agents).length ? Object.keys(doc.agents) : ['team-coordinator', 'team-pm', 'team-owner'];
  const roleBlock = role => {
    const agent = doc.agents[role] ?? { mode: ['team-coordinator', 'team-owner', 'team-ideation'].includes(role) ? 'primary' : 'subagent', description: role, prompt: '', deny: [] };
    const member = doc.roster[role] ?? DEFAULT_ROSTER[role] ?? { name: '', title: '', voice: '' };
    const locked = ['team-coordinator', 'team-pm', 'team-owner'].includes(role);
    return `<fieldset><legend>${escape(role)} <small>${escape(agent.mode)}</small>${locked ? '' : ` <label class="inline"><input type="checkbox" name="remove" value="${escape(role)}"> remove</label>`}</legend>
<input type="hidden" name="role" value="${escape(role)}"><input type="hidden" name="${escape(role)}.mode" value="${escape(agent.mode)}">
<div class="field"><label>Name</label><input name="${escape(role)}.name" maxlength="80" value="${escape(member.name)}" required></div>
<div class="field"><label>Title</label><input name="${escape(role)}.title" maxlength="80" value="${escape(member.title)}" required></div>
<div class="field"><label>Voice</label><input name="${escape(role)}.voice" maxlength="600" value="${escape(member.voice)}" required></div>
<div class="field"><label>Description</label><input name="${escape(role)}.description" maxlength="200" value="${escape(agent.description)}"></div>
<div class="field"><label>Steps</label><input name="${escape(role)}.steps" type="number" min="1" max="500" value="${escape(agent.steps ?? '')}"></div>
<div class="field"><label>Restrict further</label>${TIGHTENINGS.map(item => `<label class="inline"><input type="checkbox" name="${escape(role)}.deny" value="${item}"${agent.deny?.includes(item) ? ' checked' : ''}> no ${item}</label>`).join(' ')}</div>
<div class="field wide"><label>Prompt</label><textarea name="${escape(role)}.prompt" rows="8" maxlength="40000" required>${escape(agent.prompt)}</textarea></div></fieldset>`;
  };
  const subagents = roles.filter(role => (doc.agents[role]?.mode ?? 'subagent') === 'subagent');
  const defaults = doc.defaultRoles ?? subagents.filter(role => role !== 'team-pm');
  const versions = history.map(entry => `<div class="row"><span class="at">v${entry.version}</span><span class="who">${escape(entry.author)}<small>${escape(when(new Date(entry.createdAt).toISOString()))}</small></span><span class="what">${escape(entry.note ?? '')}</span>${entry.version !== team?.version ? `<form method="post" action="/teams/${escape(id)}" class="inline"><input type="hidden" name="action" value="revert"><input type="hidden" name="version" value="${entry.version}"><button type="submit" class="secondary">Revert</button></form>` : '<span class="st act">current</span>'}</div>`).join('');
  const body = `<div class="crumb"><a href="/">← Agent team</a> · <a href="/teams">Teams</a> · ${escape(id)}</div>
<header><h1>${escape(doc.name)} <span>${team ? `version ${team.version}` : 'new team'}</span></h1><div></div><div class="meta">${team?.updatedAt ? `saved ${escape(when(new Date(team.updatedAt).toISOString()))} UTC by ${escape(team.author)}` : ''}</div></header>
<main>${flash ? `<div class="flash ${flash.error ? 'err' : ''}">${escape(flash.text)}</div>` : ''}
<form method="post" action="/teams/${escape(id)}" class="settings">
<fieldset><legend>team</legend><div class="field"><label>Name</label><input name="name" maxlength="80" value="${escape(doc.name)}" required></div><div class="field"><label>Description</label><input name="description" maxlength="400" value="${escape(doc.description ?? '')}"></div>
<div class="field"><label>Default roles</label><fieldset class="roles">${subagents.map(role => `<label><input type="checkbox" name="defaultRoles" value="${escape(role)}"${defaults.includes(role) ? ' checked' : ''}> ${escape(role)}</label>`).join('')}</fieldset><small>Subagents the coordinator delegates to unless a project's settings choose otherwise.</small></div></fieldset>
${roles.map(roleBlock).join('')}
<fieldset><legend>add a subagent</legend><div class="field"><label>Role id</label><input name="newRole" pattern="team-[a-z]+" placeholder="team-analyst"></div><div class="field"><label>Name</label><input name="newName" maxlength="80"></div><div class="field"><label>Title</label><input name="newTitle" maxlength="80"></div><div class="field"><label>Voice</label><input name="newVoice" maxlength="600"></div><div class="field wide"><label>Prompt</label><textarea name="newPrompt" rows="5" maxlength="40000"></textarea></div></fieldset>
<div class="field"><label for="team-note">Change note</label><input id="team-note" name="note" type="text" maxlength="400" placeholder="Why this changes (kept in history)"></div>
<div class="actions"><button type="submit">Save team</button></div></form>
<h2>History <small>${history.length} versions</small></h2><div class="list">${versions || '<p class="empty">Not saved yet.</p>'}</div></main>`;
  return page(`Team · ${doc.name}`, body, 0);
}

// Builds a team document from the editor form: existing roles, minus removed ones, plus one new subagent.
export function teamFromForm(form, id) {
  const removed = new Set(form.getAll('remove'));
  const roles = form.getAll('role').filter(role => !removed.has(role));
  const roster = {}; const agents = {};
  for (const role of roles) {
    roster[role] = { name: form.get(`${role}.name`) ?? '', title: form.get(`${role}.title`) ?? '', voice: form.get(`${role}.voice`) ?? '' };
    const steps = (form.get(`${role}.steps`) ?? '').trim();
    agents[role] = { mode: form.get(`${role}.mode`) ?? 'subagent', description: form.get(`${role}.description`) || role, prompt: (form.get(`${role}.prompt`) ?? '').replace(/\r\n/g, '\n'), ...(steps ? { steps: Number(steps) } : {}), deny: form.getAll(`${role}.deny`) };
  }
  const added = (form.get('newRole') ?? '').trim();
  if (added) {
    roster[added] = { name: form.get('newName') ?? '', title: form.get('newTitle') ?? '', voice: form.get('newVoice') ?? '' };
    agents[added] = { mode: 'subagent', description: form.get('newTitle') || added, prompt: (form.get('newPrompt') ?? '').replace(/\r\n/g, '\n'), deny: [] };
  }
  const defaultRoles = form.getAll('defaultRoles').filter(role => agents[role]?.mode === 'subagent');
  return { id, name: form.get('name') ?? id, description: form.get('description') ?? '', roster, defaultRoles: defaultRoles.length ? defaultRoles : null, agents };
}

// Stored worker environments: what a machine offers a run. Capabilities are a fixed catalog.
export function renderEnvironments({ environments, flash }) {
  const rows = environments.map(item => `<div class="row"><span class="who"><a href="/environments/${escape(item.id)}">${escape(item.name)}</a><small>${escape(item.id)} · v${item.version}</small></span><span class="what">${escape(item.description || '')} <small>${escape(item.capabilities.map(capability => CAPABILITIES[capability]?.title ?? capability).join(', ') || 'no extra tools')}</small></span></div>`).join('');
  const body = `<div class="crumb"><a href="/">← Agent team</a> · Environments</div>
<header><h1>Environments <span>what workers offer a run</span></h1><div></div><div class="meta"><a href="/teams">Teams</a></div></header>
<main>${flash ? `<div class="flash ${flash.error ? 'err' : ''}">${escape(flash.text)}</div>` : ''}
<p class="n">An environment names the tools a worker machine gives a run beyond the repository: a headless browser, a container runtime, a display. A project selects one in its settings; cloud launchers read its image and instance defaults and the worker image build installs its packages.</p>
<div class="list">${rows || '<p class="empty">No environments stored yet.</p>'}</div>
<h2>New environment</h2><form method="get" action="/environments/new" class="compose" onsubmit="location.href='/environments/'+this.id.value.trim();return false"><input name="id" pattern="[a-z][a-z0-9-]{0,63}" placeholder="environment id" required><button type="submit">Create</button></form></main>`;
  return page('Environments', body, 0);
}

export function renderEnvironment({ environment, id, history, flash }) {
  const doc = environment ?? { id, name: id, description: '', capabilities: [], launcher: {}, packages: [] };
  const versions = history.map(entry => `<div class="row"><span class="at">v${entry.version}</span><span class="who">${escape(entry.author)}<small>${escape(when(new Date(entry.createdAt).toISOString()))}</small></span><span class="what">${escape(entry.note ?? '')}</span>${entry.version !== environment?.version ? `<form method="post" action="/environments/${escape(id)}" class="inline"><input type="hidden" name="action" value="revert"><input type="hidden" name="version" value="${entry.version}"><button type="submit" class="secondary">Revert</button></form>` : '<span class="st act">current</span>'}</div>`).join('');
  const body = `<div class="crumb"><a href="/">← Agent team</a> · <a href="/environments">Environments</a> · ${escape(id)}</div>
<header><h1>${escape(doc.name)} <span>${environment ? `version ${environment.version}` : 'new environment'}</span></h1><div></div><div class="meta"></div></header>
<main>${flash ? `<div class="flash ${flash.error ? 'err' : ''}">${escape(flash.text)}</div>` : ''}
<form method="post" action="/environments/${escape(id)}" class="settings">
<fieldset><legend>environment</legend><div class="field"><label>Name</label><input name="name" maxlength="80" value="${escape(doc.name)}" required></div><div class="field"><label>Description</label><input name="description" maxlength="400" value="${escape(doc.description ?? '')}"></div></fieldset>
<fieldset><legend>capabilities</legend>${Object.entries(CAPABILITIES).map(([key, capability]) => `<div class="field"><label class="inline"><input type="checkbox" name="capabilities" value="${key}"${doc.capabilities.includes(key) ? ' checked' : ''}> ${escape(capability.title)}</label><small>${escape(capability.note)}</small></div>`).join('')}</fieldset>
<fieldset><legend>launcher defaults <small>cloud workers; the project manifest wins where it sets a value</small></legend>${LAUNCHER_FIELDS.map(key => `<div class="field${key === 'setup' ? ' wide' : ''}"><label>${escape(key)}</label><input name="launcher.${key}" maxlength="${key === 'setup' ? 2000 : 200}" value="${escape(doc.launcher?.[key] ?? '')}"></div>`).join('')}</fieldset>
<fieldset><legend>packages <small>installed into the worker image</small></legend><div class="field wide"><label>Package names, space separated</label><input name="packages" maxlength="2000" value="${escape(doc.packages.join(' '))}"></div></fieldset>
<div class="field"><label for="env-note">Change note</label><input id="env-note" name="note" type="text" maxlength="400" placeholder="Why this changes (kept in history)"></div>
<div class="actions"><button type="submit">Save environment</button></div></form>
<h2>History <small>${history.length} versions</small></h2><div class="list">${versions || '<p class="empty">Not saved yet.</p>'}</div></main>`;
  return page(`Environment · ${doc.name}`, body, 0);
}

export function environmentFromForm(form, id) {
  const launcher = {};
  for (const key of LAUNCHER_FIELDS) { const value = (form.get(`launcher.${key}`) ?? '').trim(); if (value) launcher[key] = value; }
  return { id, name: form.get('name') ?? id, description: form.get('description') ?? '', capabilities: form.getAll('capabilities'), launcher, packages: (form.get('packages') ?? '').split(/\s+/).filter(Boolean) };
}

export function renderSettings({ project, settings, history, lookup, lookupError, flash }) {
  const body = `<div class="crumb"><a href="/">← Agent team</a> · <a href="/projects/${escape(project.project)}">${escape(project.name)}</a> · Settings</div>
<header><h1>Settings <span>${escape(project.name)}</span></h1><div></div><div class="meta">${settings.updatedAt ? `last saved ${escape(when(new Date(settings.updatedAt).toISOString()))} UTC by ${escape(settings.author)}` : 'repository values in force'}</div></header>
<main>${flash ? `<div class="flash ${flash.error ? 'err' : ''}">${escape(flash.text)}</div>` : ''}
<p class="n">Values saved here override the repository's .agent-team.json for intake, the PM and every run, without a commit. Fields marked <span class="st act">override</span> differ from the repository. Clearing a field returns it to the repository value.</p>
${renderSettingsForm({ projectId: project.project, settings, lookup, lookupError })}
<h2>History <small>${history.length} changes</small></h2>${renderSettingsHistory(history)}</main>`;
  return page(`Settings · ${project.name}`, body, 0);
}

export function renderMemory({ project, memory, proposals, flash }) {
  const items = memory?.items ?? [];
  const byType = {};
  for (const item of items) (byType[item.type] ??= []).push(item);
  const rows = ITEM_TYPES.filter(type => byType[type]?.length).map(type => `<h2>${escape(type)} <small>${byType[type].length}</small></h2><div class="list">${byType[type].map(item => `<div class="row"><span class="at">${item.hits ?? 0}×</span><span class="who"><a href="/projects/${escape(project.project)}/memory/file?path=items/${escape(item.id)}.md">${escape(item.title)}</a><small>${escape(item.id)}${item.scope.length ? ` · ${escape(item.scope.join(', '))}` : ''}</small></span><span class="what">${escape(clip(item.body, 200))}</span><span>${tag(item.confirmed ? 'confirmed' : 'unconfirmed')} ${item.status !== 'active' ? tag(item.status) : ''}
<form method="post" action="/projects/${escape(project.project)}/memory" style="display:inline"><input type="hidden" name="action" value="status"><input type="hidden" name="id" value="${escape(item.id)}"><select name="status">${ITEM_STATUS.map(status => `<option ${status === item.status ? 'selected' : ''}>${status}</option>`).join('')}</select><button type="submit">Set</button></form></span></div>`).join('')}</div>`).join('');
  const pending = proposals.length ? `<h2>Proposed by runs <small>${proposals.length} pending</small></h2><div class="list">${proposals.map(p => `<div class="row"><span class="at">${escape(clock(new Date(p.createdAt).toISOString()))}</span><span class="who">${escape(p.item.title)}<small>${escape(p.item.type)} · <a href="/runs/${escape(p.jobId)}">run</a></small></span><span class="what">${escape(clip(p.item.body, 300))}</span><span><form method="post" action="/projects/${escape(project.project)}/proposal" style="display:inline"><input type="hidden" name="id" value="${escape(p.id)}"><button name="action" value="accept">Accept</button> <button name="action" value="discard">Discard</button></form></span></div>`).join('')}</div>` : '';
  const body = `<div class="crumb"><a href="/">← Agent team</a> · <a href="/projects/${escape(project.project)}">${escape(project.name)}</a> · <a href="/projects/${escape(project.project)}/memory/history">History</a></div>
<header><h1>Memory <span>${escape(project.name)}</span></h1><div></div><div class="meta">${memory ? `head ${escape(memory.head.slice(0, 8))} · ${items.length} items · <a href="/projects/${escape(project.project)}/memory/file?path=charter.md">charter</a>` : 'not initialized'}</div></header>
<main>${flash ? `<div class="flash ${flash.error ? 'err' : ''}">${escape(flash.text)}</div>` : ''}
${memory ? '' : `<form method="post" action="/projects/${escape(project.project)}/memory"><input type="hidden" name="action" value="init"><button type="submit">Initialize memory</button></form>`}
${pending}${rows || '<p class="empty">No items yet. Runs propose learnings; the PM and you decide what is kept.</p>'}
<h2>Add an item</h2><form method="post" action="/projects/${escape(project.project)}/memory" class="compose"><input type="hidden" name="action" value="new"><select name="type">${ITEM_TYPES.map(type => `<option>${type}</option>`).join('')}</select><input name="scope" placeholder="scope, comma separated (paths or areas)"><input name="title" placeholder="title" maxlength="160" required><textarea name="body" rows="4" maxlength="8000" placeholder="the fact, with enough context to act on it" required></textarea><label><input type="checkbox" name="confirmed" checked> confirmed</label><button type="submit">Add</button></form></main>`;
  return page(`Memory · ${project.name}`, body, 0);
}

export function renderMemoryFile({ project, file, content, sha, flash }) {
  const readOnly = Boolean(sha);
  const body = `<div class="crumb"><a href="/">← Agent team</a> · <a href="/projects/${escape(project.project)}/memory">Memory</a> · ${escape(file)}${sha ? ` @ ${escape(sha.slice(0, 8))}` : ''}</div>
<header><h1>${escape(file)} <span>${escape(project.name)}</span></h1><div></div><div class="meta">${escape(content.sha.slice(0, 8))}</div></header>
<main>${flash ? `<div class="flash ${flash.error ? 'err' : ''}">${escape(flash.text)}</div>` : ''}
${readOnly ? `<pre>${escape(content.content)}</pre><p class="n"><a href="/projects/${escape(project.project)}/memory/file?path=${encodeURIComponent(file)}">Edit current version</a></p>`
    : `<form method="post" action="/projects/${escape(project.project)}/memory" class="compose"><input type="hidden" name="action" value="edit"><input type="hidden" name="path" value="${escape(file)}"><textarea name="content" rows="24" style="font-family:var(--mono)">${escape(content.content)}</textarea><input name="message" placeholder="commit message (optional)" maxlength="200"><button type="submit">Save as owner</button></form>`}</main>`;
  return page(`${file} · ${project.name}`, body, 0);
}

export function renderMemoryHistory({ project, log, sha, diff, flash }) {
  const body = `<div class="crumb"><a href="/">← Agent team</a> · <a href="/projects/${escape(project.project)}/memory">Memory</a> · History</div>
<header><h1>Memory history <span>${escape(project.name)}</span></h1><div></div><div class="meta">${log.length} commits</div></header>
<main>${flash ? `<div class="flash ${flash.error ? 'err' : ''}">${escape(flash.text)}</div>` : ''}
<div class="cols"><section><div class="list">${log.map(entry => `<div class="row"><span class="at">${escape(when(entry.at))}</span><span class="who"><a href="/projects/${escape(project.project)}/memory/history?sha=${escape(entry.sha)}">${escape(entry.sha.slice(0, 8))}</a><small>${escape(entry.author)}</small></span><span class="what">${escape(entry.subject)}</span><form method="post" action="/projects/${escape(project.project)}/memory"><input type="hidden" name="action" value="revert"><input type="hidden" name="sha" value="${escape(entry.sha)}"><button type="submit" title="Restore the project memory as it was at this commit, as a new commit">Revert to</button></form></div>`).join('') || '<p class="empty">No history yet.</p>'}</div></section>
<section>${diff ? `<h2>Diff <small>${escape(sha.slice(0, 8))}</small></h2><pre>${escape(diff.diff || '(empty)')}</pre>` : '<p class="empty">Choose a commit to see its diff.</p>'}</section></div></main>`;
  return page(`Memory history · ${project.name}`, body, 0);
}

function memberActivity(state, role) {
  return state.runs.map(run => {
    const mine = (run.steps ?? []).filter(step => role === 'team-coordinator' ? !step.member : step.member === role);
    const steps = role === 'team-ideation' ? (run.ideation ? run.steps : []) : mine;
    return steps.length ? { ...run, steps: steps.slice(-12), count: steps.length } : null;
  }).filter(Boolean);
}

function basicAuth(req, password) {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Basic ')) return false;
  const given = Buffer.from(Buffer.from(header.slice(6), 'base64').toString('utf8').split(':').slice(1).join(':'));
  const expected = Buffer.from(password);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function createDashboardServer(config) {
  const request = config.request ?? createClient(config.coordinatorUrl, config.token);
  const state = () => collectState({ request });
  const sameOrigin = req => { const site = req.headers['sec-fetch-site']; const origin = req.headers.origin; return site ? ['same-origin', 'none'].includes(site) : !origin || origin === `${req.headers['x-forwarded-proto'] ?? 'http'}://${req.headers.host}`; };
  return createServer(async (req, res) => {
    const reply = (status, type, body) => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
    try {
      if (config.password && !basicAuth(req, config.password)) { req.resume(); res.writeHead(401, { 'www-authenticate': 'Basic realm="agent-team"', 'content-type': 'text/plain' }); return res.end('Sign in'); }
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'POST') {
        const projectAction = /^\/projects\/([A-Za-z0-9][A-Za-z0-9_-]{0,79})\/(message|memory|decision|proposal|settings|channel)$/.exec(url.pathname);
        const storeAction = /^\/(teams|environments)\/([a-z][a-z0-9-]{0,63})$/.exec(url.pathname);
        if (!['/actions', '/chat'].includes(url.pathname) && !projectAction && !storeAction) return reply(404, 'text/plain', 'Not found');
        if (!sameOrigin(req)) { req.resume(); return reply(403, 'text/plain', 'Actions are accepted from the dashboard page only'); }
        let size = 0; const chunks = [];
        for await (const chunk of req) { size += chunk.length; if (size > 262144) return reply(413, 'text/plain', 'Too large'); chunks.push(chunk); }
        const form = new URLSearchParams(Buffer.concat(chunks).toString());
        const current = await state();
        if (storeAction) {
          const [, kind, id] = storeAction;
          const back = text => { res.writeHead(303, { location: `/${kind}/${id}?${text.error ? 'error' : 'ok'}=${encodeURIComponent(text.text)}` }); res.end(); };
          try {
            if (form.get('action') === 'revert') { const saved = await request(`/${kind}/${id}/revert`, { version: Number(form.get('version')), author: 'owner' }); return back({ text: `Reverted to version ${form.get('version')}; now version ${saved.version}.` }); }
            const doc = kind === 'teams' ? teamFromForm(form, id) : environmentFromForm(form, id);
            const saved = await request(`/${kind}/${id}`, { doc, author: 'owner', ...(form.get('note') ? { note: form.get('note') } : {}) });
            return back({ text: `Saved version ${saved.version}; it applies to the next run.` });
          } catch (error) { return back({ error: true, text: `The coordinator refused: ${error.message}` }); }
        }
        if (projectAction) {
          const [, projectId, what] = projectAction;
          const owner = { name: 'owner' };
          const page = what === 'memory' || what === 'settings' ? `/projects/${projectId}/${what}` : `/projects/${projectId}`;
          const back = (text, to = page) => { res.writeHead(303, { location: `${to}${to.includes('?') ? '&' : '?'}${text.error ? 'error' : 'ok'}=${encodeURIComponent(text.text)}` }); res.end(); };
          if (!current.overview.some(p => p.project === projectId)) return back({ error: true, text: 'Unknown project.' }, '/');
          try {
            if (what === 'settings') {
              const note = (form.get('note') ?? '').trim() || undefined;
              if (form.get('reset') === '1') { await request(`/projects/${projectId}/settings`, { overrides: {}, author: owner.name, note: note ?? 'Cleared all overrides' }); return back({ text: 'All overrides cleared; repository values are in force.' }); }
              const current = await request(`/projects/${projectId}/settings`);
              let overrides;
              try { overrides = overridesFromForm(form, current.repoManifest ?? current.manifest); } catch (error) { return back({ error: true, text: error.message }); }
              const saved = await request(`/projects/${projectId}/settings`, { overrides, author: owner.name, note });
              const count = Object.values(saved.overrides).reduce((sum, section) => sum + Object.keys(section).length, 0);
              return back({ text: count ? `Saved ${count} override${count === 1 ? '' : 's'}; they apply to the next intake poll, PM session and run.` : 'Saved; no values differ from the repository.' });
            }
            if (what === 'message') {
              const body = (form.get('message') ?? '').trim();
              if (!body) return back({ error: true, text: 'Write a message first.' });
              await request(`/projects/${projectId}/messages`, { author: 'owner', body, state: 'pending' });
              return back({ text: `Sent to ${ROSTER[PM].name}; the reply appears here when the PM session finishes.` });
            }
            if (what === 'channel') {
              const body = (form.get('body') ?? '').trim();
              if (!body) return back({ error: true, text: 'Write a post first.' });
              const post = await request(`/projects/${projectId}/channel`, { author: 'owner', body, kind: 'note' });
              const woke = (post?.woke ?? []).map(role => ROSTER[role]?.name ?? role);
              return back({ text: woke.length ? `Posted to the team channel; ${woke.join(' and ')} ${woke.length === 1 ? 'is' : 'are'} answering there.` : 'Posted to the team channel; every run reads it at its next cycle start.' }, `${page}#channel`);
            }
            if (what === 'decision') {
              await request(`/decisions/${form.get('id')}/resolve`, { choice: form.get('choice'), ...(form.get('note') ? { note: form.get('note') } : {}) });
              await request(`/projects/${projectId}/messages`, { author: 'owner', body: `Decision "${form.get('title') ?? form.get('id')}": ${form.get('choice')}${form.get('note') ? ` — ${form.get('note')}` : ''}`, state: 'pending' });
              return back({ text: 'Decision recorded; the PM has been told.' });
            }
            if (what === 'proposal') {
              await request(`/proposals/${form.get('id')}/resolve`, { action: form.get('action'), author: owner });
              return back({ text: `Learning ${form.get('action') === 'accept' ? 'accepted into memory' : 'discarded'}.` });
            }
            const action = form.get('action');
            if (action === 'edit') {
              const file = form.get('path') ?? 'charter.md';
              const result = await request(`/projects/${projectId}/memory/file`, { file, content: (form.get('content') ?? '').replace(/\r\n/g, '\n'), author: owner, message: form.get('message') || `Owner edits ${file}` });
              return back({ text: `Saved ${file} as ${result.sha.slice(0, 8)}.` }, `/projects/${projectId}/memory/file?path=${encodeURIComponent(file)}`);
            }
            if (action === 'revert') { const result = await request(`/projects/${projectId}/memory/revert`, { sha: form.get('sha'), author: owner }); return back({ text: `Reverted to ${String(form.get('sha')).slice(0, 8)} as ${result.sha.slice(0, 8)}.` }, `/projects/${projectId}/memory/history`); }
            if (action === 'status') { await request(`/projects/${projectId}/memory/status`, { ids: [form.get('id')], status: form.get('status'), author: owner }); return back({ text: `Marked ${form.get('id')} ${form.get('status')}.` }); }
            if (action === 'new') {
              const result = await request(`/projects/${projectId}/memory/items`, { items: [{ type: form.get('type') ?? 'observation', title: form.get('title') ?? '', body: form.get('body') ?? '', scope: (form.get('scope') ?? '').split(',').map(v => v.trim()).filter(Boolean), confirmed: form.get('confirmed') === 'on', source: 'owner' }], author: owner });
              return back({ text: `Added ${result.ids.join(', ')}.` });
            }
            if (action === 'init') { await request(`/projects/${projectId}/memory/init`, {}); return back({ text: 'Memory initialized for this project.' }); }
            return back({ error: true, text: 'Unknown memory action.' });
          } catch (error) { return back({ error: true, text: `The coordinator refused: ${error.message}` }); }
        }
        const project = current.overview.find(p => p.project === form.get('project'));
        if (url.pathname === '/chat') {
          const role = form.get('role'); const issue = (form.get('issue') || project?.inbox || '').trim();
          const back = text => { res.writeHead(303, { location: `/team/${encodeURIComponent(role ?? '')}?project=${encodeURIComponent(project?.project ?? '')}&issue=${encodeURIComponent(issue)}&${text.error ? 'error' : 'ok'}=${encodeURIComponent(text.text)}` }); res.end(); };
          const wantsJson = (req.headers.accept ?? '').includes('application/json');
          if (!Object.hasOwn(ROSTER, role) || !project) return wantsJson ? reply(400, 'application/json', JSON.stringify({ error: 'Choose a team member and a project.' })) : back({ error: true, text: 'Choose a team member and a project.' });
          try {
            const job = await request('/jobs', { projectId: project.project, kind: 'chat', role, issue, message: form.get('message') ?? '' });
            const text = project.online ? `Sent to ${ROSTER[role].name} on ${issue}.` : `Queued for ${ROSTER[role].name} on ${issue}; it is delivered when a worker for ${project.name} is online.`;
            return wantsJson ? reply(200, 'application/json', JSON.stringify({ jobId: job.id, text, online: project.online })) : back({ text });
          } catch (error) { return wantsJson ? reply(400, 'application/json', JSON.stringify({ error: `Not sent: ${error.message}` })) : back({ error: true, text: `Not sent: ${error.message}` }); }
        }
        const back = flash => { res.writeHead(303, { location: `/?${flash.error ? 'error' : 'ok'}=${encodeURIComponent(flash.text)}` }); res.end(); };
        if (!project) return back({ error: true, text: 'Unknown project.' });
        try {
          if (form.get('action') === 'ideate') {
            if (!project.ideation) return back({ error: true, text: `${project.name} has no ideation configuration.` });
            if (project.ideation.blockedBy && project.ideation.blockedBy !== 'cooldown') return back({ error: true, text: `Ideation for ${project.name} is waiting on: ${project.ideation.blockedBy}.` });
            const manifest = (await request('/projects')).find(p => p.id === project.project)?.manifest ?? {};
            const baseBranch = manifest.scm?.baseBranch ?? manifest.delivery?.baseBranch;
            const base = typeof baseBranch === 'string' ? { base: `origin/${baseBranch}`, fetch: true } : {};
            const job = await request('/jobs', { projectId: project.project, kind: 'ideation', proposalLimit: project.ideation.batchSize, timeoutMinutes: 10, ...base });
            return back({ text: `Queued ideation for ${project.name} (${project.ideation.batchSize} proposals). Job ${job.id}.` });
          }
          if (form.get('action') === 'requeue') {
            const job = project.held.find(job => job.id === form.get('job'));
            if (!job) return back({ error: true, text: 'That job is no longer on hold.' });
            await request(`/jobs/${job.id}/requeue`, {});
            return back({ text: `Released ${project.name}: job ${job.id} is queued again.` });
          }
          return back({ error: true, text: 'Unknown action.' });
        } catch (error) { return back({ error: true, text: `The coordinator refused: ${error.message}` }); }
      }
      if (req.method !== 'GET') return reply(405, 'text/plain', 'GET only');
      const flash = url.searchParams.has('ok') ? { text: url.searchParams.get('ok') } : url.searchParams.has('error') ? { error: true, text: url.searchParams.get('error') } : null;
      if (url.pathname === '/') return reply(200, 'text/html; charset=utf-8', renderIndex(await state(), flash, config.hostname));
      if (url.pathname === '/api/state') return reply(200, 'application/json', JSON.stringify(await state()));
      if (url.pathname === '/health') return reply(200, 'application/json', '{"ok":true}');
      const portrait = /^\/portraits\/(team-[a-z]+)\.webp$/.exec(url.pathname);
      if (portrait) {
        const file = config.portraits ? path.join(config.portraits, `${portrait[1]}.webp`) : blueprintFile(`portraits/${portrait[1]}.webp`);
        if (!Object.hasOwn(ROSTER, portrait[1]) || !file || !fs.existsSync(file)) return reply(404, 'text/plain', 'Not found');
        res.writeHead(200, { 'content-type': 'image/webp', 'cache-control': 'public, max-age=3600' }); return res.end(fs.readFileSync(file));
      }
      const storePage = /^\/(teams|environments)(?:\/([a-z][a-z0-9-]{0,63}))?$/.exec(url.pathname);
      if (storePage) {
        const [, kind, id] = storePage;
        const list = await request(`/${kind}`);
        if (!id) return reply(200, 'text/html; charset=utf-8', kind === 'teams' ? renderTeams({ teams: list, flash }) : renderEnvironments({ environments: list, flash }));
        const item = list.find(entry => entry.id === id) ?? null;
        const history = item ? await request(`/${kind}/${id}/history?limit=20`).catch(() => []) : [];
        return reply(200, 'text/html; charset=utf-8', kind === 'teams' ? renderTeam({ team: item, id, history, flash }) : renderEnvironment({ environment: item, id, history, flash }));
      }
      const memberMatch = /^\/team\/(team-[a-z]+)$/.exec(url.pathname);
      if (memberMatch) {
        const role = memberMatch[1];
        if (!Object.hasOwn(ROSTER, role)) return reply(404, 'text/plain', 'Not found');
        const current = await state();
        const project = current.overview.find(p => p.project === url.searchParams.get('project')) ?? current.overview[0] ?? null;
        const issue = url.searchParams.get('issue') || project?.inbox || '';
        const thread = current.jobs.filter(job => job.kind === 'chat' && job.role === role && job.projectId === project?.project && job.issue === issue).sort((a, b) => a.createdAt - b.createdAt).slice(-30);
        return reply(200, 'text/html; charset=utf-8', renderMember({ role, state: current, activity: memberActivity(current, role), selected: { project: project?.project ?? null, issue }, thread, flash }));
      }
      // Live stream: relay the coordinator's raw event lines as formatted steps over server-sent events.
      const streamMatch = /^\/runs\/([a-f0-9-]{36})\/stream$/.exec(url.pathname);
      if (streamMatch) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        let after = Number(url.searchParams.get('after') ?? 0) || 0; const handoffs = {}; let open = true; let idle = 0;
        req.on('close', () => { open = false; });
        const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        while (open) {
          let batch;
          try { batch = await request(`/jobs/${streamMatch[1]}/events?after=${after}&limit=400`); } catch { send('done', { reason: 'unavailable' }); break; }
          if (batch.events.length) {
            after = batch.events.at(-1).seq;
            const parsed = eventSteps(batch.events.map(event => event.line).join('\n'), 400, null, { results: true, handoffs });
            send('steps', { after, steps: parsed.steps });
            idle = 0;
          } else if (++idle % 15 === 0) send('ping', { after });
          if (!['queued', 'running'].includes(batch.jobState) && !batch.events.length) { send('done', { reason: batch.jobState, after }); break; }
          await new Promise(resolve => setTimeout(resolve, batch.events.length ? 200 : 1500));
        }
        return res.end();
      }
      const runMatch = /^\/runs\/([a-f0-9-]{36})$/.exec(url.pathname);
      if (runMatch) {
        let detail;
        try { detail = await request(`/jobs/${runMatch[1]}/evidence`); } catch { return reply(404, 'text/plain', 'No evidence reported for that job'); }
        const [injection, artifacts, proposals] = await Promise.all([request(`/jobs/${runMatch[1]}/injection`).catch(() => null), request(`/jobs/${runMatch[1]}/artifacts`).catch(() => null), request(`/jobs/${runMatch[1]}/proposals?state=`).catch(() => [])]);
        if (url.searchParams.get('format') === 'json') return reply(200, 'application/json', JSON.stringify({ ...detail, injection, artifacts, proposals }));
        return reply(200, 'text/html; charset=utf-8', renderRun(detail, { injection, artifacts, proposals }));
      }
      const projectPage = /^\/projects\/([A-Za-z0-9][A-Za-z0-9_-]{0,79})(\/memory(?:\/(file|history))?|\/settings)?$/.exec(url.pathname);
      if (projectPage) {
        const [, projectId, memoryPath, sub] = projectPage;
        const current = await state();
        const project = current.overview.find(p => p.project === projectId);
        if (!project) return reply(404, 'text/plain', 'Unknown project');
        if (memoryPath === '/settings') {
          const [settings, history] = await Promise.all([request(`/projects/${projectId}/settings`), request(`/projects/${projectId}/settings/history?limit=30`)]);
          const team = url.searchParams.get('team') ?? undefined;
          let lookup = null; let lookupError = null;
          try { lookup = await request(`/projects/${projectId}/tracker/lookup${team ? `?team=${encodeURIComponent(team)}` : ''}`); } catch (error) { lookupError = error.message; }
          // Stored teams and environments feed the selectors; the chosen team's subagents feed the roles list.
          const [teams, environments, chosen] = await Promise.all([request('/teams').catch(() => []), request('/environments').catch(() => []), request(`/projects/${projectId}/team`).catch(() => null)]);
          lookup = { ...(lookup ?? {}), blueprints: teams.map(item => item.id), environments: environments.map(item => item.id), roles: chosen ? Object.entries(chosen.agents).filter(([, agent]) => agent.mode === 'subagent').map(([role]) => role) : [] };
          return reply(200, 'text/html; charset=utf-8', renderSettings({ project, settings, history, lookup, lookupError, flash }));
        }
        if (!memoryPath) {
          const [thread, decisions, costs, channel] = await Promise.all([request(`/projects/${projectId}/thread`), request(`/decisions?project=${projectId}&state=open`), request(`/projects/${projectId}/costs`).catch(() => null), request(`/projects/${projectId}/channel?limit=40`).catch(() => [])]);
          return reply(200, 'text/html; charset=utf-8', renderProject({ project, state: current, thread, decisions, costs, flash, channel }));
        }
        if (sub === 'file') {
          const file = url.searchParams.get('path') ?? 'charter.md'; const sha = url.searchParams.get('sha') ?? undefined;
          let content;
          try { content = await request(`/projects/${projectId}/memory/file/${encodeURIComponent(file)}${sha ? `?sha=${encodeURIComponent(sha)}` : ''}`); } catch { return reply(404, 'text/plain', 'No such memory file'); }
          return reply(200, 'text/html; charset=utf-8', renderMemoryFile({ project, file, content, sha, flash }));
        }
        if (sub === 'history') {
          const log = await request(`/projects/${projectId}/memory/log?limit=60`);
          const sha = url.searchParams.get('sha');
          const diff = sha ? await request(`/projects/${projectId}/memory/diff/${encodeURIComponent(sha)}`).catch(() => null) : null;
          return reply(200, 'text/html; charset=utf-8', renderMemoryHistory({ project, log, sha, diff, flash }));
        }
        const memory = await request(`/projects/${projectId}/memory`).catch(() => null);
        const proposals = await request(`/proposals?project=${projectId}&state=pending`).catch(() => []);
        return reply(200, 'text/html; charset=utf-8', renderMemory({ project, memory, proposals, flash }));
      }
      return reply(404, 'text/plain', 'Not found');
    } catch (error) { reply(500, 'text/plain', 'Dashboard error; see service log'); console.error(error.message); }
  });
}

// Configuration: coordinatorUrl directly, or a worker.json to borrow it from. The token comes from
// the environment or the private service file. A non-loopback bind requires a password.
export function loadConfig(file, env = process.env) {
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  const host = config.host ?? '127.0.0.1'; const port = Number(config.port ?? 4311);
  if (!validBind(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Use a loopback or private-network IPv4 bind address and valid port');
  let coordinatorUrl = config.coordinatorUrl;
  if (!coordinatorUrl && config.worker) coordinatorUrl = JSON.parse(fs.readFileSync(config.worker, 'utf8')).coordinatorUrl;
  if (typeof coordinatorUrl !== 'string') throw new Error('dashboard.json needs coordinatorUrl (or a worker config that has one)');
  const password = env.AGENT_TEAM_DASHBOARD_PASSWORD;
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) && (typeof password !== 'string' || password.length < 12)) throw new Error('A public bind requires AGENT_TEAM_DASHBOARD_PASSWORD of at least 12 characters');
  return { host, port, coordinatorUrl, token: localToken(env), password: password || null, hostname: env.AGENT_TEAM_HOSTNAME ?? config.hostname ?? 'local' };
}

export async function main(args = process.argv.slice(2)) {
  let file;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' && args[i + 1]) file = args[++i];
    else throw new Error('Usage: node core/dashboard.mjs --config dashboard.json');
  }
  if (!file) throw new Error('Usage: node core/dashboard.mjs --config dashboard.json');
  const config = loadConfig(file);
  const server = createDashboardServer(config);
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  server.listen(config.port, config.host, () => console.log(`Agent team dashboard on http://${config.host}:${config.port}`));
  const stop = () => server.close();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
