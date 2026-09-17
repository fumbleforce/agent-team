import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMemoryArgs, runMemoryCli } from './memory-cli.mjs';

test('memory CLI arguments parse into search and propose requests', () => {
  assert.deepEqual(parseMemoryArgs(['search', 'round', 'timing', '--scope', 'app/hustle']), { command: 'search', query: 'round timing', scope: ['app/hustle'] });
  assert.deepEqual(parseMemoryArgs(['propose', 'gotcha', 'Server', 'clock', '--', 'Rounds', 'close', 'server-side', '--scope', 'app']), { command: 'propose', type: 'gotcha', title: 'Server clock', body: 'Rounds close server-side', scope: ['app'] });
  for (const bad of [[], ['search'], ['propose', 'gotcha', 'Title'], ['propose', 'gotcha', '--', 'body'], ['forget', 'x']]) assert.throws(() => parseMemoryArgs(bad), /Usage/);
});

test('the CLI only works inside a run and calls the coordinator with the job lease', async () => {
  await assert.rejects(runMemoryCli(['search', 'x'], {}), /only available inside an agent-team run/);
  const env = { AGENT_TEAM_MEMORY_URL: 'http://127.0.0.1:4310', AGENT_TEAM_MEMORY_JOB: 'job-1', AGENT_TEAM_MEMORY_LEASE: 'worker-a:lease-token', AGENT_TEAM_MEMORY_PROJECT: 'proj' };
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init });
    const body = url.pathname.endsWith('/proposals') ? { ids: ['p-1'] } : url.pathname.endsWith('/search') ? [{ id: 'server-clock', type: 'gotcha', title: 'Server clock', body: 'Rounds close server-side.', confirmed: true }] : null;
    return { ok: body !== null, status: body === null ? 404 : 200, json: async () => body };
  };
  const text = await runMemoryCli(['search', 'clock', '--scope', 'app'], env, fetchImpl);
  assert.match(text, /^## Server clock \(server-clock, gotcha, confirmed\)\nRounds close server-side\./);
  assert.equal(requests[0].url, 'http://127.0.0.1:4310/projects/proj/memory/search?q=clock&scope=app&limit=10');
  assert.equal(requests[0].init.headers.authorization, 'Lease job-1:worker-a:lease-token');
  assert.equal(requests[0].init.method, 'GET');
  const proposed = await runMemoryCli(['propose', 'gotcha', 'Server clock', '--', 'Rounds close server-side'], env, fetchImpl);
  assert.equal(proposed, 'Proposed for memory review: p-1');
  assert.deepEqual(JSON.parse(requests[1].init.body), { workerId: 'worker-a', leaseToken: 'lease-token', items: [{ type: 'gotcha', title: 'Server clock', body: 'Rounds close server-side', scope: [] }] });
  await assert.rejects(runMemoryCli(['search', 'nothing'], env, async () => ({ ok: false, status: 403 })), /failed \(403\)/);
});
