import test from 'node:test';
import assert from 'node:assert/strict';
import { FEEDBACK_WINDOW_MS, needsRevision, quorum } from '@agent-team/protocol';
import { createStorage } from '@agent-team/storage';
import { createContext } from '../context.ts';
import { seedDemo } from '../demo/seed.ts';
import { createDeliberation } from './deliberation.ts';
import { createNeedsYou } from './needsYou.ts';
import { buildPacket } from './packet.ts';
import { createTurns } from './turns.ts';

async function boot() {
  const storage = await createStorage({ kind: 'sqlite', path: ':memory:' });
  await storage.migrate();
  let clock = 1_000_000;
  const context = createContext({ storage, machineToken: 'x'.repeat(24), now: () => clock });
  await seedDemo(context);
  const db = storage.db;
  const project = await db.selectFrom('projects').select('id').where('slug', '=', 'checkout-v2').executeTakeFirstOrThrow();
  const thread = await db.selectFrom('threads').select('id').where('project_id', '=', project.id).executeTakeFirstOrThrow();
  const task = await db.selectFrom('tasks').select('id').where('key', '=', 'CK-31').executeTakeFirstOrThrow();
  const agents = Object.fromEntries((await db.selectFrom('agents').select(['id', 'name']).execute()).map(agent => [agent.name, agent.id])) as Record<string, string>;
  const turns = createTurns(context);
  const turn = (name: string) => ({ agent_id: agents[name]!, project_id: project.id, task_id: task.id });
  const queued = async () => (await db.selectFrom('work_items').innerJoin('agents', 'agents.id', 'work_items.agent_id').select(['agents.name', 'work_items.kind']).where('work_items.state', '=', 'queued').execute()).map(item => `${item.name}:${item.kind}`).sort();
  return { storage, db, context, turns, deliberation: createDeliberation(context, turns), threadId: thread.id, taskId: task.id, agents, turn, queued, tick: (ms: number) => { clock += ms; } };
}
const proposal = { question: 'Disable the pay button on tap?', summary: 'Optimistic disable with a timeout.', options: [], reviewers: [] as string[], urgency: 'blocking' as const };
const block = (stance: 'for' | 'against', extra: Partial<{ conditions: string[]; blocking: boolean }> = {}) => ({ stance, points: ['A point.'], risks: [], conditions: [], confidence: 'med' as const, blocking: false, ...extra });

test('pure rules: when a revision is warranted and what quorum is', () => {
  assert.equal(needsRevision([{ stance: 'for', blocking: false, conditions: 0 }]), false);
  assert.equal(needsRevision([{ stance: 'for', blocking: false, conditions: 1 }]), true);
  assert.equal(needsRevision([{ stance: 'against', blocking: false, conditions: 0 }, { stance: 'for', blocking: false, conditions: 0 }]), true);
  assert.deepEqual([quorum(1), quorum(3), quorum(4)], [1, 2, 2]);
});

test('proposal, parallel feedback, one revision, decision with dissent addressed', async () => {
  const { storage, db, deliberation, threadId, taskId, agents, turn, queued } = await boot();
  const opened = await deliberation.propose(turn('Bram'), threadId, { ...proposal, reviewers: ['Cleo'] });
  // Never the proposer, never the PM who decides; named reviewers first; capped at three.
  assert.deepEqual(opened.reviewers, [agents.Cleo, agents.Ada, agents.Finn]);
  assert.equal(opened.endTurn, true);
  assert.equal((await db.selectFrom('tasks').select('state').where('id', '=', taskId).executeTakeFirstOrThrow()).state, 'awaiting_decision');
  assert.deepEqual(await queued(), ['Ada:feedback', 'Cleo:feedback', 'Finn:feedback']);
  await assert.rejects(deliberation.propose(turn('Bram'), threadId, proposal), /already has an open/);

  await deliberation.feedback(turn('Cleo'), opened.deliberationId, block('against', { conditions: ['Re-enable after 8 s with a message.'] }));
  await assert.rejects(deliberation.feedback(turn('Cleo'), opened.deliberationId, block('for')), /one block/);
  await assert.rejects(deliberation.feedback(turn('Maren'), opened.deliberationId, block('for')), /not a reviewer/);
  await deliberation.feedback(turn('Ada'), opened.deliberationId, block('for'));
  assert.ok(!(await queued()).includes('Bram:revise'));
  await deliberation.feedback(turn('Finn'), opened.deliberationId, block('for'));
  assert.ok((await queued()).includes('Bram:revise'));

  await deliberation.revise(turn('Bram'), opened.deliberationId, { summary: 'Key on mount, 8 s re-enable.', changes: 'Added the timeout and message.' });
  await assert.rejects(deliberation.revise(turn('Bram'), opened.deliberationId, { summary: 'x', changes: 'y' }), /at most once/);
  assert.ok((await queued()).includes('Maren:conclude'));

  await assert.rejects(deliberation.conclude(turn('Maren'), opened.deliberationId, { outcome: 'accept', decision: 'Ship it.', dissent: [] }), /Address the dissent/);
  await assert.rejects(deliberation.conclude(turn('Bram'), opened.deliberationId, { outcome: 'accept', decision: 'Ship it.', dissent: [] }), /Only the decider/);
  await deliberation.conclude(turn('Maren'), opened.deliberationId, { outcome: 'accept_with_changes', decision: 'Ship it as revised.', dissent: [{ agentId: agents.Cleo!, note: 'Timeout covers the hang.' }] });

  const kinds = (await db.selectFrom('messages').select('kind').where('thread_id', '=', threadId).orderBy('seq', 'desc').limit(6).execute()).map(row => row.kind).reverse();
  assert.deepEqual(kinds, ['proposal', 'feedback', 'feedback', 'feedback', 'revision', 'decision']);
  assert.equal((await db.selectFrom('tasks').select('state').where('id', '=', taskId).executeTakeFirstOrThrow()).state, 'in_progress');
  assert.ok((await queued()).includes('Bram:work'), 'the owner carries on at once, with the decision in the thread');
  assert.equal((await db.selectFrom('decisions').select('needs_human').where('deliberation_id', '=', opened.deliberationId).executeTakeFirstOrThrow()).needs_human, false);
  await storage.close();
});

