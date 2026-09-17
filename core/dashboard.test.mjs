import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createQueue } from './queue.mjs';
import { collectState, createDashboardServer, loadConfig, renderIndex } from './dashboard.mjs';

const MARKER = '<script>alert("summary")</script>';
const steps = [{ scope: 'coordinator', kind: 'text', member: null, text: 'Reading the manifest first.' }, { scope: 'coordinator', kind: 'tool', member: null, text: 'Agent → team-pm: Claim FUM-1' }, { scope: 'subagent', kind: 'tool', member: 'team-pm', text: 'Bash: npm test' }];
const usage = { status: 'allowed', fiveHour: { utilization: 0.15, resetsAt: 1789555200 }, sevenDay: { utilization: 0.4, resetsAt: 1790000000 } };

// A queue-backed coordinator fed the way workers feed it: manifests, jobs and evidence.
function fixture(t) {
  const q = createQueue(':memory:', { projects: { myntbase: { repository: 'o/r' } } }); t.after(() => q.close());
  q.registerProject('myntbase', { workerId: 'x3d', manifest: { name: 'Myntbase', ownerInboxIssue: 'FUM-10', ideation: { enabled: true, backlogCap: 10, batchSize: 3, minimumIntervalHours: 24 }, delivery: { baseBranch: 'master' } } });
  const done = q.enqueue({ projectId: 'myntbase', issue: 'FUM-1', publish: true, autoMerge: true, engine: 'claude' });
  let job = q.claim({ workerId: 'x3d', projectIds: ['myntbase'] });
  q.evidence(job.id, { workerId: 'x3d', leaseToken: job.leaseToken, evidence: { run: { project: 'myntbase', id: '2026-09-16T06-00-00-000Z-aaaaaaaa', state: 'ready', engine: 'claude', issue: 'FUM-1', prUrl: 'https://github.com/o/r/pull/1', delivery: 'merged', startedAt: '2026-09-16T06:00:00.000Z', finishedAt: '2026-09-16T06:10:00.000Z', baseCommit: 'abcdef12', summary: MARKER }, steps, members: { 'team-pm': 1 }, active: 'team-pm', usage, engineResult: { subtype: 'success', isError: false, durationMs: 120000, turns: 7 }, tokens: 0, summary: `# run\n${MARKER}`, stderr: '' } });
  q.complete(job.id, { workerId: 'x3d', leaseToken: job.leaseToken, result: { outcome: 'ready', summary: 'Runner ready' } });
  const held = q.enqueue({ projectId: 'myntbase', issue: 'FUM-2', publish: true });
  job = q.claim({ workerId: 'x3d', projectIds: ['myntbase'] });
  q.evidence(job.id, { workerId: 'x3d', leaseToken: job.leaseToken, evidence: { run: { project: 'myntbase', id: '2026-09-16T07-00-00-000Z-bbbbbbbb', state: 'running', engine: 'opencode', issue: 'FUM-2', startedAt: new Date(Date.now() - 600_000).toISOString() }, steps, members: { 'team-pm': 1 }, active: 'team-pm', usage: null, tokens: 25000, summary: '' } });
  q.fail(job.id, { workerId: 'x3d', leaseToken: job.leaseToken, result: { outcome: 'blocked', summary: `blocked ${MARKER}` } });
  const chat = q.enqueue({ projectId: 'myntbase', kind: 'chat', role: 'team-pm', issue: 'FUM-10', message: 'Status?' });
  const chatJob = q.claim({ workerId: 'x3d', projectIds: ['myntbase'], kinds: ['chat'] });
  q.complete(chatJob.id, { workerId: 'x3d', leaseToken: chatJob.leaseToken, result: { outcome: 'ready', summary: 'All good, nothing blocks FUM-2.' } });
  const request = async (route, body) => {
    const url = new URL(route, 'http://x');
    if (body === undefined) {
      if (url.pathname === '/jobs') return q.list();
      if (url.pathname === '/projects') return q.projectsList();
      if (url.pathname === '/evidence') return q.evidenceList({ limit: Number(url.searchParams.get('limit') ?? 40) });
      const m = /^\/jobs\/([^/]+)\/evidence$/.exec(url.pathname); if (m) { const e = q.evidenceFor(m[1]); if (!e) throw new Error('404'); return e; }
      const ev = /^\/jobs\/([^/]+)\/events$/.exec(url.pathname); if (ev) return q.eventsAfter(ev[1], { after: Number(url.searchParams.get('after') ?? 0), limit: Number(url.searchParams.get('limit') ?? 500) });
      throw new Error('unknown route');
    }
    if (url.pathname === '/jobs') return q.enqueue(body);
    const m = /^\/jobs\/([^/]+)\/(requeue|cancel)$/.exec(url.pathname); if (m) return q[m[2]](m[1], body);
    throw new Error('unknown write');
  };
  return { q, request, done, held, chat, leaseToken: job.leaseToken };
}

