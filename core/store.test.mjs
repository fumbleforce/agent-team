import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createQueue, createQueueServer } from './queue.mjs';

const projects = { a: {}, b: {} };
const manifest = { version: 2, name: 'A', instructions: [], tracker: { kind: 'linear', workspaceId: 'w', workspaceUrl: 'https://t/w', teamId: 't', projectId: 'p', projectUrl: 'https://t/p', readyLabel: 'agent:ready' } };

test('teams and environments are seeded once, versioned on save, and revertible', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'team-store-')); const dbPath = path.join(dir, 'queue.sqlite');
  let q = createQueue(dbPath, { projects, environments: [{ id: 'gpu', name: 'GPU', capabilities: ['docker'], launcher: { instanceType: 'g5.xlarge' } }] });
  try {
    assert.deepEqual(q.teams().map(team => team.id), ['default', 'research-desk']);
    assert.deepEqual(q.environments().map(item => item.id), ['standard', 'browser', 'full', 'gpu']);
    assert.equal(q.team('default').version, 1); assert.equal(q.team('default').author, 'toolkit');
    const doc = { ...q.team('default'), name: 'Renamed', roster: { ...q.team('default').roster, 'team-dev': { name: 'Merlin', title: 'developer', voice: 'quiet' } } };
    delete doc.version; delete doc.author; delete doc.updatedAt;
    const saved = q.saveTeam('default', { doc, author: 'owner', note: 'rename' });
    assert.equal(saved.version, 2); assert.equal(saved.roster['team-dev'].name, 'Merlin');
    assert.throws(() => q.saveTeam('default', { doc: { ...doc, agents: {} }, author: 'owner' }), /must include team-coordinator/);
    assert.throws(() => q.saveTeam('Bad', { doc, author: 'owner' }), /Invalid team id/);
    assert.throws(() => q.saveTeam('default', { doc, author: 'owner', extra: 1 }));
    q.close();
    q = createQueue(dbPath, { projects });
    assert.equal(q.team('default').version, 2, 'seeding never overwrites a stored team');
    assert.deepEqual(q.teamHistory('default').map(entry => [entry.version, entry.note]), [[2, 'rename'], [1, 'seeded']]);
    const reverted = q.revertTeam('default', { version: 1, author: 'owner' });
    assert.equal(reverted.version, 3); assert.equal(reverted.roster['team-dev'].name, 'Gandalf');
    assert.throws(() => q.revertTeam('default', { version: 9, author: 'owner' }), /Not found/);
    assert.throws(() => q.team('nope'), /Not found/);
    const env = q.saveEnvironment('ui', { doc: { name: 'UI', capabilities: ['browser'] }, author: 'owner' });
    assert.equal(env.version, 1); assert.deepEqual(env.capabilities, ['browser']);
    assert.throws(() => q.saveEnvironment('ui', { doc: { name: 'UI', capabilities: ['gpu'] }, author: 'owner' }), /capabilities/);
    assert.equal(q.environmentHistory('ui').length, 1);
  } finally { q.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a project resolves its team and environment from manifest and settings, and chat accepts any stored role', () => {
  const q = createQueue(':memory:', { projects });
  try {
    q.registerProject('a', { workerId: 'w', manifest });
    let team = q.projectTeam('a');
    assert.equal(team.id, 'default'); assert.deepEqual(team.roles, ['team-dev', 'team-tester']);
    assert.equal(q.projectEnvironment('a').id, 'standard');
    q.saveSettings('a', { overrides: { team: { blueprint: 'research-desk', roles: null }, worker: { environment: 'browser' } }, author: 'owner' });
    team = q.projectTeam('a');
    assert.equal(team.id, 'research-desk'); assert.equal(team.roles, null, 'null keeps every subagent');
    assert.equal(q.projectEnvironment('a').id, 'browser');
    q.saveSettings('a', { overrides: { team: { blueprint: 'research-desk' } }, author: 'owner' });
    assert.deepEqual(q.projectTeam('a').roles, ['team-researcher', 'team-writer', 'team-editor'], 'unset roles fall back to the team default');
    const shared = q.projectShared('a', { agent: { 'team-coordinator': { mode: 'primary', permission: { bash: 'x' } }, 'team-pm': { mode: 'subagent' }, 'team-owner': { mode: 'primary' }, 'team-ideation': { mode: 'primary' } }, instructions: [] });
    assert.deepEqual(Object.keys(shared.agent).sort(), ['team-coordinator', 'team-editor', 'team-ideation', 'team-owner', 'team-researcher', 'team-writer']);
    assert.deepEqual(shared.agent['team-researcher'].permission, { task: 'deny', question: 'deny', 'tracker_*': 'deny' });
    assert.deepEqual(shared.team, { id: 'research-desk', version: 1, roles: ['team-researcher', 'team-writer', 'team-editor'] });
    q.saveSettings('a', { overrides: { team: { blueprint: 'missing' } }, author: 'owner' });
    assert.throws(() => q.projectTeam('a'), /Not found/);
    assert.equal(q.roster()['team-researcher'].name, 'Ada'); assert.equal(q.roster()['team-dev'].name, 'Gandalf');
    assert.equal(q.enqueue({ projectId: 'a', kind: 'chat', role: 'team-researcher', issue: 'A-1', message: 'hi' }).role, 'team-researcher');
    assert.throws(() => q.enqueue({ projectId: 'a', kind: 'chat', role: 'team-nobody', issue: 'A-1', message: 'hi' }), /Invalid role/);
  } finally { q.close(); }
});

