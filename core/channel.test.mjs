import test from 'node:test';
import assert from 'node:assert/strict';
import { CHANNEL_KINDS, createQueue, createQueueServer } from './queue.mjs';

const projects = { a: {}, b: {} };

test('the team channel is per project, append-only and validated', () => {
  const q = createQueue(':memory:', { projects });
  try {
    assert.deepEqual(CHANNEL_KINDS, ['note', 'claim', 'blocker', 'handoff', 'question']);
    const first = q.channelPost('a', { author: 'owner', body: 'Ship the invoice fix first.' });
    assert.equal(first.seq, 1); assert.equal(first.kind, 'note'); assert.equal(first.author, 'owner');
    q.channelPost('b', { body: 'Other project' });
    const second = q.channelPost('a', { author: 'team-pm', kind: 'question', body: 'Which\nregion first?' });
    assert.deepEqual(q.channelRead('a').map(post => post.seq), [1, second.seq]);
    assert.deepEqual(q.channelRead('a', { after: 1 }).map(post => post.body), ['Which\nregion first?']);
    assert.deepEqual(q.channelRead('a', { limit: 1 }).map(post => post.seq), [second.seq], 'without after, the newest posts come back in order');
    assert.throws(() => q.channelPost('a', { body: '' }), /Invalid body/);
    assert.throws(() => q.channelPost('a', { body: 'x'.repeat(4001) }), /Invalid body/);
    assert.throws(() => q.channelPost('a', { body: 'hi', kind: 'shout' }), /Invalid kind/);
    assert.throws(() => q.channelPost('a', { body: 'hi', extra: 1 }));
    assert.throws(() => q.channelPost('zzz', { body: 'hi' }), /Unknown projectId/);
    assert.throws(() => q.channelRead('a', { after: -1 }), /Invalid after/);
    assert.throws(() => q.channelRead('a', { limit: 0 }), /Invalid limit/);
  } finally { q.close(); }
});

test('a running job posts as its role through its lease and reads only its own project', async () => {
  const q = createQueue(':memory:', { projects });
  const token = 'synthetic-token-at-least-24-characters';
  const server = createQueueServer(q, { token });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    q.enqueue({ projectId: 'a', issue: 'TEST-1' });
    const job = q.claim({ workerId: 'w', projectIds: ['a'] });
    const lease = { authorization: `Lease ${job.id}:w:${job.leaseToken}`, 'content-type': 'application/json' };
    const posted = await fetch(`${base}/jobs/${job.id}/channel`, { method: 'POST', headers: lease, body: JSON.stringify({ workerId: 'w', leaseToken: job.leaseToken, kind: 'claim', body: 'Taking TEST-1' }) });
    assert.equal(posted.status, 201);
    const post = await posted.json();
    assert.equal(post.author, 'team-coordinator'); assert.equal(post.jobId, job.id);
    const wrongLease = await fetch(`${base}/jobs/${job.id}/channel`, { method: 'POST', headers: lease, body: JSON.stringify({ workerId: 'w', leaseToken: 'forged', body: 'x' }) });
    assert.equal(wrongLease.status, 401);
    const read = await fetch(`${base}/projects/a/channel?after=0`, { headers: lease });
    assert.equal(read.status, 200);
    assert.deepEqual((await read.json()).map(entry => entry.body), ['Taking TEST-1']);
    assert.equal((await fetch(`${base}/projects/b/channel`, { headers: lease })).status, 401, 'another project is out of scope');
    assert.equal((await fetch(`${base}/projects/a/channel`, { method: 'POST', headers: lease, body: JSON.stringify({ body: 'x' }) })).status, 401, 'a lease cannot post as the owner');
    const owner = await fetch(`${base}/projects/a/channel`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ author: 'owner', body: 'Pause after this one.' }) });
    assert.equal(owner.status, 201);
    const all = await (await fetch(`${base}/projects/a/channel`, { headers: { authorization: `Bearer ${token}` } })).json();
    assert.deepEqual(all.map(entry => entry.author), ['team-coordinator', 'owner']);
    q.complete(job.id, { workerId: 'w', leaseToken: job.leaseToken, result: { outcome: 'idle', summary: 'done' } });
    assert.equal((await fetch(`${base}/jobs/${job.id}/channel`, { method: 'POST', headers: lease, body: JSON.stringify({ workerId: 'w', leaseToken: job.leaseToken, body: 'late' }) })).status, 401, 'a finished job cannot post');
  } finally { await new Promise(resolve => server.close(resolve)); q.close(); }
});