test('agreement skips the revision; a silent reviewer becomes an abstention after one extension', async () => {
  const { storage, db, deliberation, threadId, turn, queued, tick } = await boot();
  const opened = await deliberation.propose(turn('Bram'), threadId, proposal);
  await deliberation.feedback(turn('Ada'), opened.deliberationId, block('for'));
  await deliberation.feedback(turn('Cleo'), opened.deliberationId, block('for'));
  tick(FEEDBACK_WINDOW_MS.blocking + 1);
  await deliberation.sweep();
  assert.ok((await queued()).includes('Maren:conclude') && !(await queued()).includes('Bram:revise'));
  assert.equal((await db.selectFrom('deliberation_participants').select('state').where('state', '=', 'abstained').execute()).length, 1);

  const second = await boot();
  const lonely = await second.deliberation.propose(second.turn('Bram'), second.threadId, proposal);
  second.tick(FEEDBACK_WINDOW_MS.blocking + 1);
  await second.deliberation.sweep();
  assert.equal((await second.db.selectFrom('deliberations').select(['state', 'extended']).where('id', '=', lonely.deliberationId).executeTakeFirstOrThrow()).extended, true);
  second.tick(FEEDBACK_WINDOW_MS.blocking);
  await second.deliberation.sweep();
  assert.equal((await second.db.selectFrom('deliberations').select('state').where('id', '=', lonely.deliberationId).executeTakeFirstOrThrow()).state, 'deciding');
  await storage.close(); await second.storage.close();
});

test('escalation lands with the owner instead of releasing the task, and the owner\'s answer starts that task alone', async () => {
  const { storage, db, deliberation, threadId, taskId, turn, queued, context, turns } = await boot();
  const opened = await deliberation.propose(turn('Bram'), threadId, proposal);
  for (const name of ['Ada', 'Cleo', 'Finn']) await deliberation.feedback(turn(name), opened.deliberationId, block('for'));
  await deliberation.conclude(turn('Maren'), opened.deliberationId, { outcome: 'escalate', decision: 'This changes the milestone; the owner decides.', dissent: [] });
  assert.equal((await db.selectFrom('decisions').select('needs_human').where('deliberation_id', '=', opened.deliberationId).executeTakeFirstOrThrow()).needs_human, true);
  assert.equal((await db.selectFrom('tasks').select('state').where('id', '=', taskId).executeTakeFirstOrThrow()).state, 'awaiting_decision');
  assert.ok(!(await queued()).includes('Bram:work'));

  // Another task waiting on a decision of its own is not moved by this answer.
  await db.updateTable('tasks').set({ state: 'awaiting_decision' }).where('key', '=', 'CK-27').execute();
  const decision = await db.selectFrom('decisions').select('id').where('deliberation_id', '=', opened.deliberationId).executeTakeFirstOrThrow();
  const owner = await db.selectFrom('users').select('id').executeTakeFirstOrThrow();
  await createNeedsYou(context, turns).resolveDecision(owner.id, decision.id, 'Keep the milestone; do it after the release.');
  assert.equal((await db.selectFrom('tasks').select('state').where('id', '=', taskId).executeTakeFirstOrThrow()).state, 'in_progress');
  assert.equal((await db.selectFrom('tasks').select('state').where('key', '=', 'CK-27').executeTakeFirstOrThrow()).state, 'awaiting_decision');
  assert.ok((await queued()).includes('Bram:work'), 'the task\'s owner reads the answer in its next turn, which starts at once');
  await storage.close();
});

