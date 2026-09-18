import test from 'node:test';
import assert from 'node:assert/strict';
import { formatPosts, parseTeamArgs, runTeamCli } from './channel-cli.mjs';
import { createQueue, createQueueServer } from './queue.mjs';

const manifest = { version: 1, name: 'Synthetic', instructions: [], workspaceId: 'w', workspaceUrl: 'https://tracker.example/w', teamId: 't', projectId: 'p', projectUrl: 'https://tracker.example/w/p', readyLabel: 'agent:ready', ownerInboxIssue: 'TEST-9' };

test('team CLI arguments parse into read and post requests', () => {
  assert.deepEqual(parseTeamArgs(['read']), { command: 'read', after: 0, limit: 30 });
  assert.deepEqual(parseTeamArgs(['read', '--after', '12', '--limit', '999']), { command: 'read', after: 12, limit: 200 });
  assert.deepEqual(parseTeamArgs(['say', 'claimed', 'TEAM-4']), { command: 'post', kind: 'note', body: 'claimed TEAM-4' });
  assert.deepEqual(parseTeamArgs(['blocker', 'tests', 'need', 'a', 'key']), { command: 'post', kind: 'blocker', body: 'tests need a key' });
  for (const bad of [[], ['shout', 'x'], ['say'], ['read', '--after', 'x']]) assert.throws(() => parseTeamArgs(bad), /Usage/);
});

test('the CLI only works inside a run and reaches the coordinator with the job lease', async () => {
  await assert.rejects(runTeamCli(['read'], {}), /only available inside an agent-team run/);
  const env = { AGENT_TEAM_MEMORY_URL: 'http://127.0.0.1:4310', AGENT_TEAM_MEMORY_JOB: 'job-1', AGENT_TEAM_MEMORY_LEASE: 'worker-a:lease-token', AGENT_TEAM_MEMORY_PROJECT: 'proj' };
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init });
    const body = url.pathname.endsWith('/channel') && init.method === 'GET' ? [{ seq: 3, author: 'team-coordinator', kind: 'claim', body: 'Taking TEAM-4', createdAt: 1_700_000_000_000 }] : url.pathname === '/jobs/job-1/channel' ? { seq: 4, author: 'team-coordinator' } : null;
    return { ok: body !== null, status: body === null ? 404 : 200, json: async () => body };
  };
  const text = await runTeamCli(['read', '--after', '2'], env, fetchImpl);
  assert.equal(text, '#3 2023-11-14 22:13 team-coordinator [claim]: Taking TEAM-4');
  assert.equal(requests[0].url, 'http://127.0.0.1:4310/projects/proj/channel?after=2&limit=30');
  assert.equal(requests[0].init.headers.authorization, 'Lease job-1:worker-a:lease-token');
  assert.equal(await runTeamCli(['handoff', 'draft ready for editor'], env, fetchImpl), 'Posted #4 as team-coordinator.');
  assert.deepEqual(JSON.parse(requests[1].init.body), { workerId: 'worker-a', leaseToken: 'lease-token', kind: 'handoff', body: 'draft ready for editor' });
  assert.equal(formatPosts([]), 'The team channel is empty.');
});

test('a run hands a channel post to a member that is not running', async () => {
  const q = createQueue(':memory:', { projects: { proj: {} } });
  const server = createQueueServer(q, { token: 'synthetic-token-at-least-24-characters' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    q.registerProject('proj', { workerId: 'w', manifest });
    q.enqueue({ projectId: 'proj', issue: 'TEST-1' });
    const job = q.claim({ workerId: 'worker-a', projectIds: ['proj'] });
    const env = { AGENT_TEAM_MEMORY_URL: `http://127.0.0.1:${server.address().port}`, AGENT_TEAM_MEMORY_JOB: job.id, AGENT_TEAM_MEMORY_LEASE: `worker-a:${job.leaseToken}`, AGENT_TEAM_MEMORY_PROJECT: 'proj' };
    assert.equal(await runTeamCli(['handoff', '@Gandalf', 'the', 'migration', 'is', 'yours'], env),
      'Posted #1 as team-coordinator. Woke team-dev; the reply arrives in the channel.');
    const chat = q.list().find(entry => entry.kind === 'chat');
    assert.deepEqual([chat.role, chat.issue, chat.channelSeq, chat.state], ['team-dev', 'TEST-9', 1, 'queued']);
    assert.equal(await runTeamCli(['say', 'no', 'names', 'here'], env), 'Posted #2 as team-coordinator.');
    assert.equal(q.list().filter(entry => entry.kind === 'chat').length, 1);
  } finally { await new Promise(resolve => server.close(resolve)); q.close(); }
});
