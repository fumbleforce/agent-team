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

// One contract for the writing side: the same neutral calls against each tracker's recorded API answers.
interface Call { method: string; url: string; body: any }
function recorded(answer: (call: Call) => unknown) {
  const calls: Call[] = [];
  const fake = (async (url: string | URL, init?: RequestInit) => { const call = { method: init?.method ?? 'GET', url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null }; calls.push(call); return json(answer(call)); }) as typeof fetch;
  return { calls, fetch: fake };
}
const TEAM = { id: 'team-1', states: { nodes: [{ id: 's-todo', name: 'Todo', type: 'unstarted', position: 1 }, { id: 's-doing', name: 'In Progress', type: 'started', position: 2 }, { id: 's-review', name: 'In Review', type: 'started', position: 3 }, { id: 's-done', name: 'Done', type: 'completed', position: 4 }, { id: 's-backlog', name: 'Backlog', type: 'backlog', position: 0 }] }, labels: { nodes: [{ id: 'l-idea', name: 'Idea' }, { id: 'l-ready', name: 'agent:ready' }] } };
const HOSTS = {
  github: {
    env: { GH_TOKEN: 'gh-token' }, manifest: { repository: 'acme/shop' }, issue: 'GH-7', foreign: 'ACM-7',
    answer: (call: Call) => call.method === 'GET' && /\/issues\/7$/.test(call.url) ? { number: 7, state: 'open', labels: [{ name: 'payments' }, { name: 'agent:in-progress' }] }
      : call.method === 'GET' && /\/comments/.test(call.url) ? [{ id: 501, body: 'Seen on Safari too', created_at: '2026-01-02T10:00:00Z', user: { login: 'owner' } }, { id: 502, body: '  ', created_at: '2026-01-02T11:00:00Z' }]
        : call.method === 'POST' && /\/comments$/.test(call.url) ? { id: 900 } : call.method === 'POST' && /\/labels$/.test(call.url) ? [{ name: 'agent:ready' }] : call.method === 'POST' && /\/issues$/.test(call.url) ? { number: 12, html_url: 'https://github.com/acme/shop/issues/12' } : {},
    wroteState: (calls: Call[]) => { const patch = calls.find(call => call.method === 'PATCH')!; return [patch.url.endsWith('/repos/acme/shop/issues/7'), patch.body.labels]; },
    expectedState: [true, ['payments', 'agent:in-review']],
    wroteClosed: (calls: Call[]) => { const patch = calls.find(call => call.method === 'PATCH')!; return [patch.body.state, patch.body.state_reason]; }, expectedClosed: ['closed', 'completed'],
    since: (calls: Call[]) => /since=2026-01-01T00%3A00%3A00.000Z/.test(calls.at(-1)!.url),
    created: (calls: Call[]) => calls.at(-1)!.body.labels, expectedCreated: ['Idea', 'Backlog'], identifier: 'GH-12',
  },
  linear: {
    env: { LINEAR_API_KEY: 'lin-key' }, manifest: { projectId: 'project-1', teamId: 'team-1' }, issue: 'ACM-7', foreign: 'acm 7',
    answer: (call: Call) => /IssueScope/.test(call.body.query) ? { data: { issue: { id: 'uuid-7', team: TEAM, labels: { nodes: [{ id: 'l-idea', name: 'Idea' }] } } } }
      : /TeamScope/.test(call.body.query) ? { data: { team: TEAM } }
        : /IssueComments/.test(call.body.query) ? { data: { issue: { comments: { nodes: [{ id: 'c-1', body: 'Seen on Safari too', createdAt: '2026-01-02T10:00:00Z', user: { name: 'owner' } }, { id: 'c-2', body: '  ', createdAt: '2026-01-02T11:00:00Z' }] } } } }
          : /UpdateIssue/.test(call.body.query) ? { data: { issueUpdate: { success: true } } } : /mutation Comment/.test(call.body.query) ? { data: { commentCreate: { success: true, comment: { id: 'c-9' } } } }
            : { data: { issueCreate: { success: true, issue: { identifier: 'ACM-12', url: 'https://tracker.example/ACM-12' } } } },
    wroteState: (calls: Call[]) => { const update = calls.find(call => /UpdateIssue/.test(call.body.query))!; return [update.body.variables.id === 'uuid-7', update.body.variables.input.stateId]; },
    expectedState: [true, 's-review'],
    wroteClosed: (calls: Call[]) => [calls.find(call => /UpdateIssue/.test(call.body.query))!.body.variables.input.stateId], expectedClosed: ['s-done'],
    since: (calls: Call[]) => calls.at(-1)!.body.variables.filter.createdAt.gt === '2026-01-01T00:00:00.000Z',
    created: (calls: Call[]) => { const input = calls.at(-1)!.body.variables.input; return [input.labelIds[0], input.stateId]; }, expectedCreated: ['l-idea', 's-backlog'], identifier: 'ACM-12',
  },
};

