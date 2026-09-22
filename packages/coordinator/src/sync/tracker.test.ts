import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '@agent-team/storage';
import { createContext } from '../context.ts';
import { createWorkspace } from '../repos/workspace.ts';
import { createTurns } from '../runtime/turns.ts';
import { boot } from '../http/testing.ts';
import type { Viewer } from '../auth/rbac.ts';
import { approvalStatus, createTrackerSync, ideationOf, taskStateOf, type TrackerClient, type TrackerComment, type TrackerIssue } from './tracker.ts';

const issue = (identifier: string, title: string, type: string, labels: string[] = [], name = type, extra: Partial<TrackerIssue> = {}): TrackerIssue => ({ identifier, title, state: { name, type }, labels: labels.map(label => ({ name: label })), url: `https://tracker.example/${identifier}`, updatedAt: '2026-01-01T00:00:00Z', ...extra });
const IDEATION = { enabled: true, backlogCap: 3, batchSize: 2, minimumIntervalHours: 24, ideaLabel: 'idea', proposedState: 'Proposed', approvedState: 'Todo', rejectedState: 'Canceled' };
const VIEWER = { userId: 'user-1', orgRole: 'owner', projects: new Map() } as Viewer;
const PROPOSAL = { title: 'Saved carts', problem: 'Carts are lost', benefit: 'More orders', scope: 'Persist the cart', successCriteria: ['Cart survives a reload'], effort: 'M' as const, evidence: ['Three support tickets'], whyNow: 'Peak season' };

// A tracker that remembers what was written to it.
function fakeTracker(initial: TrackerIssue[]) {
  const remote = { issues: initial, writes: [] as unknown[][], comments: new Map<string, TrackerComment[]>(), down: false, refuse: false };
  const write = (entry: unknown[]) => { if (remote.refuse) throw new Error('Tracker HTTP request failed (403)'); remote.writes.push(entry); };
  const client: Required<TrackerClient> = {
    snapshot: async () => { if (remote.down) throw new Error('Tracker HTTP request failed (503)'); return { allIssues: structuredClone(remote.issues) }; },
    setState: async (_manifest, identifier, state) => write(['state', identifier, state]),
    comment: async (_manifest, identifier, body) => { write(['comment', identifier, body]); return { id: `out-${remote.writes.length}` }; },
    comments: async (_manifest, identifier) => remote.comments.get(identifier) ?? [],
    addLabel: async (_manifest, identifier, label) => write(['label', identifier, label]),
    createIssue: async (_manifest, input) => { write(['issue', input.title, input.state, input.labels, input.body]); return { identifier: `GH-${100 + remote.writes.length}`, url: null }; },
  };
  return { remote, client };
}

async function setup(manifest: Record<string, unknown> = { tracker: { kind: 'fake' } }) {
  const storage = await createStorage({ kind: 'sqlite', path: ':memory:' });
  await storage.migrate();
  const clock = { now: 1_800_000_000_000 };
  const context = createContext({ storage, machineToken: 'x'.repeat(24), now: () => clock.now++ });
  const workspace = createWorkspace(context);
  const projectId = await workspace.registerProject({ slug: 'shop', name: 'Shop', kind: 'repo', manifest });
  const task = async (key: string) => storage.db.selectFrom('tasks').selectAll().where('key', '=', key).executeTakeFirst();
  return { storage, context, workspace, projectId, clock, task, sync: createTrackerSync(context, createTurns(context)) };
}

test('tracker states and progress labels map onto board columns', () => {
  assert.equal(taskStateOf(issue('A-1', 't', 'backlog')), 'backlog');
  assert.equal(taskStateOf(issue('A-1', 't', 'unstarted', ['agent:in-progress'])), 'in_progress');
  assert.equal(taskStateOf(issue('A-1', 't', 'started', [], 'In Review')), 'in_review');
  assert.equal(taskStateOf(issue('A-1', 't', 'completed')), 'done');
  assert.equal(taskStateOf(issue('A-1', 't', 'canceled')), 'canceled');
});

