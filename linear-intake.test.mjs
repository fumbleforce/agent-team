import test from 'node:test';
import assert from 'node:assert/strict';
import { pollProject, runIntake } from './linear-intake.mjs';

const manifest = { queueProjectId: 'example', projectId: 'project', teamId: 'team', delivery: { autoMergeAuthorized: true }, ideation: { enabled: true, backlogCap: 10, batchSize: 3, minimumIntervalHours: 24, ideaLabel: 'Idea', proposedState: 'Backlog', approvedState: 'Todo', rejectedState: 'Canceled' } };
const idea = (name = 'Todo', extra = {}) => ({ id: 'id', identifier: 'TEAM-1', projectId: 'project', teamId: 'team', parentId: null, state: { name, type: name === 'Canceled' ? 'canceled' : 'unstarted' }, labels: [{ id: 'idea', name: 'Idea' }], blocked: false, ...extra });
function harness({ ideas = [], jobs = [], remaining = 10, prepareError = false } = {}) {
  const writes = []; const prepared = []; let reads = 0;
  const linear = { snapshot: async () => { reads++; return { ideas, remaining }; }, prepareApproved: async (_manifest, identifier) => { if (prepareError) throw new Error('Approval withdrawn'); prepared.push(identifier); } };
  const queue = async (route, body) => {
    if (body === undefined) return structuredClone(jobs);
    writes.push({ route, body });
    if (route.endsWith('/cancel')) { jobs.find(job => route === `/jobs/${job.id}/cancel`).state = 'canceled'; return {}; }
    const job = { ...body, id: `job-${jobs.length}`, state: 'queued', createdAt: 100_000_000 }; jobs.push(job); return job;
  };
  return { poll: (overrides = {}) => pollProject({ manifest, linear, queue, now: 100_000_000, ...overrides }), writes, prepared, jobs, reads: () => reads };
}
test('approved development enqueues once even across completed/failed history', async () => {
  const h = harness({ ideas: [idea()] });
  await h.poll(); await h.poll();
  assert.deepEqual(h.writes[0].body, { projectId: 'example', issue: 'TEAM-1', timeoutMinutes: 30, publish: true, autoMerge: true, kind: 'development', approvalRequired: true });
  assert.equal(h.writes.length, 1); assert.equal(h.prepared.length, 1);
  for (const state of ['completed', 'failed']) {
    h.jobs[0].state = state; await h.poll();
    assert.equal(h.writes.filter(write => write.body.kind === 'development').length, 1);
  }
});
test('canceled and no-model idle history frees an issue for renewed approval; delivered work stays claimed', async () => {
  for (const [job, expected] of [[{ state: 'canceled' }, 1], [{ state: 'completed', result: { outcome: 'idle', summary: 'Owner approval withdrawn' } }, 1],
    [{ state: 'completed', result: { outcome: 'ready', summary: 'merged' } }, 0], [{ state: 'blocked' }, 0], [{ state: 'running' }, 0]]) {
    const h = harness({ ideas: [idea()], jobs: [{ id: 'old', projectId: 'example', issue: 'TEAM-1', kind: 'development', approvalRequired: true, createdAt: 0, ...job }] });
    await h.poll();
    assert.equal(h.writes.filter(write => write.body?.kind === 'development').length, expected, JSON.stringify(job));
  }
});
test('automatic jobs fetch the configured delivery branch and ideation omits publishing fields', async () => {
  const h = harness({ ideas: [idea()], remaining: 2 });
  await h.poll({ manifest: { ...manifest, delivery: { autoMergeAuthorized: true, baseBranch: 'master' } } });
  assert.equal(h.writes[0].body.base, 'origin/master'); assert.equal(h.writes[0].body.fetch, true);
  const ideas = harness({ remaining: 2 });
  await ideas.poll({ manifest: { ...manifest, delivery: { baseBranch: 'master' } } });
  assert.deepEqual(ideas.writes[0].body, { projectId: 'example', kind: 'ideation', proposalLimit: 2, timeoutMinutes: 10, base: 'origin/master', fetch: true, idempotencyKey: 'ideation:example:1' });
  assert.ok(!('publish' in ideas.writes[0].body) && !('autoMerge' in ideas.writes[0].body));
});
test('Backlog, canceled, blocked, subissues and foreign teams never enqueue development', async () => {
  for (const issue of [idea('Backlog'), idea('Canceled'), idea('Todo', { blocked: true }), idea('Todo', { parentId: 'parent' }), idea('Todo', { teamId: 'wrong' }), idea('Todo', { labels: [] }), idea('Todo', { labels: [{ id: 'idea', name: 'Idea' }, { id: 'hold', name: 'agent:blocked' }] }), idea('Todo', { labels: [{ id: 'idea', name: 'Idea' }, { id: 'decide', name: 'owner:decision' }] })]) {
    const h = harness({ ideas: [issue], remaining: 0 }); await h.poll(); assert.equal(h.writes.length, 0); assert.equal(h.prepared.length, 0);
  }
});
test('queued withdrawn approvals cancel; running jobs do not', async () => {
  const jobs = ['queued', 'running'].map((state, index) => ({ id: `job-${index}`, projectId: 'example', issue: 'TEAM-1', approvalRequired: true, state }));
  const h = harness({ ideas: [idea('Backlog')], jobs }); await h.poll();
  assert.deepEqual(h.writes, [{ route: '/jobs/job-0/cancel', body: {} }]);
});
test('fresh preparation rejects withdrawal before enqueue', async () => {
  const h = harness({ ideas: [idea()], prepareError: true });
  await assert.rejects(h.poll(), /withdrawn/); assert.equal(h.writes.length, 0);
});
test('ideation capacity and cooldown are enforced without a model invocation', async () => {
  const h = harness({ remaining: 2 }); await h.poll(); await h.poll();
  assert.equal(h.writes.length, 1);
  assert.deepEqual(h.writes[0].body, { projectId: 'example', kind: 'ideation', proposalLimit: 2, timeoutMinutes: 10, idempotencyKey: 'ideation:example:1' });
  h.jobs[0].state = 'completed'; await h.poll(); assert.equal(h.writes.length, 1);
  await h.poll({ now: 200_000_000 }); assert.equal(h.writes.length, 2);
  const full = harness({ remaining: 0 }); await full.poll(); assert.equal(full.writes.length, 0);
});
test('active and quarantined project jobs prevent generation, including old failed ideation', async () => {
  for (const state of ['queued', 'running', 'blocked', 'failed']) {
    const h = harness({ jobs: [{ id: 'job', projectId: 'example', kind: 'ideation', state, createdAt: 0 }] });
    await h.poll(); assert.equal(h.writes.length, 0);
  }
  const h = harness({ jobs: [{ projectId: 'example', kind: 'ideation', state: 'canceled', createdAt: 99_000_000 }] });
  await h.poll(); assert.equal(h.writes.length, 0);
});
test('disabled ideation and API failures never reach queue', async () => {
  const h = harness();
  await assert.rejects(h.poll({ manifest: { ...manifest, ideation: { ...manifest.ideation, enabled: false } } }));
  assert.equal(h.reads(), 0);
  for (let i = 0; i < 2; i++) await assert.rejects(h.poll({ linear: { snapshot: async () => { throw new Error('Authentication failed'); } }, queue: () => assert.fail('queue must not be called') }));
});
test('intake emits fixed bounded errors rather than underlying text', async () => {
  const errors = [];
  await assert.rejects(runIntake({ projects: { example: '/nonexistent/secret-test-key' } }, { once: true, linear: {}, queue: () => assert.fail(), onError: error => errors.push(error.message) }), /Intake project poll failed/);
  assert.deepEqual(errors, ['Intake project poll failed']);
});

test('without local checkouts the intake polls manifests from the coordinator registry', async () => {
  const seen = [];
  const queue = async (route, body) => {
    if (route === '/projects') return [{ id: 'example', manifest }, { id: 'bare', manifest: null }];
    if (route === '/jobs' && body === undefined) return [];
    seen.push({ route, body }); return { id: 'job', state: 'queued' };
  };
  const linear = { snapshot: async () => ({ ideas: [], remaining: 0 }), prepareApproved: async () => {} };
  await runIntake({ coordinatorUrl: 'http://127.0.0.1:4310' }, { once: true, queue, linear });
  assert.deepEqual(seen, []);
  await assert.rejects(runIntake({ projects: { example: 'relative' } }, { once: true, queue, linear }), /absolute/);
});
