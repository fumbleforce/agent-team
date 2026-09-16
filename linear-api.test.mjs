import test from 'node:test';
import assert from 'node:assert/strict';
import { approvalStatus, createLinearClient } from './linear-api.mjs';
import { validateIdeation, validateProposals } from './idea-schema.mjs';

const ideation = { enabled: true, backlogCap: 10, batchSize: 3, minimumIntervalHours: 24, ideaLabel: 'Idea', proposedState: 'Backlog', approvedState: 'Todo', rejectedState: 'Canceled' };
const manifest = { workspaceId: 'workspace', teamId: 'team', projectId: 'project', readyLabel: 'agent:ready', ideation };
const proposal = { title: 'Feature', problem: 'User problem', benefit: 'Useful outcome', scope: 'Bounded feature', successCriteria: ['Observable outcome'], effort: 'M', evidence: ['Product charter'], whyNow: 'Current gap' };
const states = [{ id: 'backlog', name: 'Backlog', type: 'backlog' }, { id: 'todo', name: 'Todo', type: 'unstarted' }, { id: 'canceled', name: 'Canceled', type: 'canceled' }, { id: 'done', name: 'Done', type: 'completed' }];
const labels = [{ id: 'idea', name: 'Idea' }, { id: 'ready', name: 'agent:ready' }];
const connection = (nodes, next = false) => ({ nodes, pageInfo: { hasNextPage: next, endCursor: next ? 'next' : null } });
function issue(index, state = states[0], extra = {}) {
  return { id: `id-${index}`, identifier: `TEAM-${index}`, title: `Idea ${index}`, description: '', updatedAt: '2026-09-16', archivedAt: null, state, labels: connection([labels[0]]), parent: null, project: { id: 'project' }, team: { id: 'team' }, inverseRelations: connection([]), ...extra };
}
function fake({ issues = [], workspace = 'workspace', membership = 'team', pageSize = 100, afterCreate, beforeCreate } = {}) {
  const calls = [];
  const fetchImpl = async (_url, options) => {
    const { query, variables } = JSON.parse(options.body); calls.push({ query, variables });
    let data;
    if (query.includes('query Organization')) data = { organization: { id: workspace } };
    else if (query.includes('query Context')) data = { project: { id: 'project', teams: connection([{ id: membership }]) }, team: { id: 'team', states: connection(states), labels: connection(labels) } };
    else if (query.includes('query ProjectIssues')) {
      assert.deepEqual(variables.filter, { project: { id: { eq: 'project' } } });
      assert.match(query, /includeArchived: true/);
      const start = Number(variables.after ?? 0); const end = start + pageSize;
      data = { issues: { nodes: issues.slice(start, end), pageInfo: { hasNextPage: end < issues.length, endCursor: String(end) } } };
    } else if (query.includes('mutation CreateIdea')) {
      beforeCreate?.(variables.input);
      const input = variables.input; const created = issue(issues.length + 1, states[0], { title: input.title, description: input.description });
      issues.push(created); afterCreate?.();
      data = { issueCreate: { success: true, issue: { id: created.id, identifier: created.identifier, url: 'https://linear.app/test' } } };
    } else if (query.includes('mutation ReadyIdea')) {
      const target = issues.find(item => item.id === variables.id);
      target.labels = connection(variables.input.labelIds.map(id => labels.find(label => label.id === id) ?? { id, name: id }));
      data = { issueUpdate: { success: true } };
    } else if (query.includes('query Inbox(')) data = { issue: { id: 'inbox', team: { id: 'team' }, comments: connection([{ id: 'c2', createdAt: '2026-09-16T08:17:00Z', body: 'Second request', user: { name: 'Owner' } }, { id: 'c1', createdAt: '2026-09-16T08:14:00Z', body: 'First request', user: { name: 'Owner' } }, { id: 'c3', createdAt: '2026-09-16T08:18:00Z', body: '   ', user: null }]) } };
    else throw new Error('Unexpected fake operation');
    return { ok: true, json: async () => ({ data }) };
  };
  return { client: createLinearClient({ apiKey: 'secret-test-key', fetchImpl }), calls, issues };
}