test('a poll mirrors issues and records where each lives; remote wins for title and state, local working states are kept', async () => {
  const { storage, projectId, sync, task } = await setup();
  try {
    const { remote, client } = fakeTracker([issue('GH-1', 'Pay button hangs', 'unstarted', ['payments', 'agent:ready']), issue('GH-2', 'Old idea', 'canceled')]);
    const first = await sync.syncProject(projectId, client);
    assert.deepEqual([first.created, first.updated], [1, 0]);
    const again = await sync.syncProject(projectId, client);
    assert.deepEqual([again.created, again.updated], [0, 0]);
    const mirrored = (await task('GH-1'))!;
    assert.deepEqual([mirrored.tag, mirrored.state], ['payments', 'backlog']);
    const ref = await storage.db.selectFrom('external_refs').selectAll().where('entity_type', '=', 'task').executeTakeFirstOrThrow();
    assert.deepEqual([ref.entity_id, ref.system, ref.external_id, ref.url, ref.remote_version], [mirrored.id, 'fake', 'GH-1', 'https://tracker.example/GH-1', '2026-01-01T00:00:00Z']);

    // Assigned is still the backlog column over there: the poll leaves the finer local state alone.
    await storage.db.updateTable('tasks').set({ state: 'assigned' }).where('id', '=', mirrored.id).execute();
    await sync.syncProject(projectId, client);
    assert.equal((await task('GH-1'))!.state, 'assigned');

    await storage.db.updateTable('tasks').set({ state: 'awaiting_decision' }).where('id', '=', mirrored.id).execute();
    remote.issues = [issue('GH-1', 'Pay button hangs on Safari', 'started', ['payments'], 'started', { updatedAt: '2026-01-02T00:00:00Z' })];
    await sync.syncProject(projectId, client);
    const kept = (await task('GH-1'))!;
    assert.deepEqual([kept.title, kept.state], ['Pay button hangs on Safari', 'awaiting_decision']);
    assert.equal((await storage.db.selectFrom('external_refs').select('remote_version').where('entity_type', '=', 'task').executeTakeFirstOrThrow()).remote_version, '2026-01-02T00:00:00Z');

    remote.issues = [issue('GH-1', 'Pay button hangs on Safari', 'completed')];
    await sync.syncProject(projectId, client);
    assert.equal((await task('GH-1'))!.state, 'done');
    assert.deepEqual(remote.writes, [], 'what came from the tracker is never written back to it');
  } finally { await storage.close(); }
});

test('moving a card writes to the tracker; when the issue moved there too, the remote wins', async () => {
  const { storage, workspace, projectId, sync, task } = await setup();
  try {
    const { remote, client } = fakeTracker([issue('GH-1', 'Pay button hangs', 'unstarted'), issue('GH-2', 'Coupons', 'unstarted')]);
    await sync.syncProject(projectId, client);
    const [one, two] = [(await task('GH-1'))!, (await task('GH-2'))!];

    await workspace.moveTask(VIEWER, one.id, 'in_progress');
    await workspace.moveTask(VIEWER, one.id, 'awaiting_decision');
    await sync.syncProject(projectId, client);
    assert.deepEqual(remote.writes, [['state', 'GH-1', 'started']], 'one write for the column, none for the finer state within it');
    assert.equal((await task('GH-1'))!.state, 'awaiting_decision', 'the stale snapshot of the same poll does not undo the move');

    // Both sides move GH-2 between two polls: the card to review here, the issue to done there.
    remote.issues = [issue('GH-1', 'Pay button hangs', 'started'), issue('GH-2', 'Coupons', 'completed')];
    await workspace.moveTask(VIEWER, two.id, 'in_review');
    await sync.syncProject(projectId, client);
    assert.equal(remote.writes.length, 1, 'the conflicting move is not pushed');
    assert.equal((await task('GH-2'))!.state, 'done');

    // A refused write is reported and the move stands: the tracker refusing is no reason to undo the team's work. It is told again
    // on the next poll, which the tracker accepts.
    remote.refuse = true;
    await workspace.moveTask(VIEWER, one.id, 'in_review');
    await sync.syncProject(projectId, client);
    assert.match((await sync.status(projectId)).find(row => row.resource === 'tracker.outbound')!.error ?? '', /403/);
    assert.equal((await task('GH-1'))!.state, 'in_review');
    remote.refuse = false;
    await sync.syncProject(projectId, client);
    assert.equal((await task('GH-1'))!.state, 'in_review');
    assert.deepEqual(remote.writes.slice(1), [['state', 'GH-1', 'in_review']]);
  } finally { await storage.close(); }
});

