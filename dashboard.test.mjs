import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createQueue } from './queue.mjs';
import { collectState, createDashboardServer, eventSteps, loadConfig, renderIndex, runDetail } from './dashboard.mjs';

const MARKER = '<script>alert("summary")</script>';
const events = [
  { type: 'system', subtype: 'init' },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Reading the manifest first.' }, { type: 'tool_use', id: 'toolu_1', name: 'Agent', input: { subagent_type: 'team-pm', description: 'Claim FUM-1', prompt: 'private prompt text' } }] } },
  { type: 'assistant', parent_tool_use_id: 'toolu_1', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test -- x.unit.test.ts' } }] } },
  { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.15, resetsAt: 1789555200 }, seven_day: { utilization: 0.4, resetsAt: 1790000000 } } } },
  { type: 'result', subtype: 'success', is_error: false, duration_ms: 120000, num_turns: 7 },
].map(event => JSON.stringify(event)).join('\n') + '\n';
const opencodeEvents = [
  { type: 'text', part: { text: 'Claiming FUM-9 now.' } },
  { type: 'tool_use', part: { tool: 'bash', state: { input: { command: 'npm run typecheck:web', description: 'Typecheck web' } } } },
  { type: 'step_finish', part: { tokens: { total: 24000 } } },
  { type: 'step_finish', part: { tokens: { total: 1000 } } },
].map(event => JSON.stringify(event)).join('\n') + '\n';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dashboard-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = path.join(root, 'checkout'); const runs = path.join(checkout, '.agent-team', 'runs');
  const write = (id, journal, stream = events) => {
    mkdirSync(path.join(runs, id), { recursive: true });
    writeFileSync(path.join(runs, id, 'journal.json'), JSON.stringify(journal));
    writeFileSync(path.join(runs, id, 'events.jsonl'), stream);
    writeFileSync(path.join(runs, id, 'summary.md'), `# Agent run ${id}\n${MARKER}`);
  };
  write('2026-09-16T06-00-00-000Z-aaaaaaaa', { id: 'a', state: 'ready', engine: 'claude', issue: 'FUM-1', prUrl: 'https://github.com/o/r/pull/1', delivery: { state: 'merged' }, startedAt: '2026-09-16T06:00:00.000Z', finishedAt: '2026-09-16T06:10:00.000Z', baseCommit: 'abcdef1234567890', summary: MARKER });
  write('2026-09-16T07-00-00-000Z-bbbbbbbb', { id: 'b', state: 'running', engine: 'claude', options: { issue: 'FUM-2' }, worktree: '/wt/run-b', startedAt: '2026-09-16T07:00:00.000Z' });
  write('2026-09-16T05-00-00-000Z-cccccccc', { id: 'c', state: 'ready', engine: 'opencode', issue: 'FUM-9', startedAt: new Date(Date.now() - 3600_000).toISOString(), finishedAt: new Date().toISOString() }, opencodeEvents);
  mkdirSync(path.join(runs, 'not-a-run-id'));
  writeFileSync(path.join(checkout, '.agent-team.json'), JSON.stringify({ name: 'Myntbase', ideation: { enabled: true, backlogCap: 10, batchSize: 3, minimumIntervalHours: 24 } }));
  const dbPath = path.join(root, 'queue.sqlite');
  const q = createQueue(dbPath, { projects: { myntbase: {} } });
  q.enqueue({ projectId: 'myntbase', issue: 'FUM-1', publish: true, autoMerge: true, engine: 'claude' });
  const job = q.claim({ workerId: 'x3d', projectIds: ['myntbase'] });
  q.fail(job.id, { workerId: 'x3d', leaseToken: job.leaseToken, result: { outcome: 'blocked', summary: `blocked ${MARKER}` } });
  q.close();
  const systemctl = unit => unit.endsWith('intake') ? 'inactive' : 'active';
  return { root, checkout, dbPath, systemctl, projects: { myntbase: checkout }, leaseToken: job.leaseToken };
}