test('strict schemas, concise fields, unique titles and relative effort', () => {
  assert.deepEqual(validateIdeation(ideation), ideation);
  for (const patch of [{ enabled: false }, { backlogCap: 51 }, { batchSize: 11 }, { backlogCap: 2 }, { minimumIntervalHours: 0 }, { minimumIntervalHours: 169 }, { extra: true }, { approvedState: 'Backlog' }]) assert.throws(() => validateIdeation({ ...ideation, ...patch }));
  assert.equal(validateProposals([proposal], 3)[0].effort, 'M');
  for (const values of [[proposal, { ...proposal, title: ' FEATURE ' }], [{ ...proposal, evidence: [] }], [{ ...proposal, effort: '2 days' }], [{ ...proposal, scope: 'x'.repeat(1201) }], [{ ...proposal, extra: true }]]) assert.throws(() => validateProposals(values, 3));
});
test('all issue pages count only unfinished root ideas; rejected and archived titles retained', async () => {
  const issues = [issue(1), issue(2, states[3]), issue(3, states[2]), issue(4, states[0], { archivedAt: 'date' }), issue(5, states[0], { parent: { id: 'parent' } }), issue(6, states[0], { labels: connection([]) })];
  const { client, calls } = fake({ issues, pageSize: 2 });
  const snapshot = await client.snapshot(manifest);
  assert.equal(snapshot.remaining, 9); assert.equal(snapshot.ideas.length, 4); assert.equal(snapshot.existing.length, 6);
  assert.equal(calls.filter(call => call.query.includes('query ProjectIssues')).length, 3);
});
test('workspace and team membership mismatches reject before any writes', async () => {
  for (const config of [{ workspace: 'wrong' }, { membership: 'wrong' }]) {
    const { client, calls } = fake(config);
    await assert.rejects(client.publishProposals(manifest, [proposal], { jobId: 'job', limit: 3 }), /mismatch/);
    assert.equal(calls.some(call => call.query.includes('mutation')), false);
  }
});
test('fresh cap checks stop batch and create only Backlog Idea without ready label', async () => {
  const { client, issues, calls } = fake({ issues: Array.from({ length: 9 }, (_, i) => issue(i + 1)), beforeCreate(input) {
    assert.equal(input.stateId, 'backlog'); assert.deepEqual(input.labelIds, ['idea']); assert.equal(input.id, undefined);
    assert.match(input.description, /## Problem/); assert.match(input.description, /Agent-Team idea: job:1/);
  } });
  const result = await client.publishProposals(manifest, [proposal, { ...proposal, title: 'Second feature' }], { jobId: 'job', limit: 3 });
  assert.equal(result.created.length, 1); assert.equal(result.skipped, 1); assert.equal(issues.length, 10);
  assert.equal(calls.filter(call => call.query.includes('query ProjectIssues')).length, 2);
});
test('durable marker survives lost response and removed label; rejected titles deduplicate', async () => {
  let fail = true;
  const api = fake({ issues: [issue(1, states[2], { title: 'Rejected feature' })], afterCreate() { if (fail) { fail = false; throw new Error('secret-test-key'); } } });
  await assert.rejects(api.client.publishProposals(manifest, [proposal], { jobId: 'retry', limit: 3 }), error => !error.message.includes('secret-test-key'));
  api.issues[1].labels = connection([]); api.issues[1].title = 'Renamed';
  const result = await api.client.publishProposals(manifest, [proposal, { ...proposal, title: 'rejected feature' }], { jobId: 'retry', limit: 3 });
  assert.deepEqual(result, { created: [], skipped: 2 });
});
test('approval is read-only; preparation preserves labels and is idempotent', async () => {
  const approved = issue(1, states[1], { labels: connection([labels[0], { id: 'other', name: 'other' }]) });
  const { client, calls } = fake({ issues: [approved] });
  assert.equal((await client.checkApproved(manifest, 'TEAM-1')).allowed, true);
  assert.equal(calls.some(call => call.query.includes('mutation')), false);
  await client.prepareApproved(manifest, 'TEAM-1'); await client.prepareApproved(manifest, 'TEAM-1');
  assert.deepEqual(approved.labels.nodes.map(label => label.id), ['idea', 'other', 'ready']);
  assert.equal(calls.filter(call => call.query.includes('mutation')).length, 1);
  approved.state = states[0];
  assert.equal((await client.checkApproved(manifest, 'TEAM-1')).allowed, false);
  await assert.rejects(client.prepareApproved(manifest, 'TEAM-1'), /approval/);
});
test('owner inbox comments are returned in order and ignored outside the configured team', async () => {
  const { client } = fake();
  const comments = await client.inboxComments({ ...manifest, ownerInboxIssue: 'TEAM-10' });
  assert.deepEqual(comments.map(c => [c.id, c.author, c.body]), [['c1', 'Owner', 'First request'], ['c2', 'Owner', 'Second request']]);
  assert.deepEqual(await client.inboxComments({ ...manifest, ownerInboxIssue: 'TEAM-10', teamId: 'other' }), []);
  assert.deepEqual(await client.inboxComments(manifest), []);
});
test('decision and repair labels hold an approved idea until removed', () => {
  const approved = { id: 'id', identifier: 'TEAM-1', projectId: 'project', teamId: 'team', parentId: null, archivedAt: null, state: states[1], labels: [labels[0]], blocked: false };
  assert.equal(approvalStatus(manifest, approved).allowed, true);
  for (const name of ['agent:blocked', 'owner:decision']) {
    const held = approvalStatus(manifest, { ...approved, labels: [labels[0], { id: name, name }] });
    assert.equal(held.allowed, false); assert.match(held.reason, /hold/);
  }
  assert.equal(approvalStatus(manifest, { ...approved, labels: [labels[0], { id: 'x', name: 'agent:ready' }] }).allowed, true);
});
test('unfinished blocking relations prevent approval; completed blockers free it', async () => {
  const blocker = { type: 'blocks', issue: { id: 'blocker', state: states[0] } };
  const { client } = fake({ issues: [issue(1, states[1], { inverseRelations: connection([blocker]) })] });
  assert.equal((await client.checkApproved(manifest, 'TEAM-1')).allowed, false);
  blocker.issue.state = states[3];
  assert.equal((await client.checkApproved(manifest, 'TEAM-1')).allowed, true);
});
test('missing states or labels are named without echoing Linear data', async () => {
  const { client } = fake();
  await assert.rejects(client.context({ ...manifest, ideation: { ...ideation, ideaLabel: 'Proposal' } }), /label "Proposal" is missing/);
  await assert.rejects(client.context({ ...manifest, ideation: { ...ideation, approvedState: 'Ready' } }), /workflow state "Ready" is missing/);
});
test('no credential or remote message escapes errors', async () => {
  for (const fetchImpl of [async () => { throw new Error('secret-test-key'); }, async () => ({ ok: false, status: 'secret-test-key' }), async () => ({ ok: true, json: async () => ({ errors: [{ message: 'secret-test-key' }] }) })]) {
    const client = createLinearClient({ apiKey: 'secret-test-key', fetchImpl });
    await assert.rejects(client.context(manifest), error => !error.message.includes('secret-test-key'));
  }
});
test('full cap prevents writes; an external addition is observed before next creation', async () => {
  const full = fake({ issues: Array.from({ length: 10 }, (_, i) => issue(i + 1)) });
  assert.deepEqual(await full.client.publishProposals(manifest, [proposal], { jobId: 'full' }), { created: [], skipped: 1 });
  assert.equal(full.calls.some(call => call.query.includes('mutation')), false);
  const issues = Array.from({ length: 8 }, (_, i) => issue(i + 1));
  const external = fake({ issues, afterCreate() { issues.push(issue(100)); } });
  const result = await external.client.publishProposals(manifest, [proposal, { ...proposal, title: 'Second feature' }], { jobId: 'external' });
  assert.equal(result.created.length, 1); assert.equal(result.skipped, 1);
});
test('labels and blockers beyond their first pages are included', async () => {
  const item = issue(1, states[1], { labels: connection([{ id: 'other', name: 'other' }], true), inverseRelations: connection([], true) });
  // Nested pages are explicit so blockers cannot disappear at page boundaries.
  const client = createLinearClient({ apiKey: 'test-key', fetchImpl: async (_url, options) => {
    const { query } = JSON.parse(options.body);
    let data;
    if (query.includes('query Organization')) data = { organization: { id: 'workspace' } };
    else if (query.includes('query Context')) data = { project: { id: 'project', teams: connection([{ id: 'team' }]) }, team: { id: 'team', states: connection(states), labels: connection(labels) } };
    else if (query.includes('query ProjectIssues')) data = { issues: connection([item]) };
    else if (query.includes('query IssueLabels')) data = { issue: { labels: connection([labels[0]]) } };
    else if (query.includes('query IssueBlockers')) data = { issue: { inverseRelations: connection([{ type: 'blocks', issue: { state: states[0] } }]) } };
    else assert.fail('Unexpected operation');
    return { ok: true, json: async () => ({ data }) };
  } });
  const snapshot = await client.snapshot(manifest);
  assert.equal(snapshot.ideas.length, 1); assert.equal(snapshot.ideas[0].blocked, true);
  assert.equal(snapshot.ideas[0].labels.length, 2);
});
