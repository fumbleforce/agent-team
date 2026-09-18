import test from 'node:test';
import assert from 'node:assert/strict';
import { CHANNEL_KINDS, createQueue, createQueueServer } from './queue.mjs';
import { parseMentions } from './roster.mjs';

const projects = { a: {}, b: {} };
// A registered manifest is what gives the channel an inbox issue and a daily cap to wake against.
const manifest = { version: 1, name: 'Synthetic', instructions: [], workspaceId: 'w', workspaceUrl: 'https://tracker.example/w', teamId: 't',
  projectId: 'p', projectUrl: 'https://tracker.example/w/p', readyLabel: 'agent:ready', ownerInboxIssue: 'TEST-9', pm: { dailyCapUsd: 10 } };

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

test('only a leading run of @names addresses roster members', () => {
  const roster = { 'team-dev': { name: 'Gandalf' }, 'team-tester': { name: 'Joker' } };
  assert.deepEqual(parseMentions('@Gandalf @joker, ship it', roster), ['team-dev', 'team-tester']);
  assert.deepEqual(parseMentions('  @GANDALF @Gandalf @team-dev hello @Joker', roster), ['team-dev'], 'each member once, and only the leading run addresses anyone');
  assert.deepEqual(parseMentions('@Gandolf @Joker look', roster), ['team-tester'], 'a misspelled name is ordinary text, not an addressee');
  for (const body of ['ship it @Gandalf', 'mail gandalf@example.test now', '@nobody', '', null]) assert.deepEqual(parseMentions(body, roster), []);
});

test('a mention wakes one bounded chat per member, under the daily cap and one live chat each', () => {
  const q = createQueue(':memory:', { projects });
  try {
    q.registerProject('a', { workerId: 'w', manifest });
    assert.deepEqual(q.channelPost('a', { author: 'owner', body: 'Ship the invoice fix first.' }).woke, []);
    assert.equal(q.list().length, 0, 'a post without a mention is stored and read at cycle start, nothing more');
    const post = q.channelPost('a', { author: 'owner', body: '@Gandalf @gandalf can you look at the migration?' });
    assert.deepEqual(post.woke, ['team-dev'], 'repeated mentions of one member wake it once');
    const job = q.list()[0];
    assert.equal(q.list().length, 1);
    assert.deepEqual([job.kind, job.role, job.issue, job.channelSeq, job.state], ['chat', 'team-dev', 'TEST-9', post.seq, 'queued']);
    assert.ok(job.message.startsWith(`owner addressed you in team channel post #${post.seq}: @Gandalf @gandalf can you look at the migration?`));
    assert.match(job.message, /Ship the invoice fix first\./, 'the posts before it ride along as context');
    assert.deepEqual(q.channelPost('a', { author: 'owner', body: '@Gandalf and one more thing' }).woke, [], 'a member with a live chat is not woken again');
    assert.deepEqual(q.channelPost('a', { author: 'owner', body: '@Gandolf ping' }).woke, [], 'an unknown name wakes nothing');
    assert.deepEqual(q.channelPost('a', { author: 'owner', body: '@Joker retest the invoice fix' }).woke, ['team-tester']);
    assert.equal(q.list().length, 2);
    q.recordCost('a', { kind: 'run', usd: 12 });
    assert.deepEqual(q.channelPost('a', { author: 'owner', body: '@Rams does the empty state hold?' }).woke, [], 'spend over the daily cap blocks the wake');
    assert.equal(q.list().length, 2);
    assert.equal(q.channelRead('a').length, 6, 'every post is stored whether or not it woke anyone');
  } finally { q.close(); }
});

test('a run hands off through a mention; a woken chat never wakes anyone back', () => {
  const q = createQueue(':memory:', { projects });
  try {
    q.registerProject('a', { workerId: 'w', manifest });
    q.enqueue({ projectId: 'a', issue: 'TEST-1' });
    const run = q.claim({ workerId: 'w', projectIds: ['a'] });
    const handoff = q.channelPostForJob(run.id, 'w', run.leaseToken, { kind: 'handoff', body: '@Gandalf the migration is yours.' });
    assert.deepEqual([handoff.author, handoff.woke], ['team-coordinator', ['team-dev']]);
    const chat = q.claim({ workerId: 'w', projectIds: ['a'], kinds: ['chat'] });
    assert.equal(chat.channelSeq, handoff.seq);
    const reply = q.channelPostForJob(chat.id, 'w', chat.leaseToken, { body: `re #${handoff.seq}: @Joker over to you, the migration is fine.` });
    assert.deepEqual([reply.author, reply.woke], ['team-dev', []], 'a chat job answering in the channel cannot wake another member');
    assert.equal(q.list().filter(entry => entry.kind === 'chat').length, 1);
  } finally { q.close(); }
});

test('an unregistered project has no inbox to wake into, and channelSeq stays a chat-only integer', () => {
  const q = createQueue(':memory:', { projects });
  try {
    assert.deepEqual(q.channelPost('a', { author: 'owner', body: '@Gandalf hello' }).woke, []);
    assert.equal(q.list().length, 0);
    q.registerProject('a', { workerId: 'w', manifest });
    assert.throws(() => q.enqueue({ projectId: 'a', kind: 'chat', role: 'team-dev', issue: 'TEST-9', message: 'hi', channelSeq: 0 }), /Invalid channelSeq/);
    assert.throws(() => q.enqueue({ projectId: 'a', kind: 'chat', role: 'team-dev', issue: 'TEST-9', message: 'hi', channelSeq: '3' }), /Invalid channelSeq/);
    assert.throws(() => q.enqueue({ projectId: 'a', issue: 'TEST-1', channelSeq: 3 }), /require chat/);
  } finally { q.close(); }
});