test('advice: the owner asks two colleagues at most, nobody else spends a turn, and the feedback reaches the owner\'s next work turn for it to decide', async () => {
  const { storage, db, deliberation, threadId, taskId, agents, turn, queued } = await boot();
  try {
    await db.updateTable('tasks').set({ state: 'in_progress', assignee_agent_id: agents.Bram!, blocked_reason: null }).where('id', '=', taskId).execute();
    const asked = await deliberation.propose(turn('Bram'), threadId, { ...proposal, decides: 'me', reviewers: ['Cleo', 'Maren'] });
    // Two advisers, and the PM may be one of them: nobody is held back as the decider, because the asker decides.
    assert.deepEqual([...asked.reviewers].sort(), [agents.Cleo, agents.Maren].sort());
    const row = await db.selectFrom('deliberations').select(['kind', 'decider_agent_id', 'feedback_deadline', 'created_at']).where('id', '=', asked.deliberationId).executeTakeFirstOrThrow();
    assert.deepEqual([row.kind, row.decider_agent_id, Number(row.feedback_deadline) - Number(row.created_at)], ['advice', agents.Bram, 5 * 60_000]);
    assert.deepEqual(await queued(), ['Cleo:feedback', 'Maren:feedback']);

    await deliberation.feedback(turn('Cleo'), asked.deliberationId, block('against', { conditions: ['Re-enable after 8 s with a message.'] }));
    await deliberation.feedback(turn('Maren'), asked.deliberationId, block('for'));
    // Against, with a condition: a team decision would go to revision and then to the PM. Advice is simply done.
    assert.equal((await db.selectFrom('deliberations').select('state').where('id', '=', asked.deliberationId).executeTakeFirstOrThrow()).state, 'decided');
    assert.equal((await db.selectFrom('tasks').select('state').where('id', '=', taskId).executeTakeFirstOrThrow()).state, 'in_progress');
    const after = (await queued()).filter(item => !item.endsWith(':feedback'));
    assert.deepEqual(after, ['Bram:work'], 'no revise turn, no conclude turn: only the owner carries on');
    assert.equal((await db.selectFrom('decisions').select('id').where('deliberation_id', '=', asked.deliberationId).execute()).length, 0, 'nothing was decided for the owner');

    const packet = await storage.transaction(tx => buildPacket(tx, { kind: 'work', agentId: agents.Bram!, projectId: (turn('Bram')).project_id, taskId, threadId: null }));
    assert.match(packet.prompt, /# The advice you asked for: Disable the pay button on tap\?\nYou asked, so you decide\./);
    assert.match(packet.prompt, /## Cleo \([^)]+\), against\n[\s\S]*Re-enable after 8 s with a message\./);
    assert.match(packet.prompt, /## Maren \([^)]+\), for/);
    // A reviewer of the task does not get the owner's advice or journal.
    const reviewer = await storage.transaction(tx => buildPacket(tx, { kind: 'review', agentId: agents.Cleo!, projectId: (turn('Bram')).project_id, taskId, threadId: null }));
    assert.doesNotMatch(reviewer.prompt, /The advice you asked for/);
  } finally { await storage.close(); }
});

test('advice is asked on a task of one\'s own, and an adviser who stays silent is said to have been', async () => {
  const { storage, db, deliberation, threadId, taskId, agents, turn, tick } = await boot();
  try {
    await assert.rejects(deliberation.propose({ ...turn('Bram'), task_id: null }, threadId, { ...proposal, decides: 'me' }), /task of your own/);
    await db.updateTable('tasks').set({ state: 'in_progress', assignee_agent_id: agents.Bram! }).where('id', '=', taskId).execute();
    const asked = await deliberation.propose(turn('Bram'), threadId, { ...proposal, decides: 'me', reviewers: ['Cleo'] });
    await deliberation.feedback(turn(Object.keys(agents).find(name => agents[name] === asked.reviewers[0])!), asked.deliberationId, block('for'));
    tick(5 * 60_000 + 1);
    await deliberation.sweep();
    tick(5 * 60_000);
    await deliberation.sweep();
    assert.equal((await db.selectFrom('deliberations').select('state').where('id', '=', asked.deliberationId).executeTakeFirstOrThrow()).state, 'decided');
    const packet = await storage.transaction(tx => buildPacket(tx, { kind: 'work', agentId: agents.Bram!, projectId: turn('Bram').project_id, taskId, threadId: null }));
    assert.match(packet.prompt, /did not answer in time/);
  } finally { await storage.close(); }
});

test('an answered decision about no task in hand goes to the PM\'s triage, in the thread it was asked in', async () => {
  const { storage, db, threadId, queued, context, turns } = await boot();
  const project = await db.selectFrom('threads').select('project_id').where('id', '=', threadId).executeTakeFirstOrThrow();
  await db.insertInto('decisions').values({ id: 'd-1', project_id: project.project_id!, thread_id: threadId, message_id: 'm-1', deliberation_id: null, kind: 'triage', outcome: 'escalate', summary: 'Which of the two reports first?', needs_human: true, resolved_by_user: null, resolved_at: null, created_at: 1 }).execute();
  const owner = await db.selectFrom('users').select('id').executeTakeFirstOrThrow();
  await createNeedsYou(context, turns).resolveDecision(owner.id, 'd-1', 'The Safari one.');
  assert.ok((await queued()).includes('Maren:triage'));
  await storage.close();
});
