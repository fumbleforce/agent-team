import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createQueue, createQueueServer, validBind, validateRegistry } from './queue.mjs';

const projects = { a: {}, b: {} };
const claim = (q, workerId = 'w', projectIds = ['a', 'b']) => q.claim({ workerId, projectIds });
const credentials = j => ({ workerId: j.workerId, leaseToken: j.leaseToken });
test('ideation queue validation, idempotency and queued-only cancellation', () => {
  const q = createQueue(':memory:', { projects });
  try {
    const input = { projectId: 'a', kind: 'ideation', proposalLimit: 3, idempotencyKey: 'ideas' };
    for (const change of [{ proposalLimit: undefined }, { proposalLimit: 0 }, { proposalLimit: 11 }, { issue: 'TEST-1' }, { publish: false }, { autoMerge: false }, { approvalRequired: false }]) assert.throws(() => q.enqueue({ ...input, ...change }));
    for (const change of [{ kind: 'other' }, { proposalLimit: 1 }, { approvalRequired: true }, { approvalRequired: 'yes' }]) assert.throws(() => q.enqueue({ projectId: 'a', ...change }));
    const job = q.enqueue(input);
    assert.equal(q.enqueue(input).id, job.id);
    assert.throws(() => q.enqueue({ ...input, proposalLimit: 2 }), /Idempotency/);
    assert.throws(() => q.cancel(job.id, { unexpected: true }));
    assert.equal(q.cancel(job.id, {}).state, 'canceled');
    assert.equal(q.enqueue(input).state, 'canceled');
    assert.throws(() => q.cancel(job.id), /Only queued/);
    const dev = q.enqueue({ projectId: 'a', issue: 'TEST-1', approvalRequired: true });
    assert.equal(dev.kind, 'development');
    const running = claim(q);
    assert.throws(() => q.cancel(running.id), /Only queued/);
    q.complete(running.id, { ...credentials(running), result: { outcome: 'idle', summary: 'Approval withdrawn' } });
    assert.throws(() => q.cancel(running.id), /Only queued/);
    assert.throws(() => q.requeue(running.id));
  } finally { q.close(); }
});