test('event steps summarize coordinator and subagent activity, usage and engine result without prompts', () => {
  const parsed = eventSteps(events);
  assert.deepEqual(parsed.steps.map(step => [step.scope, step.kind]), [['coordinator', 'text'], ['coordinator', 'tool'], ['subagent', 'tool']]);
  assert.equal(parsed.steps[1].text, 'Agent → team-pm: Claim FUM-1');
  assert.equal(parsed.steps[2].member, 'team-pm'); assert.equal(parsed.active, 'team-pm'); assert.deepEqual(parsed.members, { 'team-pm': 1 });
  assert.ok(!JSON.stringify(parsed).includes('private prompt text'));
  assert.equal(parsed.usage.fiveHour.utilization, 0.15);
  assert.deepEqual(parsed.engineResult, { subtype: 'success', isError: false, durationMs: 120000, turns: 7 });
  assert.deepEqual(eventSteps('garbage\n{"type":"x"}\n'), { steps: [], usage: null, engineResult: null, tokens: 0, members: {}, active: null });
  const oc = eventSteps(opencodeEvents);
  assert.deepEqual(oc.steps.map(step => step.text), ['Claiming FUM-9 now.', 'bash: Typecheck web']); assert.equal(oc.tokens, 25000);
  assert.equal(eventSteps(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/wt/run-b/src/a.ts' } }] } }), 5, '/wt/run-b').steps[0].text, 'Read: src/a.ts');
});

test('state aggregates services, queue, runs, live steps, usage and quarantine without lease tokens', t => {
  const f = fixture(t);
  const state = collectState({ dbPath: f.dbPath, projects: f.projects, systemctl: f.systemctl });
  assert.deepEqual(state.services, { 'agent-team-coordinator': 'active', 'agent-team-worker': 'active', 'agent-team-intake': 'inactive' });
  assert.equal(state.jobs.length, 1); assert.equal(state.jobs[0].state, 'blocked'); assert.equal(state.jobs[0].engine, 'claude');
  assert.deepEqual(state.quarantined, ['myntbase']);
  assert.deepEqual(state.overview.map(p => [p.project, p.name, p.status, p.held.length, p.delivered?.issue, p.ideation?.blockedBy]), [['myntbase', 'Myntbase', 'on hold', 1, 'FUM-1', 'held job']]);
  assert.deepEqual(state.runs.map(run => run.state).sort(), ['ready', 'ready', 'running']);
  const merged = state.runs.find(run => run.issue === 'FUM-1'); assert.equal(merged.delivery, 'merged'); assert.equal(merged.baseCommit, 'abcdef12');
  assert.equal(state.openai.day, 25000); assert.equal(state.openai.week, 25000); assert.equal(state.openai.lastRun.project, 'myntbase');
  assert.equal(state.live.length, 1); assert.equal(state.live[0].steps.length, 3); assert.equal(state.live[0].issue, 'FUM-2');
  assert.equal(state.overview[0].running.issue, 'FUM-2');
  assert.equal(state.usage.sevenDay.utilization, 0.4);
  const jeff = state.team.find(m => m.role === 'team-pm'); assert.equal(jeff.name, 'Jeff'); assert.equal(jeff.working.issue, 'FUM-2'); assert.equal(jeff.steps, 1);
  assert.equal(state.team.find(m => m.role === 'team-dev').working, null);
  assert.ok(!JSON.stringify(state).includes(f.leaseToken));
  assert.deepEqual(collectState({ dbPath: path.join(f.root, 'missing.sqlite'), projects: { other: path.join(f.root, 'nowhere') }, systemctl: () => 'unknown' }).jobs, []);
});

test('run detail validates project and id and refuses traversal', t => {
  const f = fixture(t);
  const detail = runDetail({ projects: f.projects, project: 'myntbase', id: '2026-09-16T06-00-00-000Z-aaaaaaaa' });
  assert.equal(detail.run.state, 'ready'); assert.ok(detail.summary.includes(MARKER)); assert.equal(detail.steps.length, 3);
  for (const [project, id] of [['other', '2026-09-16T06-00-00-000Z-aaaaaaaa'], ['myntbase', '../../checkout'], ['myntbase', 'not-a-run-id'], ['myntbase', '2026-09-16T06-00-00-000Z-zzzzzzzz']]) assert.equal(runDetail({ projects: f.projects, project, id }), null);
});

test('HTTP pages escape content, serve JSON, and reject writes and unknown paths', async t => {
  const f = fixture(t);
  const server = createDashboardServer({ db: f.dbPath, projects: f.projects, systemctl: f.systemctl });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const index = await fetch(base + '/'); const html = await index.text();
  assert.equal(index.status, 200); assert.ok(!html.includes(MARKER)); assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('on hold') && html.includes('15% used') && html.includes('Agent → team-pm') && html.includes('Release and rerun') && html.includes('25k') && html.includes('release the held job first') && html.includes('Jeff') && html.includes('<b>Jeff</b> Bash'));
  const api = await (await fetch(base + '/api/state')).json();
  assert.equal(api.jobs[0].outcome, 'blocked');
  const run = await fetch(base + '/runs/myntbase/2026-09-16T06-00-00-000Z-aaaaaaaa');
  assert.equal(run.status, 200); assert.ok((await run.text()).includes('7 turns'));
  const json = await (await fetch(base + '/runs/myntbase/2026-09-16T06-00-00-000Z-aaaaaaaa?format=json')).json();
  assert.equal(json.run.issue, 'FUM-1');
  assert.equal((await fetch(base + '/runs/myntbase/..%2F..%2Fx')).status, 404);
  assert.equal((await fetch(base + '/runs/other/2026-09-16T06-00-00-000Z-aaaaaaaa')).status, 404);
  assert.equal((await fetch(base + '/', { method: 'POST' })).status, 404);
  assert.equal((await fetch(base + '/', { method: 'PUT' })).status, 405);
  assert.ok(renderIndex({ generatedAt: new Date().toISOString(), services: {}, overview: [], team: [], jobs: [], runs: [], live: [], usage: null, openai: { day: 0, week: 0, lastRun: null }, quarantined: [], defaultEngine: 'claude' }).includes('No jobs yet'));
});

test('configuration resolves the coordinator database and worker projects and validates the bind', t => {
  const f = fixture(t);
  const dir = path.join(f.root, 'config'); mkdirSync(dir);
  writeFileSync(path.join(dir, 'coordinator.json'), JSON.stringify({ db: f.dbPath, projects: { myntbase: {} } }));
  writeFileSync(path.join(dir, 'worker.json'), JSON.stringify({ workerId: 'x3d', projects: f.projects, stateDir: '/tmp/state' }));
  writeFileSync(path.join(dir, 'dashboard.json'), JSON.stringify({ port: 4311, coordinator: path.join(dir, 'coordinator.json'), worker: path.join(dir, 'worker.json') }));
  const config = loadConfig(path.join(dir, 'dashboard.json'));
  assert.deepEqual({ ...config, token: undefined }, { host: '127.0.0.1', port: 4311, db: f.dbPath, projects: f.projects, stateDir: '/tmp/state', defaultEngine: 'opencode', coordinatorUrl: 'http://127.0.0.1:4310', token: undefined, base: {} });
  writeFileSync(path.join(dir, 'dashboard.json'), JSON.stringify({ host: '0.0.0.0', coordinator: path.join(dir, 'coordinator.json'), worker: path.join(dir, 'worker.json') }));
  assert.throws(() => loadConfig(path.join(dir, 'dashboard.json')), /loopback or Tailscale/);
});

test('actions queue ideation or requeue a held job only from the page itself', async t => {
  const f = fixture(t); const calls = [];
  const enqueue = async (route, body) => { calls.push([route, body]); return { id: 'job-new' }; };
  const server = createDashboardServer({ db: f.dbPath, projects: f.projects, systemctl: f.systemctl, enqueue, base: { myntbase: { base: 'origin/master', fetch: true } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, headers = { 'sec-fetch-site': 'same-origin' }) => fetch(base + '/actions', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(body).toString() });
  assert.equal((await post({ action: 'ideate', project: 'myntbase' }, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await post({ action: 'ideate', project: 'myntbase' }, { origin: 'http://evil.invalid' })).status, 403);
  let response = await post({ action: 'ideate', project: 'myntbase' });
  assert.equal(response.status, 303); assert.match(decodeURIComponent(response.headers.get('location')), /waiting on: held job/);
  assert.equal(calls.length, 0);
  const held = (await (await fetch(base + '/api/state')).json()).jobs[0];
  response = await post({ action: 'requeue', project: 'myntbase', job: held.id });
  assert.match(decodeURIComponent(response.headers.get('location')), /queued again/);
  assert.deepEqual(calls, [[`/jobs/${held.id}/requeue`, {}]]);
  const page = await (await fetch(base + '/?ok=Queued%20ideation')).text();
  assert.ok(page.includes('class="flash "') && page.includes('Queued ideation'));
});