for (const [kind, host] of Object.entries(HOSTS)) {
  test(`${kind}: state, comments, labels and new issues are written and read through the same neutral calls`, async () => {
    let http = recorded(host.answer);
    const client = () => trackerClient(kind, { env: host.env, fetch: http.fetch })!;
    await client().setState(host.manifest, host.issue, 'in_review');
    assert.deepEqual(host.wroteState(http.calls), host.expectedState, 'review replaces the progress marker and leaves everything else alone');
    http = recorded(host.answer);
    await client().setState(host.manifest, host.issue, 'completed');
    assert.deepEqual(host.wroteClosed(http.calls), host.expectedClosed);

    http = recorded(host.answer);
    assert.match((await client().comment(host.manifest, host.issue, 'Fixed in the branch')).id, /^(900|c-9)$/);
    assert.match(JSON.stringify(http.calls.at(-1)!.body), /Fixed in the branch/);
    await assert.rejects(client().comment(host.manifest, host.issue, ' '), /Invalid comment/);
    await assert.rejects(client().comment(host.manifest, host.foreign, 'x'), /Not an issue of this tracker/);

    http = recorded(host.answer);
    const comments = await client().comments(host.manifest, host.issue, '2026-01-01T00:00:00.000Z');
    assert.deepEqual(comments.map(comment => [comment.body, comment.author, comment.createdAt]), [['Seen on Safari too', 'owner', '2026-01-02T10:00:00Z']], 'empty comments are dropped');
    assert.ok(host.since(http.calls), 'only comments after the given time are asked for');

    http = recorded(host.answer);
    await client().addLabel(host.manifest, host.issue, 'agent:ready');
    assert.match(JSON.stringify(http.calls.at(-1)!.body), /agent:ready|l-ready/);
    http = recorded(host.answer);
    assert.equal((await client().createIssue(host.manifest, { title: 'Saved carts', body: 'Problem', labels: ['Idea'], state: 'Backlog' })).identifier, host.identifier);
    assert.deepEqual(host.created(http.calls), host.expectedCreated, 'the proposed state is a label where there are no states, a workflow state where there are');

    const failing = trackerClient(kind, { env: host.env, fetch: (async () => json({ message: 'secret-body', errors: [{ message: 'secret-body' }] }, 500)) as typeof fetch })!;
    for (const attempt of [failing.setState(host.manifest, host.issue, 'started'), failing.comment(host.manifest, host.issue, 'x'), failing.comments(host.manifest, host.issue, null)]) await assert.rejects(attempt, error => !/secret-body|gh-token|lin-key/.test((error as Error).message));
  });
}

test('an approved idea reads as approved on both: by its label where states are labels, by its state elsewhere', async () => {
  const github = trackerClient('github', { env: { GH_TOKEN: 'gh-token' }, fetch: (async () => json([{ number: 3, title: 'Idea', state: 'open', labels: ['idea', 'agent:approved'] }, { number: 4, title: 'Idea 2', state: 'open', labels: ['idea', 'idea:proposed'] }])) as typeof fetch })!;
  const issues = (await github.snapshot({ repository: 'acme/shop', ideation: { proposedState: 'idea:proposed', approvedState: 'agent:approved' } })).allIssues;
  assert.deepEqual(issues.map(issue => [issue.state.name, issue.state.type]), [['agent:approved', 'unstarted'], ['idea:proposed', 'backlog']]);
  const linear = trackerClient('linear', { env: { LINEAR_API_KEY: 'lin-key' }, fetch: (async () => json({ data: { issues: { nodes: [{ identifier: 'ACM-1', title: 'Idea', state: { name: 'Todo', type: 'unstarted' }, labels: { nodes: [{ name: 'Idea' }] }, parent: null, inverseRelations: { nodes: [{ type: 'blocks', issue: { state: { type: 'started' } } }] } }], pageInfo: { hasNextPage: false, endCursor: null } } } })) as typeof fetch })!;
  const [blocked] = (await linear.snapshot({ projectId: 'project-1' })).allIssues;
  assert.deepEqual([blocked!.state.name, blocked!.blocked, blocked!.child], ['Todo', true, false]);
});
