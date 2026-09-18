import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueue } from './queue.mjs';
import { createDashboardServer, environmentFromForm, renderEnvironment, renderTeam, renderTeams, teamFromForm } from './dashboard.mjs';

// A request function over a real queue for the store routes the dashboard uses.
function requestFor(q) {
  return async (route, body) => {
    const url = new URL(route, 'http://x');
    const store = /^\/(teams|environments)(?:\/([a-z][a-z0-9-]*)(?:\/(history|revert))?)?$/.exec(url.pathname);
    if (store) {
      const [, kind, id, what] = store; const single = kind === 'teams' ? 'Team' : 'Environment';
      if (body === undefined) { if (!id) return q[kind](); if (what === 'history') return q[`${single.toLowerCase()}History`](id); return q[single.toLowerCase()](id); }
      return what === 'revert' ? q[`revert${single}`](id, body) : q[`save${single}`](id, body);
    }
    if (url.pathname === '/jobs') return q.list(); if (url.pathname === '/projects') return q.projectsList(); if (url.pathname === '/evidence') return q.evidenceList({ limit: 10 });
    if (url.pathname === '/roster') return q.roster();
    throw new Error(`unknown ${route}`);
  };
}

test('team and environment pages render, and their forms round-trip into store documents', async t => {
  const q = createQueue(':memory:', { projects: { a: {} } }); t.after(() => q.close());
  const server = createDashboardServer({ coordinatorUrl: 'http://x', token: 'x'.repeat(24), request: requestFor(q) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const list = await (await fetch(`${base}/teams`)).text();
  assert.match(list, /Delivery team/); assert.match(list, /research-desk/);
  const page = await (await fetch(`${base}/teams/research-desk`)).text();
  assert.match(page, /name="team-researcher\.prompt"/); assert.match(page, /value="Ada"/); assert.match(page, /no bash/);
  assert.match(await (await fetch(`${base}/environments`)).text(), /Headless browser/);
  assert.match(await (await fetch(`${base}/environments/browser`)).text(), /name="capabilities" value="browser" checked/);
  assert.match(await (await fetch(`${base}/environments/new-one`)).text(), /new environment/);
  // Save through the form: rename the researcher, add an analyst, and see version 2 with a history row.
  const team = q.team('research-desk');
  const form = new URLSearchParams({ name: 'Desk', description: 'd', note: 'edited' });
  for (const role of Object.keys(team.agents)) { form.append('role', role); for (const key of ['name', 'title', 'voice']) form.append(`${role}.${key}`, team.roster[role][key]); form.append(`${role}.mode`, team.agents[role].mode); form.append(`${role}.description`, team.agents[role].description); form.append(`${role}.prompt`, team.agents[role].prompt); }
  form.set('team-researcher.name', 'Grace'); form.append('team-writer.deny', 'edit');
  form.append('defaultRoles', 'team-researcher');
  form.set('newRole', 'team-analyst'); form.set('newName', 'Nia'); form.set('newTitle', 'analyst'); form.set('newVoice', 'numbers first'); form.set('newPrompt', 'Analyse');
  const response = await fetch(`${base}/teams/research-desk`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' }, body: form.toString(), redirect: 'manual' });
  assert.equal(response.status, 303); assert.match(decodeURIComponent(response.headers.get('location')), /Saved version 2/);
  const saved = q.team('research-desk');
  assert.equal(saved.roster['team-researcher'].name, 'Grace'); assert.equal(saved.roster['team-analyst'].name, 'Nia');
  assert.deepEqual(saved.agents['team-writer'].deny, ['edit']); assert.deepEqual(saved.defaultRoles, ['team-researcher']);
  assert.equal(saved.name, 'Desk');
  const revert = await fetch(`${base}/teams/research-desk`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' }, body: 'action=revert&version=1', redirect: 'manual' });
  assert.match(decodeURIComponent(revert.headers.get('location')), /now version 3/);
  assert.equal(q.team('research-desk').roster['team-researcher'].name, 'Ada');
  const envForm = new URLSearchParams({ name: 'UI', capabilities: 'browser', 'launcher.instanceType': 'c6i.xlarge', packages: 'ffmpeg  imagemagick' });
  assert.deepEqual(environmentFromForm(envForm, 'ui'), { id: 'ui', name: 'UI', description: '', capabilities: ['browser'], launcher: { instanceType: 'c6i.xlarge' }, packages: ['ffmpeg', 'imagemagick'] });
  const bad = await fetch(`${base}/environments/ui`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' }, body: 'name=UI&capabilities=gpu', redirect: 'manual' });
  assert.match(decodeURIComponent(bad.headers.get('location')), /refused/);
  assert.equal((await fetch(`${base}/teams/research-desk`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://evil' }, body: form.toString(), redirect: 'manual' })).status, 403);
  assert.equal(teamFromForm(new URLSearchParams({ role: 'team-pm', 'team-pm.mode': 'subagent', remove: 'team-pm' }), 'x').agents['team-pm'], undefined);
  assert.match(renderTeams({ teams: [], flash: null }), /No teams stored yet/);
  assert.match(renderTeam({ team: null, id: 'fresh', history: [], flash: null }), /new team/);
  assert.match(renderEnvironment({ environment: null, id: 'e', history: [], flash: { error: true, text: 'x<y' } }), /x&lt;y/);
});
