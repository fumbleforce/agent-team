import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createQueue } from './queue.mjs';

// The alert is about job states, not about personas, so the team store is seeded with one synthetic
// document instead of the shipped blueprints. No model, no engine and no network are involved.
const prompt = 'Synthetic prompt for a test team.';
const member = name => ({ name, title: 'test', voice: 'test' });
const team = () => [{
  id: 'default', name: 'Test team', description: '',
  roster: { 'team-coordinator': member('Coordinator'), 'team-pm': member('PM'), 'team-owner': member('Owner'), 'team-dev': member('Dev') },
  defaultRoles: ['team-dev'],
  agents: {
    'team-coordinator': { mode: 'primary', description: 'coordinator', prompt },
    'team-owner': { mode: 'primary', description: 'owner', prompt },
    'team-pm': { mode: 'subagent', description: 'pm', prompt },
    'team-dev': { mode: 'subagent', description: 'dev', prompt },
  },
}];

const manifest = (overrides = {}) => ({
  version: 2, name: 'Myntbase', instructions: [], scm: { kind: 'github', repository: 'owner/repo' },
  tracker: { kind: 'github', repository: 'owner/repo', readyLabel: 'agent:ready', ownerInboxIssue: 'GH-4', ...overrides },
  team: { roles: ['team-dev'] },
});

// A tracker stub with the adapter's postComment shape; it records instead of calling an API.
const recorder = () => { const comments = []; return { comments, postComment: async (flat, issue, body) => { comments.push({ repository: flat.repository, issue, body }); return { id: String(comments.length) }; } }; };

const projects = { a: {}, b: {} };
const start = (queue, projectId, issue) => {
  queue.enqueue({ projectId, issue });
  return queue.claim({ workerId: 'w', projectIds: [projectId] });
};
const hold = (queue, job, summary) => queue.fail(job.id, { workerId: job.workerId, leaseToken: job.leaseToken, result: { outcome: 'failed', summary } });

const withQueue = async (options, body) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'team-stall-'));
  const queue = createQueue(path.join(dir, 'queue.sqlite'), { projects, seedTeams: team, ...options });
  try { await body(queue, dir); } finally { queue.close(); rmSync(dir, { recursive: true, force: true }); }
};

test('a quarantined project raises one owner comment naming project, jobs, reason and dashboard', async () => {
  const tracker = recorder();
  await withQueue({ tracker, dashboardUrl: 'http://127.0.0.1:4311/' }, async queue => {
    queue.registerProject('a', { workerId: 'w', manifest: manifest() });
    const first = start(queue, 'a', 'GH-11');
    hold(queue, first, 'supervisor crashed; inspect descendants');
    await queue.watchdog();
    assert.equal(tracker.comments.length, 1);
    const [comment] = tracker.comments;
    assert.equal(comment.issue, 'GH-4');
    assert.equal(comment.repository, 'owner/repo', 'the tracker section reaches the adapter as the flat manifest');
    assert.match(comment.body, /Myntbase \(a\) is on hold/);
    assert.ok(comment.body.includes(first.id), 'the comment names the held job id');
    assert.match(comment.body, /GH-11/);
    assert.match(comment.body, /failed: supervisor crashed; inspect descendants/);
    assert.match(comment.body, /Dashboard: http:\/\/127\.0\.0\.1:4311\/projects\/a/);
    assert.ok(comment.body.length < 6000, 'GitHub refuses bodies over 6000 characters');
  });
});

test('further failures in one stall stay silent and the next completed job posts one resolved note', async () => {
  const tracker = recorder();
  await withQueue({ tracker }, async queue => {
    queue.registerProject('a', { workerId: 'w', manifest: manifest() });
    const first = start(queue, 'a', 'GH-11');
    hold(queue, first, 'engine exited 1');
    await queue.watchdog();
    await queue.watchdog();
    assert.equal(tracker.comments.length, 1, 'the same stall is never reported twice');
    assert.match(tracker.comments[0].body, /Dashboard: no address is configured/);
    // Inspected, requeued and failed again: still the same stall.
    queue.requeue(first.id);
    const retry = queue.claim({ workerId: 'w', projectIds: ['a'] });
    hold(queue, retry, 'engine exited 1 again');
    await queue.watchdog();
    assert.equal(tracker.comments.length, 1);
    queue.requeue(retry.id);
    const good = queue.claim({ workerId: 'w', projectIds: ['a'] });
    queue.complete(good.id, { workerId: good.workerId, leaseToken: good.leaseToken, result: { outcome: 'ready', summary: 'delivered' } });
    await queue.watchdog();
    assert.equal(tracker.comments.length, 2);
    assert.match(tracker.comments[1].body, /Myntbase \(a\) is running again/);
    assert.ok(tracker.comments[1].body.includes(good.id));
    await queue.watchdog();
    assert.equal(tracker.comments.length, 2, 'recovery is reported once');
    // A later stall is a new one and reports again.
    const next = start(queue, 'a', 'GH-12');
    hold(queue, next, 'worktree missing');
    await queue.watchdog();
    assert.equal(tracker.comments.length, 3);
    assert.match(tracker.comments[2].body, /worktree missing/);
  });
});