test('HTTP cancellation accepts only empty bodies and queued jobs', async () => {
  const q = createQueue(':memory:', { projects });
  const token = 'synthetic-token-at-least-24-characters';
  const server = createQueueServer(q, { token });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const job = q.enqueue({ projectId: 'a', kind: 'ideation', proposalLimit: 3 });
    const cancel = body => fetch(`http://127.0.0.1:${server.address().port}/jobs/${job.id}/cancel`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal((await cancel({ wrong: true })).status, 400);
    const response = await cancel({});
    assert.equal(response.status, 200); assert.equal((await response.json()).state, 'canceled');
    assert.equal((await cancel({})).status, 409);
  } finally { await new Promise(resolve => server.close(resolve)); q.close(); }
});
test('autoMerge is opt-in, validated, durable and part of idempotency intent', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'team-merge-')); const dbPath = path.join(dir, 'queue.sqlite');
  let q = createQueue(dbPath, { projects });
  try {
    for (const autoMerge of [null, 'true', 1, {}, []]) assert.throws(() => q.enqueue({ projectId: 'a', publish: true, autoMerge }), /Invalid autoMerge/);
    for (const publish of [undefined, false]) assert.throws(() => q.enqueue({ projectId: 'a', publish, autoMerge: true }), /requires publish/);
    const input = { projectId: 'a', issue: 'FUM-1', publish: true, autoMerge: true, idempotencyKey: 'merge' };
    const job = q.enqueue(input);
    assert.equal(q.enqueue(input).id, job.id);
    assert.throws(() => q.enqueue({ ...input, autoMerge: false }), /Idempotency/);
    const legacyInput = { projectId: 'b', publish: true, idempotencyKey: 'legacy' };
    const legacy = q.enqueue(legacyInput);
    assert.equal(legacy.autoMerge, false);
    assert.equal(q.enqueue({ ...legacyInput, autoMerge: false }).id, legacy.id);
    assert.throws(() => q.enqueue({ ...legacyInput, autoMerge: true }), /Idempotency/);
    q.close(); q = null;
    // Simulate a request persisted by the previous version without autoMerge.
    const db = new DatabaseSync(dbPath);
    try {
      const request = JSON.parse(db.prepare('SELECT request FROM jobs WHERE id=?').get(legacy.id).request);
      delete request.autoMerge;
      delete request.kind; delete request.approvalRequired;
      db.prepare('UPDATE jobs SET request=? WHERE id=?').run(JSON.stringify(request), legacy.id);
    } finally { db.close(); }
    q = createQueue(dbPath, { projects });
    assert.equal(q.list().find(j => j.id === job.id).autoMerge, true);
    assert.equal(q.list().find(j => j.id === legacy.id).autoMerge, false);
    assert.equal(q.enqueue({ ...legacyInput, autoMerge: false }).id, legacy.id);
    assert.throws(() => q.enqueue({ ...legacyInput, autoMerge: true }), /Idempotency/);
    assert.equal(claim(q, 'w', ['a']).autoMerge, true);
    assert.equal(claim(q, 'w', ['b']).autoMerge, false);
  } finally { q?.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('durable reload and competing connections serialize projects but allow parallel projects', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'team-'));
  let q; let other;
  try {
    const db = path.join(dir, 'queue.sqlite'); q = createQueue(db, { projects });
    const first = q.enqueue({ projectId: 'a', issue: 'FUM-1' });
    q.enqueue({ projectId: 'a', issue: 'FUM-2' }); q.enqueue({ projectId: 'b' }); q.close();
    q = createQueue(db, { projects }); other = createQueue(db, { projects });
    const a = claim(q); const b = claim(other, 'other');
    assert.equal(a.id, first.id); assert.equal(b.projectId, 'b'); assert.equal(claim(other), null);
    assert.ok(!JSON.stringify(q.list()).includes(a.leaseToken));
    q.complete(a.id, { ...credentials(a), result: { outcome: 'ready', summary: 'done' } });
    assert.equal(claim(other).issue, 'FUM-2');
  } finally { q?.close(); other?.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('expiry blocks ambiguous work, manual requeue rotates tokens and rejects stale ownership', () => {
  let time = 100; const q = createQueue(':memory:', { projects, now: () => time, leaseMs: 90 });
  try {
    q.enqueue({ projectId: 'a' }); const old = claim(q);
    assert.throws(() => q.heartbeat(old.id, { ...credentials(old), leaseToken: 'wrong' }), /Lease/);
    time = 191;
    assert.throws(() => q.complete(old.id, { ...credentials(old), result: { outcome: 'ready', summary: 'late' } }), /Lease/);
    assert.equal(q.list()[0].state, 'blocked'); assert.equal(claim(q), null);
    q.requeue(old.id); const fresh = claim(q); assert.notEqual(fresh.leaseToken, old.leaseToken);
    assert.throws(() => q.fail(old.id, { ...credentials(old), result: { outcome: 'failed', summary: 'stale' } }), /Lease/);
    time = 200; assert.equal(q.heartbeat(fresh.id, credentials(fresh)).leaseUntil, 290);
    q.fail(fresh.id, { ...credentials(fresh), result: { outcome: 'blocked', summary: 'inspect' } });
    assert.equal(q.list()[0].state, 'blocked');
  } finally { q.close(); }
});
test('strict enqueue, idempotency and overlap validation', () => {
  const q = createQueue(':memory:', { projects });
  try {
    const input = { projectId: 'a', issue: 'FUM-1', idempotencyKey: 'abc' };
    assert.equal(q.enqueue(input).id, q.enqueue({ ...input, base: 'HEAD', publish: false }).id);
    assert.throws(() => q.enqueue({ ...input, issue: 'FUM-2' }), /Idempotency/);
    assert.throws(() => q.enqueue({ projectId: 'a', issue: 'FUM-1' }), /overlapping/);
    assert.throws(() => q.enqueue({ projectId: 'a' }), /overlapping/);
    q.enqueue({ projectId: 'a', issue: 'FUM-2' });
    for (const invalid of [{ projectId: 'unknown' }, { projectId: 'b', publish: 'true' }, { projectId: 'b', timeoutMinutes: 0 }, { projectId: 'b', issue: '../x' }, { projectId: 'b', shell: 'evil' }, { projectId: 'b', model: null }]) assert.throws(() => q.enqueue(invalid));
    assert.throws(() => claim(q, 'w', ['unknown']));
    assert.throws(() => q.requeue(q.list()[0].id));
  } finally { q.close(); }
});
test('expired lease quarantines all queued work for its project until inspected and requeued', () => {
  let time = 0; const q = createQueue(':memory:', { projects, now: () => time, leaseMs: 90 });
  try {
    const first = q.enqueue({ projectId: 'a', issue: 'FUM-1' });
    const second = q.enqueue({ projectId: 'a', issue: 'FUM-2' });
    claim(q, 'old-host', ['a']); time = 91;
    q.enqueue({ projectId: 'b' });
    assert.equal(claim(q, 'new-host', ['a']), null);
    assert.equal(claim(q, 'new-host').projectId, 'b');
    assert.equal(q.list().find(j => j.id === first.id).state, 'blocked');
    assert.equal(q.list().find(j => j.id === second.id).state, 'queued');
    // Explicit operator requeue represents completed inspection, not lease takeover.
    q.requeue(first.id); const retry = claim(q, 'new-host', ['a']);
    assert.equal(retry.id, first.id);
    q.complete(retry.id, { ...credentials(retry), result: { outcome: 'ready', summary: 'inspected and rerun' } });
    assert.equal(claim(q, 'new-host', ['a']).id, second.id);
  } finally { q.close(); }
});
test('failed execution also quarantines its project for other workers', () => {
  const q = createQueue(':memory:', { projects });
  try {
    const first = q.enqueue({ projectId: 'a', issue: 'FUM-1' });
    q.enqueue({ projectId: 'a', issue: 'FUM-2' }); q.enqueue({ projectId: 'b' });
    const job = claim(q, 'w', ['a']);
    q.fail(first.id, { ...credentials(job), result: { outcome: 'failed', summary: 'supervisor crashed; inspect descendants' } });
    assert.equal(claim(q, 'other', ['a']), null);
    assert.equal(claim(q, 'other').projectId, 'b');
    q.requeue(first.id); assert.equal(claim(q, 'other', ['a']).id, first.id);
  } finally { q.close(); }
});
test('engine and fetch are optional, validated and retained', () => {
  const q = createQueue(':memory:', { projects });
  try {
    for (const invalid of [{ engine: 'unknown-engine' }, { engine: 1 }, { fetch: 'yes' }, { fetch: true }, { fetch: true, base: 'main' }, { fetch: true, base: '-origin/main' }]) assert.throws(() => q.enqueue({ projectId: 'a', issue: 'FUM-9', ...invalid }));
    const job = q.enqueue({ projectId: 'a', issue: 'FUM-1', engine: 'claude', base: 'origin/main', fetch: true });
    assert.equal(job.engine, 'claude'); assert.equal(job.fetch, true); assert.equal(job.base, 'origin/main');
    const plain = q.enqueue({ projectId: 'b', fetch: false });
    assert.equal(plain.engine, undefined); assert.equal(plain.fetch, undefined);
    assert.equal(claim(q, 'w', ['a']).engine, 'claude');
  } finally { q.close(); }
});
test('chat jobs run beside builds, skip quarantine, and carry role, issue and message', () => {
  const q = createQueue(':memory:', { projects });
  try {
    for (const invalid of [{ role: 'nobody', issue: 'FUM-1', message: 'x' }, { role: 'team-pm', message: 'x' }, { role: 'team-pm', issue: 'FUM-1', message: '' }, { role: 'team-pm', issue: 'FUM-1', message: 'x', publish: true }, { role: 'team-pm', issue: 'FUM-1', message: 'x', timeoutMinutes: 30 }]) assert.throws(() => q.enqueue({ projectId: 'a', kind: 'chat', ...invalid }));
    assert.throws(() => q.enqueue({ projectId: 'a', role: 'team-pm' }), /require chat/);
    const build = q.enqueue({ projectId: 'a', issue: 'FUM-1' });
    const running = claim(q, 'w', ['a']);
    assert.equal(running.id, build.id);
    const chat = q.enqueue({ projectId: 'a', kind: 'chat', role: 'team-pm', issue: 'FUM-10', message: 'Status?' });
    assert.equal(chat.kind, 'chat'); assert.equal(chat.timeoutMinutes, 5);
    assert.equal(q.claim({ workerId: 'w', projectIds: ['a'] }), null, 'build slots never take chat');
    const talking = q.claim({ workerId: 'w', projectIds: ['a'], kinds: ['chat'] });
    assert.equal(talking.id, chat.id);
    q.fail(running.id, { ...credentials(running), result: { outcome: 'blocked', summary: 'held' } });
    const second = q.enqueue({ projectId: 'a', kind: 'chat', role: 'team-dev', issue: 'FUM-10', message: 'While held?' });
    assert.equal(q.claim({ workerId: 'w', projectIds: ['a'], kinds: ['chat'] }).id, second.id, 'chat is answered even while the project is on hold');
    assert.throws(() => q.claim({ workerId: 'w', projectIds: ['a'], kinds: ['other'] }));
    q.complete(talking.id, { ...credentials(talking), result: { outcome: 'ready', summary: 'Reply text' } });
    assert.equal(q.list().find(j => j.id === chat.id).result.summary, 'Reply text');
  } finally { q.close(); }
});
test('evidence is stored per lease and listed newest first; manifests register per project', () => {
  const q = createQueue(':memory:', { projects });
  try {
    q.enqueue({ projectId: 'a', issue: 'FUM-1' }); const job = claim(q, 'w', ['a']);
    assert.throws(() => q.evidence(job.id, { ...credentials(job), leaseToken: 'wrong', evidence: {} }), /Lease/);
    assert.throws(() => q.evidence(job.id, { ...credentials(job), evidence: { big: 'x'.repeat(700_000) } }), /600KB/);
    q.evidence(job.id, { ...credentials(job), evidence: { run: { id: 'r1', state: 'running' }, steps: [{ text: 'first' }] } });
    q.evidence(job.id, { ...credentials(job), evidence: { run: { id: 'r1', state: 'ready' }, steps: [{ text: 'second' }] } });
    assert.deepEqual(q.evidenceFor(job.id).steps, [{ text: 'second' }]);
    assert.equal(q.evidenceList()[0].jobState, 'running');
    q.complete(job.id, { ...credentials(job), result: { outcome: 'ready', summary: 'done' } });
    assert.throws(() => q.evidence(job.id, { ...credentials(job), evidence: {} }), /Lease/);
    assert.equal(q.evidenceFor(job.id).run.state, 'ready'); assert.equal(q.evidenceList()[0].jobState, 'completed');
    assert.throws(() => q.evidenceList({ limit: 0 }));
    assert.throws(() => q.registerProject('unknown', { workerId: 'w', manifest: {} }));
    q.registerProject('a', { workerId: 'w', manifest: { name: 'A' } });
    assert.deepEqual(q.projectsList().map(p => [p.id, p.manifest?.name ?? null, p.workerId]), [['a', 'A', 'w'], ['b', null, null]]);
  } finally { q.close(); }
});
test('event streams append under the lease and page by sequence', () => {
  const q = createQueue(':memory:', { projects });
  try {
    q.enqueue({ projectId: 'a', issue: 'FUM-1' }); const job = claim(q, 'w', ['a']);
    assert.throws(() => q.appendEvents(job.id, { ...credentials(job), events: ['x'.repeat(9000)] }), /Invalid events/);
    assert.deepEqual(q.appendEvents(job.id, { ...credentials(job), events: ['{"a":1}', '{"a":2}'] }), { seq: 2 });
    assert.deepEqual(q.appendEvents(job.id, { ...credentials(job), events: ['{"a":3}'] }), { seq: 3 });
    const page = q.eventsAfter(job.id, { after: 1 });
    assert.equal(page.jobState, 'running'); assert.deepEqual(page.events.map(e => [e.seq, e.line]), [[2, '{"a":2}'], [3, '{"a":3}']]);
    assert.throws(() => q.eventsAfter(job.id, { after: -1 }));
    q.complete(job.id, { ...credentials(job), result: { outcome: 'ready', summary: 'done' } });
    assert.throws(() => q.appendEvents(job.id, { ...credentials(job), events: ['late'] }), /Lease/);
    assert.equal(q.eventsAfter(job.id).jobState, 'completed');
  } finally { q.close(); }
});
test('startup registry requires registered IDs and repository strings', () => {
  for (const registry of [undefined, null, {}, [], { a: {} }, { a: { repository: '' } }, { '../a': { repository: 'repo' } }]) assert.throws(() => validateRegistry(registry));
  assert.doesNotThrow(() => validateRegistry({ myntbase: { repository: 'git@github.com:fumbleforce/stockapp.git' } }));
});
test('HTTP auth, JSON limits, lifecycle, clear error status and no token in summaries', async t => {
  const token = 'a'.repeat(32); const q = createQueue(':memory:', { projects });
  const server = createQueueServer(q, { token });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); q.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body) => fetch(url + route, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  assert.equal((await fetch(url + '/health')).status, 401);
  assert.equal((await post('/jobs', '{')).status, 400);
  assert.equal((await post('/jobs', 'x'.repeat(65537))).status, 413);
  assert.equal((await post('/jobs', { projectId: 'unknown' })).status, 400);
  assert.equal((await post('/jobs', { projectId: 'a' })).status, 201);
  const contenders = await Promise.all(Array.from({ length: 8 }, async (_, i) => (await post('/claim', { workerId: `w${i}`, projectIds: ['a'] })).json()));
  assert.equal(contenders.filter(Boolean).length, 1);
  const job = contenders.find(Boolean);
  assert.ok(job.leaseToken);
  assert.equal((await post(`/jobs/${job.id}/heartbeat`, { workerId: 'other', leaseToken: job.leaseToken })).status, 409);
  assert.equal((await post(`/jobs/${job.id}/complete`, { ...credentials(job), result: { outcome: 'idle', summary: 'none' } })).status, 200);
  const list = await (await fetch(url + '/jobs', { headers: { authorization: `Bearer ${token}` } })).json();
  assert.equal(list[0].state, 'completed'); assert.equal(list[0].leaseToken, undefined);
});
test('bind boundaries are loopback or private-network IPv4', () => {
  for (const host of ['127.0.0.1', '::1', '100.64.0.1', '100.127.255.255']) assert.ok(validBind(host));
  for (const host of ['0.0.0.0', '192.168.1.1', '100.63.1.1', '100.128.1.1', '100.64.0.999']) assert.equal(validBind(host), false);
  process.env.AGENT_TEAM_PUBLIC_BIND = '1';
  try { assert.ok(validBind('0.0.0.0')); assert.equal(validBind('192.168.1.1'), false); } finally { delete process.env.AGENT_TEAM_PUBLIC_BIND; }
});
