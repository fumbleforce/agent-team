import test from 'node:test';
import assert from 'node:assert/strict';
import { trackerClient, TRACKER_KINDS } from './index.ts';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('both trackers return the same neutral issue shape', async () => {
  const github = trackerClient('github', { env: { GH_TOKEN: 'gh-token' }, fetch: (async () => json([
    { number: 7, title: 'Checkout fails', body: 'Steps', state: 'open', labels: [{ name: 'agent:in-progress' }, 'payments'] },
    { number: 8, title: 'A pull request', pull_request: {}, state: 'open' },
    { number: 9, title: 'Dropped', state: 'closed', state_reason: 'not_planned' },
  ])) as typeof fetch })!;
  const fromGithub = (await github.snapshot({ repository: 'acme/shop' })).allIssues;
  assert.deepEqual(fromGithub.map(issue => [issue.identifier, issue.state.type, issue.labels.map(label => label.name)]), [['GH-7', 'unstarted', ['agent:in-progress', 'payments']], ['GH-9', 'canceled', []]]);

  let calls = 0;
  const linear = trackerClient('linear', { env: { LINEAR_API_KEY: 'lin-key' }, fetch: (async () => json({ data: { issues: {
    nodes: [{ identifier: `ACM-${++calls}`, title: 'Task', state: { name: 'In Progress', type: 'started' }, labels: { nodes: [{ name: 'payments' }] } }],
    pageInfo: { hasNextPage: calls < 2, endCursor: `cursor-${calls}` },
  } } })) as typeof fetch })!;
  const fromLinear = (await linear.snapshot({ projectId: 'project-1' })).allIssues;
  assert.deepEqual(fromLinear.map(issue => [issue.identifier, issue.state.type, issue.labels]), [['ACM-1', 'started', [{ name: 'payments' }]], ['ACM-2', 'started', [{ name: 'payments' }]]]);
});

test('a tracker without a credential is not polled, and failures never carry the response body', async () => {
  assert.deepEqual(TRACKER_KINDS, ['github', 'linear']);
  assert.equal(trackerClient('github', { env: {} }), null);
  assert.equal(trackerClient('unknown', { env: { GH_TOKEN: 'x' } }), null);
  const failing = trackerClient('github', { env: { GH_TOKEN: 'gh-token' }, fetch: (async () => json({ message: 'gh-token leaked' }, 401)) as typeof fetch })!;
  await assert.rejects(failing.snapshot({ repository: 'acme/shop' }), error => !/leaked/.test((error as Error).message) && /401/.test((error as Error).message));
  await assert.rejects(failing.snapshot({ repository: '../escape' }), /configuration/);
});