test('stores are reachable over HTTP with the shared token only', async () => {
  const q = createQueue(':memory:', { projects });
  const token = 'synthetic-token-at-least-24-characters';
  const server = createQueueServer(q, { token });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  try {
    q.registerProject('a', { workerId: 'w', manifest });
    assert.deepEqual((await (await fetch(`${base}/teams`, { headers })).json()).map(team => team.id), ['default', 'research-desk']);
    assert.equal((await (await fetch(`${base}/environments/browser`, { headers })).json()).capabilities[0], 'browser');
    assert.equal((await (await fetch(`${base}/projects/a/team`, { headers })).json()).id, 'default');
    assert.equal((await (await fetch(`${base}/projects/a/environment`, { headers })).json()).id, 'standard');
    assert.ok((await (await fetch(`${base}/projects/a/shared`, { headers })).json()).agent['team-coordinator'].permission.bash);
    assert.equal((await (await fetch(`${base}/roster`, { headers })).json())['team-pm'].name, 'Jeff');
    const doc = { name: 'UI', capabilities: ['browser', 'display'] };
    const saved = await fetch(`${base}/environments/ui`, { method: 'POST', headers, body: JSON.stringify({ doc, author: 'owner', note: 'first' }) });
    assert.equal(saved.status, 200); assert.equal((await saved.json()).version, 1);
    assert.equal((await (await fetch(`${base}/environments/ui/history`, { headers })).json()).length, 1);
    const reverted = await fetch(`${base}/environments/ui/revert`, { method: 'POST', headers, body: JSON.stringify({ version: 1, author: 'owner' }) });
    assert.equal((await reverted.json()).version, 2);
    assert.equal((await fetch(`${base}/teams/default`, { method: 'POST', headers, body: JSON.stringify({ doc: {}, author: 'owner' }) })).status, 400);
    assert.equal((await fetch(`${base}/teams`, { headers: { authorization: 'Bearer wrong-token-that-is-long-enough' } })).status, 401);
    q.enqueue({ projectId: 'a', issue: 'A-1' });
    const job = q.claim({ workerId: 'w', projectIds: ['a'] });
    assert.equal((await fetch(`${base}/teams`, { headers: { authorization: `Lease ${job.id}:w:${job.leaseToken}` } })).status, 401, 'a run lease cannot read or edit teams');
  } finally { await new Promise(resolve => server.close(resolve)); q.close(); }
});
