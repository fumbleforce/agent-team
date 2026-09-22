import test from 'node:test';
import assert from 'node:assert/strict';
import { turnToken } from '../auth/secrets.ts';
import { seedDemo } from '../demo/seed.ts';
import { startCoordinator } from '../server.ts';
import { checkInvariants } from './invariants.ts';
import { createTurns, type Claimed } from './turns.ts';

const TOKEN = 'machine-token-for-tests-0123456789';

async function boot() {
  const coordinator = await startCoordinator({ port: 0, storage: { kind: 'sqlite', path: ':memory:' }, machineToken: TOKEN, webRoot: null });
  await seedDemo(coordinator.context, { activity: true });
  const db = coordinator.context.storage.db, now = coordinator.context.now();
  const project = await db.selectFrom('projects').select('id').where('slug', '=', 'checkout-v2').executeTakeFirstOrThrow();
  const agents = Object.fromEntries((await db.selectFrom('agents').select(['id', 'name']).execute()).map(row => [row.name, row.id])) as Record<string, string>;
  await db.updateTable('work_items').set({ state: 'done' }).execute();
  await db.updateTable('turns').set({ state: 'completed', finished_at: now }).where('state', '=', 'running').execute();
  const taskId = 'doc-task';
  await db.insertInto('tasks').values({ id: taskId, project_id: project.id, key: 'DOC-1', source: 'internal', title: 'Campaign brief for the spring launch', brief: 'One page: goal, audience, message, plan, budget, when to stop.', tag: null, priority: 1, milestone_id: null, state: 'in_progress', assignee_agent_id: agents.Bram!, author_agent_id: null, branch: null, head_sha: null, pr_url: null, blocked_reason: null, result_kind: 'document', created_at: now, updated_at: now } as never).execute();
  const turns = createTurns(coordinator.context);
  let id = 0;
  const as = (claimed: Claimed) => async (name: string, args: unknown) => {
    const response = await fetch(`${coordinator.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${turnToken(TOKEN, claimed.turnId, claimed.leaseToken)}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }) });
    const result = (await response.json() as any).result;
    return { error: result.isError === true, text: result.content[0].text as string, data: result.isError ? null : JSON.parse(result.content[0].text) };
  };
  const claim = async () => (await turns.claim({ workerId: 'w1', free: { work: 1, bounded: 2, deliver: 0 }, projects: [project.id] }))!;
  const finish = (claimed: Claimed, summary: string) => turns.finish(claimed.turnId, 'w1', claimed.leaseToken, { state: 'completed', summary });
  return { coordinator, db, turns, agents, projectId: project.id, taskId, as, claim, finish };
}

test('a task whose result is a document is written, reviewed at its revision, sent back, revised and accepted, with no branch, commit or merge', async () => {
  const { coordinator, db, turns, agents, projectId, taskId, as, claim, finish } = await boot();
  try {
    await turns.enqueue({ agentId: agents.Bram!, projectId, kind: 'work', taskId });
    const writing = await claim();
    assert.match(writing.packet.prompt, /The result of this task is a document, not a change to the repository/);
    const author = as(writing);
    assert.match((await author('task.update', { state: 'ready_for_review', summary: 'Done.' })).text, /pass its path as `document`/);
    assert.match((await author('task.update', { state: 'ready_for_review', summary: 'Done.', document: 'briefs/spring-launch.md' })).text, /no knowledge page at briefs\/spring-launch\.md/);
    const written = await author('knowledge.write', { path: 'briefs/spring-launch.md', title: 'Spring launch brief', body: 'Goal: more use of offline mode.' });
    assert.equal(written.error, false, written.text);
    const handedIn = await author('task.update', { state: 'ready_for_review', summary: 'The brief is written.', document: 'briefs/spring-launch.md' });
    assert.equal(handedIn.error, false, handedIn.text);
    assert.deepEqual(handedIn.data, { state: 'in_review' });
    await finish(writing, 'The brief is written.');
    const task = () => db.selectFrom('tasks').select(['state', 'result_ref', 'head_sha', 'branch']).where('id', '=', taskId).executeTakeFirstOrThrow();
    assert.deepEqual(JSON.parse((await task()).result_ref!).rev, 1);

    // Reviewers get the document itself, as handed in, and the instructions for a document, not for a checkout.
    const firstReview = await claim();
    assert.equal(firstReview.kind, 'review');
    assert.notEqual(firstReview.agentId, agents.Bram, 'never its author');
    assert.match(firstReview.packet.prompt, /^The work under review is the document below/);
    assert.match(firstReview.packet.prompt, /# The document under review: Spring launch brief \(briefs\/spring-launch\.md, revision 1\)\nGoal: more use of offline mode\./);
    assert.doesNotMatch(firstReview.packet.prompt, /throwaway checkout/);
    const sentBack = await as(firstReview)('document.review', { verdict: 'changes', summary: 'No number to move and no stop rule.', findings: [{ severity: 'must', note: 'The goal names no number.' }] });
    assert.deepEqual(sentBack.data, { recorded: true, state: 'in_progress' });
    assert.match((await as(firstReview)('document.review', { verdict: 'pass', summary: 'Again.' })).text, /once per turn|not in review|already gave/);
    await finish(firstReview, 'Sent back.');

    // The owner is started on it at once, with the finding in front of it, revises the same page and hands it in again.
    const others = await db.selectFrom('work_items').select('id').where('task_id', '=', taskId).where('kind', '=', 'review').where('state', '=', 'queued').execute();
    await db.updateTable('work_items').set({ state: 'done' }).where('id', 'in', others.map(item => item.id).concat('none')).execute();
    const revising = await claim();
    assert.deepEqual([revising.kind, revising.agentId], ['work', agents.Bram]);
    assert.match(revising.packet.prompt, /# Open findings\n- reviewer: changes at doc:[^\n]*No number to move and no stop rule\./);
    await as(revising)('knowledge.write', { path: 'briefs/spring-launch.md', title: 'Spring launch brief', body: 'Goal: 25 % weekly use of offline mode. We stop early if unsubscribes double.', expectedRev: 1 });
    await as(revising)('task.update', { state: 'ready_for_review', summary: 'Added the number and the stop rule.', document: 'briefs/spring-launch.md' });
    await finish(revising, 'Added the number and the stop rule.');
    assert.equal(JSON.parse((await task()).result_ref!).rev, 2);
    assert.equal((await db.selectFrom('approvals').select('state').where('task_id', '=', taskId).executeTakeFirstOrThrow()).state, 'stale', 'a verdict on revision 1 says nothing about revision 2');

    // Every reviewer asked passes revision 2: the task is done.
    let state = 'in_review';
    for (let round = 0; round < 3 && state === 'in_review'; round++) {
      const review = await claim();
      assert.match(review.packet.prompt, /revision 2\)\nGoal: 25 %/);
      state = (await as(review)('document.review', { verdict: 'pass', summary: 'Would send it as it is.' })).data.state;
      await finish(review, 'Passed.');
    }
    const ended = await task();
    assert.deepEqual([ended.state, ended.head_sha, ended.branch], ['done', null, null]);
    assert.equal((await db.selectFrom('merge_queue').select('id').where('task_id', '=', taskId).execute()).length, 0);
    assert.deepEqual(await checkInvariants(coordinator.context), []);
  } finally { await coordinator.close(); }
});

test('a task that ends in a change cannot hand in a document, and an author cannot review their own', async () => {
  const { coordinator, db, turns, agents, projectId, taskId, as, claim } = await boot();
  try {
    await db.updateTable('tasks').set({ result_kind: 'change' }).where('id', '=', taskId).execute();
    await turns.enqueue({ agentId: agents.Bram!, projectId, kind: 'work', taskId });
    const working = await claim();
    assert.match((await as(working)('task.update', { state: 'ready_for_review', summary: 'Done.', document: 'briefs/x' })).text, /ends in a change, not a document/);
  } finally { await coordinator.close(); }
});