test('a move the platform made without announcing it still reaches the tracker, and the tracker\'s older column never undoes it', async () => {
  const { storage, projectId, sync, task } = await setup();
  try {
    const { remote, client } = fakeTracker([issue('GH-1', 'Pay button hangs', 'unstarted')]);
    await sync.syncProject(projectId, client);
    const one = (await task('GH-1'))!;

    // Moved the way a claimed work turn used to move it: the row changed and no event said so.
    await storage.db.updateTable('tasks').set({ state: 'in_progress' }).where('id', '=', one.id).execute();
    await sync.syncProject(projectId, client);
    assert.deepEqual(remote.writes, [['state', 'GH-1', 'started']]);
    assert.equal((await task('GH-1'))!.state, 'in_progress', 'the issue, still unstarted in this poll, does not pull it back');

    // Merged here: the issue is closed there.
    remote.issues = [issue('GH-1', 'Pay button hangs', 'started')];
    await storage.db.updateTable('tasks').set({ state: 'done' }).where('id', '=', one.id).execute();
    await sync.syncProject(projectId, client);
    assert.deepEqual(remote.writes.at(-1), ['state', 'GH-1', 'completed']);
    assert.equal((await task('GH-1'))!.state, 'done');

    // Reopened over there after both agreed it was done: that side moved, so it wins, and nothing is pushed back over it.
    remote.issues = [issue('GH-1', 'Pay button hangs', 'completed')];
    await sync.syncProject(projectId, client);
    remote.issues = [issue('GH-1', 'Pay button hangs', 'unstarted')];
    await sync.syncProject(projectId, client);
    assert.equal((await task('GH-1'))!.state, 'backlog');
    assert.equal(remote.writes.length, 2);
  } finally { await storage.close(); }
});

test('thread messages become tracker comments and tracker comments become messages, and neither comes back', async () => {
  const { storage, workspace, projectId, sync, task } = await setup();
  try {
    const { remote, client } = fakeTracker([issue('GH-1', 'Pay button hangs', 'started')]);
    await sync.syncProject(projectId, client);
    const mirrored = (await task('GH-1'))!;

    // A comment over there arrives in the task's thread, which is made when first needed.
    remote.issues = [issue('GH-1', 'Pay button hangs', 'started', [], 'started', { updatedAt: '2026-01-03T00:00:00Z' })];
    remote.comments.set('GH-1', [{ id: 'c-1', body: 'Also on Firefox', author: 'owner', createdAt: '2026-01-03T00:00:00Z' }]);
    assert.equal((await sync.syncProject(projectId, client)).comments, 1);
    const thread = await storage.db.selectFrom('threads').selectAll().where('subject_type', '=', 'task').where('subject_id', '=', mirrored.id).executeTakeFirstOrThrow();
    const [inbound] = await workspace.messages(thread.id, { limit: 5 });
    assert.deepEqual([inbound!.body, (inbound!.payload as { origin?: string }).origin], ['Also on Firefox', 'tracker']);

    // An answer in the thread goes out once, with the marker of where it came from.
    await workspace.postMessage({ kind: 'user', id: null }, { id: thread.id, project_id: projectId }, { body: 'Reproduced, fixing', kind: 'note' });
    await sync.syncProject(projectId, client);
    assert.equal(remote.writes.length, 1, 'the inbound comment is not echoed back');
    const [, identifier, body] = remote.writes[0] as [string, string, string];
    assert.equal(identifier, 'GH-1');
    assert.match(body, /^\*\*Owner\*\*: Reproduced, fixing\n\n<!-- agent-team:[\w-]+ -->$/);

    // The tracker now returns both comments: ours carries the marker, the other is already known.
    remote.issues = [issue('GH-1', 'Pay button hangs', 'started', [], 'started', { updatedAt: '2026-01-04T00:00:00Z' })];
    remote.comments.set('GH-1', [...remote.comments.get('GH-1')!, { id: 'out-1', body, author: 'bot', createdAt: '2026-01-04T00:00:00Z' }]);
    assert.equal((await sync.syncProject(projectId, client)).comments, 0);
    await sync.syncProject(projectId, client);
    assert.equal((await workspace.messages(thread.id, { limit: 10 })).length, 2);
    assert.equal(remote.writes.length, 1);
    assert.equal((await storage.db.selectFrom('external_refs').select('external_id').where('entity_type', '=', 'message').execute()).length, 2);
  } finally { await storage.close(); }
});