test('state derives projects, team, runs, usage and quarantine from the coordinator only', async t => {
  const f = fixture(t);
  const state = await collectState({ request: f.request });
  assert.deepEqual(state.overview.map(p => [p.project, p.name, p.status, p.online, p.held.length, p.delivered?.issue, p.ideation?.blockedBy]), [['myntbase', 'Myntbase', 'on hold', true, 1, 'FUM-1', 'held job']]);
  assert.deepEqual(state.quarantined, ['myntbase']);
  assert.equal(state.usage.sevenDay.utilization, 0.4);
  assert.equal(state.tokens.day, 25000);
  assert.equal(state.live.length, 0, 'a blocked job is not live even if its last report said running');
  assert.equal(state.jobs.find(job => job.kind === 'chat').summary, 'All good, nothing blocks FUM-2.');
  assert.ok(!JSON.stringify(state).includes(f.leaseToken));
});

test('pages escape content, serve portraits and evidence, and require same-origin for writes', async t => {
  const f = fixture(t);
  const server = createDashboardServer({ request: f.request, hostname: 'test' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const html = await (await fetch(base + '/')).text();
  assert.ok(!html.includes(MARKER) && html.includes('&lt;script&gt;') && html.includes('on hold') && html.includes('15% used') && html.includes('Release and rerun') && html.includes('25k') && html.includes('x3d for Myntbase'));
  assert.equal((await fetch(base + '/portraits/team-pm.webp')).headers.get('content-type'), 'image/webp');
  for (const bad of ['/portraits/team-nobody.webp', '/portraits/../roster.mjs', '/runs/not-a-uuid', `/runs/${'0'.repeat(36)}`]) assert.equal((await fetch(base + bad)).status, 404);
  const run = await (await fetch(`${base}/runs/${f.done.id}`)).text();
  assert.ok(run.includes('7 turns') && run.includes('&lt;script&gt;') && run.includes('Jeff'));
  assert.equal((await fetch(base + '/', { method: 'PUT' })).status, 405);
  const post = (path, body, headers = { 'sec-fetch-site': 'same-origin' }) => fetch(base + path, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(body).toString() });
  assert.equal((await post('/actions', { action: 'ideate', project: 'myntbase' }, { 'sec-fetch-site': 'cross-site' })).status, 403);
  let response = await post('/actions', { action: 'ideate', project: 'myntbase' });
  assert.match(decodeURIComponent(response.headers.get('location')), /waiting on: held job/);
  response = await post('/actions', { action: 'requeue', project: 'myntbase', job: f.held.id });
  assert.match(decodeURIComponent(response.headers.get('location')), /queued again/);
  assert.equal(f.q.list().find(job => job.id === f.held.id).state, 'queued');
  assert.ok(renderIndex({ generatedAt: new Date().toISOString(), overview: [], team: [], jobs: [], runs: [], live: [], usage: null, tokens: { day: 0, week: 0, lastRun: null, engines: [] }, quarantined: [], decisions: [] }).includes('No projects registered'));
});

test('member pages show the conversation as chat jobs and queue new messages', async t => {
  const f = fixture(t);
  const server = createDashboardServer({ request: f.request });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await (await fetch(base + '/team/team-pm')).text();
  assert.ok(page.includes('Jeff') && page.includes('Relentless') && page.includes('Status?') && page.includes('All good, nothing blocks FUM-2.') && page.includes('Send to Jeff') && page.includes('FUM-10'));
  assert.equal((await fetch(base + '/team/team-nobody')).status, 404);
  const response = await fetch(base + '/chat', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' }, body: new URLSearchParams({ role: 'team-dev', project: 'myntbase', issue: 'FUM-10', message: 'Gandalf?' }).toString() });
  assert.equal(response.status, 303); assert.match(decodeURIComponent(response.headers.get('location')), /Sent to Gandalf on FUM-10/);
  const queued = f.q.list().find(job => job.kind === 'chat' && job.role === 'team-dev');
  assert.equal(queued.state, 'queued'); assert.equal(queued.message, 'Gandalf?');
  const asJson = await fetch(base + '/chat', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin', accept: 'application/json' }, body: new URLSearchParams({ role: 'team-ux', project: 'myntbase', issue: 'FUM-10', message: 'Rams, voice test' }).toString() });
  const spoken = await asJson.json();
  assert.equal(asJson.status, 200); assert.ok(/^[a-f0-9-]{36}$/.test(spoken.jobId)); assert.equal(spoken.online, true);
  assert.ok(page.includes('id="talk"') && page.includes('nb-NO'));
  const bad = await fetch(base + '/chat', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' }, body: 'role=team-dev&project=myntbase&issue=nope&message=x' });
  assert.match(decodeURIComponent(bad.headers.get('location')), /Not sent/);
});

test('basic auth guards every route when a password is configured', async t => {
  const f = fixture(t);
  const server = createDashboardServer({ request: f.request, password: 'correct horse battery' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const anonymous = await fetch(base + '/');
  assert.equal(anonymous.status, 401); assert.match(anonymous.headers.get('www-authenticate'), /Basic/);
  assert.equal((await fetch(base + '/portraits/team-pm.webp', { headers: { authorization: `Basic ${Buffer.from('owner:wrong password').toString('base64')}` } })).status, 401);
  assert.equal((await fetch(base + '/health', { headers: { authorization: `Basic ${Buffer.from('owner:correct horse battery').toString('base64')}` } })).status, 200);
});

test('configuration takes a coordinator URL or borrows it from a worker config and demands a password for public binds', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dashboard-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'worker.json'), JSON.stringify({ coordinatorUrl: 'https://team.example:8443', projects: {} }));
  writeFileSync(path.join(dir, 'dashboard.json'), JSON.stringify({ worker: path.join(dir, 'worker.json') }));
  const env = { HOME: dir, AGENT_TEAM_TOKEN: 'synthetic-token-with-24-chars!' };
  assert.deepEqual(loadConfig(path.join(dir, 'dashboard.json'), env), { host: '127.0.0.1', port: 4311, coordinatorUrl: 'https://team.example:8443', token: env.AGENT_TEAM_TOKEN, password: null, hostname: 'local' });
  writeFileSync(path.join(dir, 'dashboard.json'), JSON.stringify({ host: '0.0.0.0', coordinatorUrl: 'http://127.0.0.1:4310' }));
  assert.throws(() => loadConfig(path.join(dir, 'dashboard.json'), env), /loopback or private-network/);
  process.env.AGENT_TEAM_PUBLIC_BIND = '1';
  try {
    assert.throws(() => loadConfig(path.join(dir, 'dashboard.json'), env), /requires AGENT_TEAM_DASHBOARD_PASSWORD/);
    const config = loadConfig(path.join(dir, 'dashboard.json'), { ...env, AGENT_TEAM_DASHBOARD_PASSWORD: 'long enough password', AGENT_TEAM_HOSTNAME: 'agent-team' });
    assert.equal(config.password, 'long enough password'); assert.equal(config.hostname, 'agent-team');
  } finally { delete process.env.AGENT_TEAM_PUBLIC_BIND; }
  mkdirSync(path.join(dir, 'unused'));
});

test('the stream endpoint relays formatted steps as server-sent events and closes when the job ends', async t => {
  const f = fixture(t);
  f.q.requeue(f.held.id);
  const claimed = f.q.claim({ workerId: 'x3d', projectIds: ['myntbase'] }); const job = claimed;
  f.q.appendEvents(claimed.id, { workerId: 'x3d', leaseToken: claimed.leaseToken, events: [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Agent', input: { subagent_type: 'team-tester', description: 'Verify' } }] } }),
    JSON.stringify({ type: 'assistant', parent_tool_use_id: 't1', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } }),
    JSON.stringify({ type: 'user', parent_tool_use_id: 't1', message: { content: [{ type: 'tool_result', content: '8 passing' }] } })] });
  const server = createDashboardServer({ request: f.request });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/runs/${job.id}/stream`);
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const reader = response.body.getReader(); let text = '';
  while (!text.includes('event: steps')) { const { value, done } = await reader.read(); if (done) break; text += Buffer.from(value).toString(); }
  const payload = JSON.parse(text.split('event: steps')[1].split('data: ')[1].split('\n')[0]);
  assert.equal(payload.after, 3);
  assert.deepEqual(payload.steps.map(step => [step.kind, step.member, step.text]), [['tool', null, 'Agent → team-tester: Verify'], ['tool', 'team-tester', 'Bash: npm test'], ['result', 'team-tester', '8 passing']]);
  f.q.complete(claimed.id, { workerId: 'x3d', leaseToken: claimed.leaseToken, result: { outcome: 'ready', summary: 'ok' } });
  while (!text.includes('event: done')) { const { value, done } = await reader.read(); if (done) break; text += Buffer.from(value).toString(); }
  assert.ok(text.includes('"reason":"completed"'));
  const page = await (await fetch(`http://127.0.0.1:${server.address().port}/team/team-tester`)).text();
  assert.ok(page.includes('Joker'));
});
