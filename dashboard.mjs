import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validBind } from './queue.mjs';
import { createClient } from './worker.mjs';
import { localToken } from './cli.mjs';
import { ROSTER } from './roster.mjs';
import { clip } from './evidence.mjs';

const PORTRAITS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'portraits');
const ACTIVE = ['queued', 'running', 'blocked', 'failed'];
const DAY = 86_400_000;

// Everything the page shows comes from the coordinator API: jobs, run evidence reported by
// workers, and the project registry workers fill from their manifests. No local disk is read.
export async function collectState({ request, now = Date.now }) {
  const time = now();
  const [jobsRaw, evidence, registry] = await Promise.all([request('/jobs'), request('/evidence?limit=60'), request('/projects')]);
  const jobs = jobsRaw.map(job => ({ id: job.id, projectId: job.projectId, kind: job.kind ?? 'development', issue: job.issue ?? null, engine: job.engine ?? null, base: job.base ?? null,
    role: job.role ?? null, message: job.message ?? null, publish: job.publish === true, autoMerge: job.autoMerge === true, state: job.state, workerId: job.workerId ?? null,
    createdAt: job.createdAt, updatedAt: job.updatedAt, outcome: job.result?.outcome ?? null, summary: clip(job.result?.summary ?? '', job.kind === 'chat' ? 4000 : 300) })).sort((a, b) => b.createdAt - a.createdAt);
  const runs = evidence.map(item => ({ ...item.run, jobId: item.jobId, jobState: item.jobState, steps: item.steps, members: item.members, active: item.active, usage: item.usage, tokens: item.tokens, updatedAt: item.updatedAt }))
    .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
  const live = runs.filter(run => run.state === 'running' && run.jobState === 'running');
  const usage = live.find(run => run.usage)?.usage ?? runs.find(run => run.engine === 'claude' && run.usage)?.usage ?? null;
  const openai = { day: 0, week: 0, lastRun: null };
  for (const run of runs) {
    if (run.engine !== 'opencode') continue;
    const age = time - new Date(run.startedAt ?? 0).getTime();
    if (age <= 7 * DAY) { openai.week += run.tokens ?? 0; if (age <= DAY) openai.day += run.tokens ?? 0; openai.lastRun ??= { jobId: run.jobId, project: run.project, tokens: run.tokens ?? 0 }; }
  }
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
    return { project: project.id, name: manifest.name ?? project.id, inbox: manifest.ownerInboxIssue ?? null, workerId: project.workerId, seenAt: project.seenAt,
      online: project.seenAt ? time - project.seenAt < 180_000 : false,
      status: held.length ? 'on hold' : running ? 'running' : own.some(job => job.state === 'queued') ? 'queued' : 'idle',
      running: running ? { jobId: running.jobId, issue: running.issue, ideation: running.ideation, startedAt: running.startedAt } : null,
      queued: own.filter(job => job.state === 'queued').map(job => ({ id: job.id, issue: job.issue, kind: job.kind, createdAt: job.createdAt })),
      held: held.map(job => ({ id: job.id, issue: job.issue, kind: job.kind, summary: job.summary })),
      delivered: delivered ? { issue: delivered.issue, prUrl: delivered.prUrl, finishedAt: delivered.finishedAt } : null, runs: runs.filter(run => run.project === project.id).length,
      ideation: ideation ? { batchSize: ideation.batchSize, backlogCap: ideation.backlogCap, cooldownEnds, blockedBy: held.length ? 'held job' : own.some(job => ACTIVE.includes(job.state)) ? 'active job' : cooldownEnds && cooldownEnds > time ? 'cooldown' : null } : null };
  });
  return { generatedAt: new Date(time).toISOString(), overview, team, jobs, runs, live, usage, openai, quarantined };
}

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = iso => iso ? new Date(iso).toISOString().replace('T', ' ').slice(0, 16) : '';
const clock = iso => iso ? new Date(iso).toISOString().slice(11, 16) : '';
const pct = value => typeof value === 'number' ? Math.round(value * 100) : null;
const minutes = (from, to) => from ? Math.max(0, Math.round((new Date(to ?? Date.now()) - new Date(from)) / 60000)) : null;
const ago = ms => ms === null || ms === undefined ? 'never' : ms < 90_000 ? `${Math.round(ms / 1000)} s ago` : ms < 5_400_000 ? `${Math.round(ms / 60000)} min ago` : `${Math.round(ms / 3_600_000)} h ago`;
const compact = n => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
const short = url => escape(/\/pull\/(\d+)$/.test(url) ? `#${url.match(/\/pull\/(\d+)$/)[1]}` : url.replace(/^https:\/\/github\.com\//, ''));
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
.ticker .t{color:var(--text)}.ticker .agent{color:var(--muted)}.ticker .agent::before{content:'↳ '}.ticker b{color:var(--text);font-weight:500}.ticker .say{color:var(--wait);font-family:var(--sans);font-size:13px}
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
.compose{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}.compose textarea,.compose select,.compose input{grid-column:1/-1;background:var(--panel-2);color:var(--text);border:1px solid var(--line);padding:8px;font:13px var(--sans);border-radius:3px}.compose select,.compose input{grid-column:auto}.compose button{grid-column:1/-1;justify-self:end}`;
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

export function renderIndex(state, flash = null, hostname = 'fly') {
  const units = state.overview.map(p => `<span><i class="dot ${p.online ? 'on' : 'off'}"></i>${escape(p.workerId ?? 'no worker')} for ${escape(p.name)} · seen ${escape(ago(p.seenAt ? Date.now() - p.seenAt : null))}</span>`).join('') || '<span><i class="dot"></i>no workers registered yet</span>';
  const claude = state.usage;
  const usage = `<div class="usage">${gauge('Claude 5h', pct(claude?.fiveHour?.utilization), claude?.fiveHour?.resetsAt ? `resets ${clock(claude.fiveHour.resetsAt * 1000)} UTC` : 'from the last Claude run')}${gauge('Claude 7d', pct(claude?.sevenDay?.utilization), claude?.sevenDay?.resetsAt ? `resets ${clock(claude.sevenDay.resetsAt * 1000)} UTC` : '')}${gauge('OpenCode tokens 24h', state.openai.week ? compact(state.openai.day) : null, 'OpenCode reports tokens, not plan limits', 'raw')}${gauge('OpenCode tokens 7d', state.openai.week ? compact(state.openai.week) : null, state.openai.lastRun ? `last run ${compact(state.openai.lastRun.tokens)} tokens` : 'no OpenCode runs this week', 'raw')}</div>`;
  const cards = state.overview.map(p => {
    const why = { 'held job': 'release the held job first', 'active job': 'available when the current job finishes' };
    const hold = p.ideation?.blockedBy && p.ideation.blockedBy !== 'cooldown' ? p.ideation.blockedBy : null;
    const ideas = p.ideation ? (hold ? `<button disabled>Propose ideas</button><span class="why">${escape(why[hold] ?? hold)}</span>` : `<button type="submit" name="action" value="ideate">Propose ${p.ideation.batchSize} ideas</button>${p.ideation.blockedBy === 'cooldown' ? `<span class="why">automatic refill waits until ${escape(when(p.ideation.cooldownEnds))} UTC</span>` : ''}`) : '';
    const release = p.held.length ? `<button type="submit" name="action" value="requeue" title="Rerun the held job after you have inspected it">Release and rerun</button>` : '';
    return `<div class="card ${p.status === 'on hold' ? 'hold' : ''}"><div class="top"><b>${escape(p.name)}</b>${tag(p.status)}</div>
<p>${p.running ? `${p.running.issue ? 'Building' : 'Running'} <a href="/runs/${escape(p.running.jobId)}">${escape(p.running.issue ?? (p.running.ideation ? 'ideation' : 'unpinned cycle'))}</a> · ${minutes(p.running.startedAt)} min` : p.status === 'on hold' ? `${p.held.length} job${p.held.length === 1 ? '' : 's'} on hold: ${escape(p.held[0].summary || p.held[0].issue || 'inspect the run')}` : p.queued.length ? `${p.queued.length} queued: ${escape(p.queued.map(job => job.issue ?? 'ideas').join(', '))}` : p.online ? 'Idle, waiting for approved work' : 'No worker online; queued work waits'}</p>
<p class="n"><a href="/team/team-pm?project=${escape(p.project)}">Message the team</a> · ${p.delivered ? `shipped ${escape(p.delivered.issue ?? 'run')} ${p.delivered.prUrl ? `<a href="${escape(p.delivered.prUrl)}">${short(p.delivered.prUrl)}</a>` : ''} ${escape(when(p.delivered.finishedAt))}` : 'nothing shipped yet'} · ${p.runs} runs</p>
${ideas || release ? `<form method="post" action="/actions"><input type="hidden" name="project" value="${escape(p.project)}">${p.held[0] ? `<input type="hidden" name="job" value="${escape(p.held[0].id)}">` : ''}${ideas}${release}</form>` : ''}</div>`;
  }).join('') || '<p class="empty">No projects registered. Start a worker with a mapped checkout and it registers its manifest here.</p>';
  const now = state.live.length ? state.live.map(run => `<div class="now"><h3><span class="pulse"></span><a href="/runs/${escape(run.jobId)}">${escape(run.issue ?? (run.ideation ? 'Proposing ideas' : 'Unpinned cycle'))}</a></h3>
<div class="sub"><span>${escape(run.project)}</span><span>${escape(run.engine)}</span><span>started ${escape(clock(run.startedAt))} UTC · ${minutes(run.startedAt)} min</span><span>reported ${escape(ago(Date.now() - run.updatedAt))}</span></div>${ticker(run.steps, run.jobId)}</div>`).join('')
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
  const upcomingHtml = upcoming.length ? upcoming.map((item, index) => `<div class="item"><i>${index + 1}</i><span>${escape(item.text)}<small>${escape(item.note)}</small></span></div>`).join('') : '<p class="empty">Nothing scheduled. Approving an idea in Linear queues a build within a minute.</p>';
  const jobs = state.jobs.filter(job => job.kind !== 'chat').map(job => `<div class="row"><span class="at">${escape(clock(job.createdAt))}</span><span class="who">${escape(job.issue ?? (job.kind === 'ideation' ? 'ideas' : 'cycle'))}<small>${escape(job.projectId)} · ${escape(job.engine ?? 'worker default')}${job.autoMerge ? ' · auto-merge' : job.publish ? ' · publish' : ''}</small></span><span class="what">${escape(job.summary) || (job.state === 'queued' ? 'Waiting for a worker.' : job.state === 'running' ? 'In progress.' : '')}</span>${tag(job.state)}</div>`).join('');
  const runs = state.runs.map(run => `<div class="row"><span class="at">${escape(clock(run.startedAt))}</span><span class="who"><a href="/runs/${escape(run.jobId)}">${escape(run.issue ?? (run.ideation || run.proposals ? 'ideas' : 'cycle'))}</a><small>${escape(run.project)} · ${escape(run.engine)} · ${minutes(run.startedAt, run.finishedAt) ?? '?'} min</small></span><span class="what">${run.delivery ? `<b>${escape(run.delivery)}</b> · ` : ''}${run.prUrl ? `<a href="${escape(run.prUrl)}">${short(run.prUrl)}</a> · ` : ''}${escape(run.summary)}${run.proposals?.length ? `<ul>${run.proposals.map(title => `<li>${escape(title)}</li>`).join('')}</ul>` : ''}</span>${tag(run.state)}</div>`).join('');
  const body = `<header><h1>Agent team <span>${escape(hostname)}</span></h1>${usage}<div class="meta">${escape(when(state.generatedAt))} UTC · live · <a href="/api/state">JSON</a></div></header>
<div class="units">${units}</div>
<main>${flash ? `<div class="flash ${flash.error ? 'err' : ''}">${escape(flash.text)}</div>` : ''}
<div class="team">${state.team.map(m => `<div class="member ${m.working ? 'busy' : ''}"><a href="/team/${escape(m.role)}">${avatar(m.role, 44)}</a><div><a class="name" href="/team/${escape(m.role)}">${escape(m.name)}</a><small>${escape(m.title)}</small><span>${m.working ? `on <a href="/runs/${escape(m.working.jobId)}">${escape(m.working.issue)}</a>${m.steps ? ` · ${m.steps} steps` : ''}` : 'idle'}</span></div></div>`).join('')}</div>
<div class="projects">${cards}</div>
<div class="cols"><section><h2>Now</h2>${now}</section><section><h2>Upcoming <small>automatic runs in order</small></h2><div class="up">${upcomingHtml}</div></section></div>
<div class="cols even"><section><h2>Queue <small>jobs asked of the coordinator · ${state.jobs.filter(job => job.kind !== 'chat' && ['queued', 'running'].includes(job.state)).length || 'none'} active</small></h2><div class="list">${jobs || '<p class="empty">No jobs yet.</p>'}</div></section>
<section><h2>Runs <small>what workers actually executed · latest ${state.runs.length}</small></h2><div class="list">${runs || '<p class="empty">No runs reported yet.</p>'}</div></section></div></main>`;
  return page('Agent team', body, 10_000);
}

export function renderRun(detail) {
  const { run } = detail;
  const result = detail.engineResult ? `${escape(detail.engineResult.subtype ?? '')}${detail.engineResult.isError ? ' (error)' : ''} · ${escape(detail.engineResult.turns ?? '?')} turns · ${Math.round((detail.engineResult.durationMs ?? 0) / 60000)} min of model time` : detail.tokens ? `${compact(detail.tokens)} tokens` : '';
  const body = `<div class="crumb"><a href="/">← Agent team</a></div>
<header><h1>${run.state === 'running' ? '<span class="pulse"></span> ' : ''}${escape(run.issue ?? (run.ideation ? 'Proposing ideas' : 'Unpinned cycle'))} <span>${escape(run.project)}</span></h1>
<div class="usage">${detail.usage ? gauge('Claude 5h', pct(detail.usage.fiveHour?.utilization), 'at the time of this run') + gauge('Claude 7d', pct(detail.usage.sevenDay?.utilization), '') : ''}</div><div class="meta">${tag(run.state)}${run.delivery ? ` ${tag(run.delivery)}` : ''}</div></header>
<div class="units"><span>${escape(run.engine)}</span><span>base ${escape(run.baseCommit ?? '')}</span><span>${escape(when(run.startedAt))} → ${escape(run.finishedAt ? clock(run.finishedAt) : 'running')} UTC · ${minutes(run.startedAt, run.finishedAt) ?? '?'} min</span>${run.prUrl ? `<span><a href="${escape(run.prUrl)}">${short(run.prUrl)}</a></span>` : ''}${result ? `<span>${result}</span>` : ''}<span>${escape(run.id)}</span><span>reported ${escape(ago(Date.now() - detail.updatedAt))}</span></div>
<main><section><h2>Steps <small>${detail.steps.length} shown</small></h2><div class="now">${ticker(detail.steps, detail.jobId, true)}</div></section>
<section><h2>Summary</h2><pre>${escape(detail.summary || 'Not written yet.')}</pre></section>
${detail.stderr?.trim() ? `<section><h2>Errors and warnings</h2><pre>${escape(detail.stderr)}</pre></section>` : ''}</main>`;
  return page(`${run.issue ?? 'run'} · ${run.id}`, body, run.state === 'running' ? 10_000 : 0);
}

export function renderMember({ role, state, activity, selected, thread, flash }) {
  const member = ROSTER[role];
  const working = state.team.find(m => m.role === role)?.working ?? null;
  const options = state.overview.map(p => `<option value="${escape(p.project)}" ${p.project === selected.project ? 'selected' : ''}>${escape(p.name)}</option>`).join('');
  const label = { queued: 'queued for a worker', running: 'thinking', blocked: 'failed', failed: 'failed', canceled: 'canceled' };
  const bubbles = thread.flatMap(job => [
    `<div class="msg owner"><div><div class="who">You <span>${escape(when(new Date(job.createdAt).toISOString()))}</span>${['queued', 'running'].includes(job.state) ? ` · ${label[job.state]}${job.state === 'running' ? ' <span class="pulse"></span>' : ''}` : ''}</div>${escape(job.message)}</div></div>`,
    job.state === 'completed' || ['blocked', 'failed'].includes(job.state) ? `<div class="msg member ${job.state}">${avatar(role, 22)}<div><div class="who">${escape(member.name)} <span>${escape(when(new Date(job.updatedAt).toISOString()))}</span>${job.state !== 'completed' ? ` · ${label[job.state]}` : ''}</div>${escape(job.summary)}</div></div>` : '']);
  const body = `<div class="crumb"><a href="/">← Agent team</a></div>
<header class="mh">${avatar(role, 96)}<div><h1>${escape(member.name)} <span>${escape(member.title)}</span></h1><p class="voice">${escape(member.voice)}</p><p class="n">${working ? `Working on <a href="/runs/${escape(working.jobId)}">${escape(working.issue)}</a> in ${escape(working.project)}` : 'Idle right now'}</p></div></header>
<main><div class="cols"><section><h2>Conversation <small>${escape(selected.issue || 'choose a card')} · ${escape(state.overview.find(p => p.project === selected.project)?.name ?? selected.project ?? '')}</small></h2>
${flash ? `<div class="flash ${flash.error ? 'err' : ''}">${escape(flash.text)}</div>` : ''}
<div class="chat" data-ticker="chat">${bubbles.join('') || `<p class="empty">No messages yet. What you write is posted on ${escape(selected.issue || 'the card')} in Linear by the project's worker; ${escape(member.name)} answers there and here.</p>`}</div>
${state.overview.length ? `<form method="post" action="/chat" class="compose"><input type="hidden" name="role" value="${escape(role)}"><select name="project">${options}</select><input name="issue" value="${escape(selected.issue ?? '')}" pattern="[A-Z][A-Z0-9]*-[1-9][0-9]*" title="Linear issue, e.g. the owner inbox" required><textarea name="message" rows="3" maxlength="4000" placeholder="Ask ${escape(member.name)} something, or give direction. It lands on the Linear card." required></textarea><button type="submit">Send to ${escape(member.name)}</button></form>` : '<p class="empty">No project is registered yet, so there is nowhere to send a message.</p>'}</section>
<section><h2>Recent work <small>${activity.length} runs</small></h2>${activity.map(item => `<div class="now"><h3><a href="/runs/${escape(item.jobId)}">${escape(item.issue ?? (item.ideation ? 'Proposing ideas' : 'cycle'))}</a> ${tag(item.state)}</h3><div class="sub"><span>${escape(item.project)}</span><span>${escape(when(item.startedAt))}</span><span>${item.count} steps</span>${item.prUrl ? `<span><a href="${escape(item.prUrl)}">${short(item.prUrl)}</a></span>` : ''}</div>${ticker(item.steps, item.jobId, true)}</div>`).join('') || '<p class="empty">No reported steps yet.</p>'}</section></div></main>`;
  return page(`${member.name} · ${member.title}`, body, 10_000);
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
        if (!['/actions', '/chat'].includes(url.pathname)) return reply(404, 'text/plain', 'Not found');
        if (!sameOrigin(req)) { req.resume(); return reply(403, 'text/plain', 'Actions are accepted from the dashboard page only'); }
        let size = 0; const chunks = [];
        for await (const chunk of req) { size += chunk.length; if (size > 16384) return reply(413, 'text/plain', 'Too large'); chunks.push(chunk); }
        const form = new URLSearchParams(Buffer.concat(chunks).toString());
        const current = await state();
        const project = current.overview.find(p => p.project === form.get('project'));
        if (url.pathname === '/chat') {
          const role = form.get('role'); const issue = (form.get('issue') || project?.inbox || '').trim();
          const back = text => { res.writeHead(303, { location: `/team/${encodeURIComponent(role ?? '')}?project=${encodeURIComponent(project?.project ?? '')}&issue=${encodeURIComponent(issue)}&${text.error ? 'error' : 'ok'}=${encodeURIComponent(text.text)}` }); res.end(); };
          if (!Object.hasOwn(ROSTER, role) || !project) return back({ error: true, text: 'Choose a team member and a project.' });
          try {
            await request('/jobs', { projectId: project.project, kind: 'chat', role, issue, message: form.get('message') ?? '' });
            return back({ text: project.online ? `Sent to ${ROSTER[role].name} on ${issue}.` : `Queued for ${ROSTER[role].name} on ${issue}; it is delivered when a worker for ${project.name} is online.` });
          } catch (error) { return back({ error: true, text: `Not sent: ${error.message}` }); }
        }
        const back = flash => { res.writeHead(303, { location: `/?${flash.error ? 'error' : 'ok'}=${encodeURIComponent(flash.text)}` }); res.end(); };
        if (!project) return back({ error: true, text: 'Unknown project.' });
        try {
          if (form.get('action') === 'ideate') {
            if (!project.ideation) return back({ error: true, text: `${project.name} has no ideation configuration.` });
            if (project.ideation.blockedBy && project.ideation.blockedBy !== 'cooldown') return back({ error: true, text: `Ideation for ${project.name} is waiting on: ${project.ideation.blockedBy}.` });
            const manifest = (await request('/projects')).find(p => p.id === project.project)?.manifest ?? {};
            const base = typeof manifest.delivery?.baseBranch === 'string' ? { base: `origin/${manifest.delivery.baseBranch}`, fetch: true } : {};
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
        const file = path.join(config.portraits ?? PORTRAITS, `${portrait[1]}.webp`);
        if (!Object.hasOwn(ROSTER, portrait[1]) || !fs.existsSync(file)) return reply(404, 'text/plain', 'Not found');
        res.writeHead(200, { 'content-type': 'image/webp', 'cache-control': 'public, max-age=3600' }); return res.end(fs.readFileSync(file));
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
      const runMatch = /^\/runs\/([a-f0-9-]{36})$/.exec(url.pathname);
      if (runMatch) {
        let detail;
        try { detail = await request(`/jobs/${runMatch[1]}/evidence`); } catch { return reply(404, 'text/plain', 'No evidence reported for that job'); }
        if (url.searchParams.get('format') === 'json') return reply(200, 'application/json', JSON.stringify(detail));
        return reply(200, 'text/html; charset=utf-8', renderRun(detail));
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
  if (!validBind(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Use a loopback or Tailscale IPv4 bind address and valid port');
  let coordinatorUrl = config.coordinatorUrl;
  if (!coordinatorUrl && config.worker) coordinatorUrl = JSON.parse(fs.readFileSync(config.worker, 'utf8')).coordinatorUrl;
  if (typeof coordinatorUrl !== 'string') throw new Error('dashboard.json needs coordinatorUrl (or a worker config that has one)');
  const password = env.AGENT_TEAM_DASHBOARD_PASSWORD;
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) && (typeof password !== 'string' || password.length < 12)) throw new Error('A public bind requires AGENT_TEAM_DASHBOARD_PASSWORD of at least 12 characters');
  return { host, port, coordinatorUrl, token: localToken(env), password: password || null, hostname: env.FLY_APP_NAME ?? config.hostname ?? 'local' };
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