test('an idea becomes a task only while its owner approves it', async () => {
  const config = ideationOf({ ideation: IDEATION })!;
  assert.deepEqual([approvalStatus(config, issue('GH-1', 'i', 'unstarted', ['idea'], 'Todo')).allowed, approvalStatus(config, issue('GH-1', 'i', 'backlog', ['idea'], 'Proposed')).reason], [true, 'Owner approval required']);
  assert.equal(approvalStatus(config, issue('GH-1', 'i', 'unstarted', ['idea', 'owner:decision'], 'Todo')).allowed, false);
  assert.equal(approvalStatus(config, issue('GH-1', 'i', 'unstarted', ['idea'], 'Todo', { blocked: true })).allowed, false);
  assert.equal(approvalStatus(config, issue('GH-1', 'i', 'unstarted', ['idea'], 'Todo', { child: true })).allowed, false);
  assert.equal(ideationOf({ ideation: { ...IDEATION, enabled: false } }), null);

  const { storage, projectId, sync, task } = await setup({ tracker: { kind: 'fake', readyLabel: 'agent:ready' }, ideation: { ...IDEATION, minimumIntervalHours: 168 } });
  try {
    const { remote, client } = fakeTracker([issue('GH-1', 'Saved carts', 'backlog', ['idea'], 'Proposed'), issue('GH-2', 'A plain bug', 'unstarted')]);
    // The schedule exists but is not due, so this test is about approval only.
    await storage.db.insertInto('schedules').values({ id: 's1', project_id: projectId, kind: 'ideate', interval_ms: 168 * 3_600_000, next_at: 9e15, last_at: null }).execute();
    await sync.syncProject(projectId, client);
    // Everything in the tracker is on the board; what waits for the owner is shown held, with the reason, and cannot be handed out.
    const proposed = (await task('GH-1'))!;
    assert.deepEqual([proposed.state, proposed.blocked_reason], ['backlog', 'Owner approval required'], 'a proposed idea is shown, held');
    assert.equal((await task('GH-2'))!.state, 'backlog');

    remote.issues[0] = issue('GH-1', 'Saved carts', 'unstarted', ['idea'], 'Todo');
    await sync.syncProject(projectId, client);
    assert.deepEqual(remote.writes, [['label', 'GH-1', 'agent:ready']], 'the approved idea is prepared for the team');
    const approved = (await task('GH-1'))!;
    assert.deepEqual([approved.state, approved.blocked_reason], ['backlog', null], 'approval lifts the hold');
    await storage.db.insertInto('work_items').values({ id: 'w1', agent_id: (await storage.db.selectFrom('agents').select('id').executeTakeFirstOrThrow()).id, project_id: projectId, kind: 'work', lane: 'work', task_id: approved.id, thread_id: null, priority_class: 5, state: 'queued', defer_reason: null, not_before: null, dedupe_key: null, cause_event_id: null, created_at: 1 }).execute();

    // The owner takes the approval back before anyone started: the task is held again, still on the board, and its queued work is taken off.
    remote.issues[0] = issue('GH-1', 'Saved carts', 'backlog', ['idea', 'agent:ready'], 'Proposed');
    assert.equal((await sync.syncProject(projectId, client)).canceled, 1);
    await sync.syncProject(projectId, client);
    assert.deepEqual([(await task('GH-1'))!.state, (await task('GH-1'))!.blocked_reason], ['backlog', 'Owner approval required']);
    assert.equal((await storage.db.selectFrom('work_items').select('state').where('id', '=', 'w1').executeTakeFirstOrThrow()).state, 'canceled');
    assert.equal(remote.writes.length, 1, 'withdrawing is the owner’s act; nothing is written back');

    // Approved again, it returns to the backlog. Withdrawn while in progress, it is left to the team.
    remote.issues[0] = issue('GH-1', 'Saved carts', 'unstarted', ['idea', 'agent:ready'], 'Todo');
    await sync.syncProject(projectId, client);
    assert.equal((await task('GH-1'))!.state, 'backlog');
    await storage.db.updateTable('tasks').set({ state: 'in_progress' }).where('id', '=', approved.id).execute();
    remote.issues[0] = issue('GH-1', 'Saved carts', 'started', ['idea', 'agent:ready', 'owner:decision'], 'In Progress');
    await sync.syncProject(projectId, client);
    assert.equal((await task('GH-1'))!.state, 'in_progress');
  } finally { await storage.close(); }
});

