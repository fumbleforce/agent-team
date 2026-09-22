import test from 'node:test';
import assert from 'node:assert/strict';
import { newId } from '@agent-team/protocol';
import { boot } from './testing.ts';

// A GitHub tracker recorded enough to answer the calls an approval makes: the label write and the snapshot that follows it.
const github = (options: { issues?: unknown[]; refuse?: boolean } = {}) => {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const request = (async (url: string | URL, init?: RequestInit) => {
    const call = { method: init?.method ?? 'GET', url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    if (call.method === 'POST' && /\/labels$/.test(call.url)) {
      if (options.refuse) return new Response(JSON.stringify({ message: 'nope' }), { status: 500 });
      return Response.json([{ name: 'agent:approved' }]);
    }
    if (call.method === 'GET' && /\/issues\?state=all/.test(call.url)) return Response.json(options.issues ?? [{ number: 99, title: 'An idea', body: '', state: 'open', labels: ['idea', 'agent:approved'] }]);
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  return { calls, fetch: request };
};

const MANIFEST = { tracker: { kind: 'github', repository: 'acme/shop' }, ideation: { enabled: true, backlogCap: 8, batchSize: 3, minimumIntervalHours: 24, ideaLabel: 'idea', proposedState: 'idea:proposed', approvedState: 'agent:approved', rejectedState: 'closed' } };

async function heldProject(booted: Awaited<ReturnType<typeof boot>>) {
  const cookie = await booted.owner();
  const projectId = await booted.project('shop');
  await booted.db.updateTable('projects').set({ manifest: JSON.stringify(MANIFEST) }).where('id', '=', projectId).execute();
  const taskId = newId();
  await booted.db.insertInto('tasks').values({ id: taskId, project_id: projectId, key: 'GH-99', source: 'tracker', title: 'An idea', brief: '', tag: null, priority: 0, milestone_id: null, state: 'backlog', assignee_agent_id: null, author_agent_id: null, branch: null, head_sha: null, pr_url: null, blocked_reason: 'Owner approval required', created_at: 1, updated_at: 1 }).execute();
  await booted.db.insertInto('external_refs').values({ entity_type: 'task', entity_id: taskId, system: 'github', external_id: 'GH-99', url: 'https://github.com/acme/shop/issues/99', synced_at: 1, remote_version: null }).execute();
  return { cookie, projectId, taskId };
}

test('an idea waiting for approval is approved from the board: the tracker takes the approval, and the hold says it is being made ready', async () => {
  const host = github();
  const booted = await boot({ env: { GITHUB_ISSUES_TOKEN: 'gh-token' }, fetch: host.fetch });
  try {
    const { cookie, taskId } = await heldProject(booted);
    assert.equal((await booted.call(`/api/tasks/${taskId}/approve`, { cookie, body: {} })).status, 200);
    // The approval went to the idea's issue as the approved label, and the snapshot that followed it agreed.
    assert.deepEqual(host.calls.map(call => [call.method, /\/labels$/.test(call.url) ? 'label' : /\/issues\?state=all/.test(call.url) ? 'snapshot' : call.url]), [['POST', 'label'], ['GET', 'snapshot']]);
    assert.match(JSON.stringify(host.calls[0]!.body), /agent:approved/);
    const row = await booted.db.selectFrom('tasks').select(['blocked_reason', 'state']).where('id', '=', taskId).executeTakeFirstOrThrow();
    assert.equal(row.blocked_reason, 'Approved; being marked ready');
    // The decision stays with the task, and the change is in the log.
    assert.deepEqual(((await booted.call(`/api/tasks/${taskId}`, { cookie })).json.messages as { kind: string; body: string }[]).map(message => [message.kind, message.body]), [['decision', 'Approved.']]);
    const change = await booted.db.selectFrom('events').select('payload').where('task_id', '=', taskId).where('type', '=', 'task.state_changed').executeTakeFirstOrThrow();
    assert.match(change.payload, /"reason":"approved"/);
    // Twice is refused: it no longer waits for approval.
    assert.equal((await booted.call(`/api/tasks/${taskId}/approve`, { cookie, body: {} })).status, 409);
  } finally { await booted.coordinator.close(); }
});

test('an approval is refused where the tracker cannot take it: a refusal from the tracker, or a tracker that does not read the approval back', async () => {
  const failing = github({ refuse: true });
  const booted = await boot({ env: { GITHUB_ISSUES_TOKEN: 'gh-token' }, fetch: failing.fetch });
  try {
    const { cookie, taskId } = await heldProject(booted);
    const refused = await booted.call(`/api/tasks/${taskId}/approve`, { cookie, body: {} });
    assert.equal(refused.status, 502);
    assert.match(refused.json.error.message, /refused the approval/);
    // Nothing changed locally: the idea still waits.
    assert.equal((await booted.db.selectFrom('tasks').select('blocked_reason').where('id', '=', taskId).executeTakeFirstOrThrow()).blocked_reason, 'Owner approval required');
  } finally { await booted.coordinator.close(); }

  const unmarked = github({ issues: [{ number: 99, title: 'An idea', body: '', state: 'open', labels: ['idea', 'idea:proposed'] }] });
  const tracker = await boot({ env: { GITHUB_ISSUES_TOKEN: 'gh-token' }, fetch: unmarked.fetch });
  try {
    const { cookie, taskId } = await heldProject(tracker);
    const disagreed = await tracker.call(`/api/tasks/${taskId}/approve`, { cookie, body: {} });
    assert.equal(disagreed.status, 409);
    assert.match(disagreed.json.error.message, /approve it there instead/);
    assert.equal((await tracker.db.selectFrom('tasks').select('blocked_reason').where('id', '=', taskId).executeTakeFirstOrThrow()).blocked_reason, 'Owner approval required');
  } finally { await tracker.coordinator.close(); }
});

test('what does not wait for approval cannot be approved, and people without a say cannot approve', async () => {
  const booted = await boot();
  try {
    const { cookie, taskId } = await heldProject(booted);
    await booted.db.updateTable('tasks').set({ source: 'internal', blocked_reason: null }).where('id', '=', taskId).execute();
    assert.equal((await booted.call(`/api/tasks/${taskId}/approve`, { cookie, body: {} })).status, 409);
    const outsider = await booted.person('olga', 'member');
    assert.equal((await booted.call(`/api/tasks/${taskId}/approve`, { cookie: outsider.cookie, body: {} })).status, 403);
  } finally { await booted.coordinator.close(); }
});