test('the stall alert survives a coordinator restart without repeating itself', async () => {
  const tracker = recorder();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'team-stall-'));
  const dbPath = path.join(dir, 'queue.sqlite');
  let queue = createQueue(dbPath, { projects, seedTeams: team, tracker });
  try {
    queue.registerProject('a', { workerId: 'w', manifest: manifest() });
    const job = start(queue, 'a', 'GH-11');
    hold(queue, job, 'engine exited 1');
    await queue.watchdog();
    assert.equal(tracker.comments.length, 1);
    queue.close();
    queue = createQueue(dbPath, { projects, seedTeams: team, tracker });
    await queue.watchdog();
    assert.equal(tracker.comments.length, 1);
  } finally { queue.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('projects without an owner inbox, with the alert off, or still working are left alone', async () => {
  const tracker = recorder();
  await withQueue({ tracker }, async queue => {
    queue.registerProject('a', { workerId: 'w', manifest: manifest({ ownerInboxIssue: undefined }) });
    queue.registerProject('b', { workerId: 'w', manifest: manifest({ stallAlertAfter: 0 }) });
    for (const projectId of ['a', 'b']) hold(queue, start(queue, projectId, 'GH-11'), 'engine exited 1');
    await queue.watchdog();
    assert.deepEqual(tracker.comments, []);
  });
  await withQueue({ tracker }, async queue => {
    queue.registerProject('a', { workerId: 'w', manifest: manifest() });
    const job = start(queue, 'a', 'GH-11');
    await queue.watchdog();
    assert.deepEqual(tracker.comments, [], 'a running job is not a stall');
    queue.complete(job.id, { workerId: job.workerId, leaseToken: job.leaseToken, result: { outcome: 'ready', summary: 'done' } });
    await queue.watchdog();
    assert.deepEqual(tracker.comments, [], 'and a completed job without a stall raises no resolved note');
  });
});

test('a lost lease alerts once, a threshold holds the alert back and a tracker failure is retried', async () => {
  let time = 1_000;
  const tracker = recorder();
  await withQueue({ tracker, now: () => time, leaseMs: 90 }, async queue => {
    queue.registerProject('a', { workerId: 'w', manifest: manifest() });
    start(queue, 'a', 'GH-11');
    time = 2_000;
    // Nothing else touched the database; the watchdog itself must commit the expiry it reports on.
    await queue.watchdog();
    assert.equal(tracker.comments.length, 1);
    assert.match(tracker.comments[0].body, /blocked: Lease expired/);
  });
  const second = recorder();
  await withQueue({ tracker: second }, async queue => {
    queue.registerProject('a', { workerId: 'w', manifest: manifest({ stallAlertAfter: 2 }) });
    hold(queue, start(queue, 'a', 'GH-11'), 'engine exited 1');
    await queue.watchdog();
    assert.deepEqual(second.comments, [], 'one held job is below the configured threshold');
  });
  const errors = [];
  const failing = { postComment: async () => { throw new Error('tracker unreachable'); } };
  await withQueue({ tracker: failing, onAlertError: error => errors.push(error.message) }, async queue => {
    queue.registerProject('a', { workerId: 'w', manifest: manifest() });
    hold(queue, start(queue, 'a', 'GH-11'), 'engine exited 1');
    await assert.doesNotReject(() => queue.watchdog());
    await queue.watchdog();
    assert.deepEqual(errors, ['tracker unreachable', 'tracker unreachable'], 'a failed post is reported and tried again');
  });
});