test('the PM is asked for ideas when the schedule is due and the backlog has room; its ideas become proposed issues', async () => {
  const { storage, context, projectId, sync, clock } = await setup({ tracker: { kind: 'fake' }, ideation: IDEATION });
  try {
    const { remote, client } = fakeTracker([issue('GH-1', 'Wishlist', 'backlog', ['idea'], 'Proposed'), issue('GH-2', 'Gift cards', 'completed', ['idea'], 'Done')]);
    assert.equal((await sync.syncProject(projectId, client)).ideating, true);
    const asked = await storage.db.selectFrom('work_items').innerJoin('agents', 'agents.id', 'work_items.agent_id').select(['work_items.id', 'work_items.kind', 'agents.is_pm', 'agents.id as agent_id']).where('work_items.kind', '=', 'ideate').execute();
    assert.deepEqual(asked.map(row => [row.kind, Boolean(row.is_pm)]), [['ideate', true]]);
    const schedule = await storage.db.selectFrom('schedules').selectAll().where('kind', '=', 'ideate').executeTakeFirstOrThrow();
    assert.equal(Number(schedule.next_at) - Number(schedule.last_at), 24 * 3_600_000);

    // The turn's ideas are events; the next poll publishes them, up to the cap, skipping what exists already.
    await storage.db.updateTable('work_items').set({ state: 'done' }).where('id', '=', asked[0]!.id).execute();
    const published = await storage.transaction(tx => context.events.append(tx, [{ type: 'ideation.proposed', actorKind: 'agent', agentId: asked[0]!.agent_id, projectId, turnId: 'turn-1', payload: { proposals: [PROPOSAL, { ...PROPOSAL, title: ' wishlist ' }] } }]));
    context.events.published(published);
    assert.equal((await sync.syncProject(projectId, client)).ideating, false, 'the cooldown holds');
    assert.equal(remote.writes.length, 1);
    const [, title, state, labels, body] = remote.writes[0] as [string, string, string, string[], string];
    assert.deepEqual([title, state, labels], ['Saved carts', 'Proposed', ['idea']]);
    assert.match(body, /## Problem\nCarts are lost[\s\S]*## Size\nM \(relative scope[\s\S]*\n\nAgent-Team idea: turn-1:1$/);
    const event = await storage.db.selectFrom('events').select('payload').where('type', '=', 'ideation.published').executeTakeFirstOrThrow();
    assert.deepEqual(JSON.parse(event.payload), { created: ['GH-101'], skipped: 1 });
    await sync.syncProject(projectId, client);
    assert.equal(remote.writes.length, 1, 'published once');

    // Due again, but the backlog is full: nobody is asked.
    clock.now += 25 * 3_600_000;
    remote.issues = [issue('GH-1', 'Wishlist', 'backlog', ['idea'], 'Proposed'), issue('GH-3', 'B', 'backlog', ['idea'], 'Proposed'), issue('GH-4', 'C', 'unstarted', ['idea'], 'Todo', { blocked: true })];
    assert.equal((await sync.syncProject(projectId, client)).ideating, false);
    remote.issues.pop();
    assert.equal((await sync.syncProject(projectId, client)).ideating, true);
  } finally { await storage.close(); }
});

test('a failing poll is recorded with since when, shown with the integrations, and cleared by the next good one', async () => {
  const { remote, client } = fakeTracker([issue('GH-9', 'From the tracker', 'unstarted')]);
  const harness = await boot({ trackers: async kind => (kind === 'fake' ? client : null) });
  try {
    const cookie = await harness.owner();
    const workspace = createWorkspace(harness.coordinator.context);
    const good = await workspace.registerProject({ slug: 'good', name: 'Good', kind: 'repo', manifest: { tracker: { kind: 'fake' } } });
    await workspace.registerProject({ slug: 'none', name: 'None', kind: 'repo', manifest: {} });
    remote.down = true;
    await harness.coordinator.poll();
    await harness.coordinator.poll();
    const failing = (await harness.call('/api/projects/good/integrations', { cookie })).json.sync as { resource: string; lastOkAt: number | null; error: string | null; failingSince: number | null }[];
    const row = failing.find(item => item.resource === 'tracker')!;
    assert.deepEqual([row.lastOkAt, row.error], [null, 'Tracker HTTP request failed (503)']);
    assert.ok(row.failingSince);

    remote.down = false;
    await harness.coordinator.poll();
    const healthy = ((await harness.call('/api/projects/good/integrations', { cookie })).json.sync as typeof failing).find(item => item.resource === 'tracker')!;
    assert.deepEqual([healthy.error, healthy.failingSince, typeof healthy.lastOkAt], [null, null, 'number']);
    const tasks = await harness.db.selectFrom('tasks').select(['project_id', 'key']).execute();
    assert.deepEqual(tasks.map(task => [task.project_id, task.key]), [[good, 'GH-9']]);
    assert.deepEqual((await harness.call('/api/projects/none/integrations', { cookie })).json.sync, []);
  } finally { await harness.coordinator.close(); }
});

test('the coordinator polls each project with a tracker and survives one that fails', async () => {
  const { startCoordinator } = await import('../server.ts');
  const coordinator = await startCoordinator({ port: 0, storage: { kind: 'sqlite', path: ':memory:' }, machineToken: 'x'.repeat(24), webRoot: null, scm: null,
    trackers: async kind => (kind === 'broken' ? { snapshot: async () => { throw new Error('down'); } } : { snapshot: async () => ({ allIssues: [issue('GH-9', 'From the tracker', 'unstarted')] }) }) });
  try {
    const workspace = createWorkspace(coordinator.context);
    await workspace.registerProject({ slug: 'bad', name: 'Bad', kind: 'repo', manifest: { tracker: { kind: 'broken' } } });
    const good = await workspace.registerProject({ slug: 'good', name: 'Good', kind: 'repo', manifest: { tracker: { kind: 'github' } } });
    await workspace.registerProject({ slug: 'none', name: 'None', kind: 'repo', manifest: {} });
    await coordinator.poll();
    const tasks = await coordinator.context.storage.db.selectFrom('tasks').select(['project_id', 'key']).execute();
    assert.deepEqual(tasks.map(task => [task.project_id, task.key]), [[good, 'GH-9']]);
  } finally { await coordinator.close(); }
});
