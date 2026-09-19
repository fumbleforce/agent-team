import test from 'node:test';
import assert from 'node:assert/strict';
import { FEEDBACK_WINDOW_MS, needsRevision, quorum } from '@agent-team/protocol';
import { createStorage } from '@agent-team/storage';
import { createContext } from '../context.ts';
import { seedDemo } from '../demo/seed.ts';
import { createDeliberation } from './deliberation.ts';
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
  return { storage, db, deliberation: createDeliberation(context, turns), threadId: thread.id, taskId: task.id, agents, turn, queued, tick: (ms: number) => { clock += ms; } };
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
  assert.equal((await db.selectFrom('decisions').select('needs_human').executeTakeFirstOrThrow()).needs_human, false);
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

test('escalation lands with the owner instead of releasing the task', async () => {
  const { storage, db, deliberation, threadId, taskId, turn } = await boot();
  const opened = await deliberation.propose(turn('Bram'), threadId, proposal);
  for (const name of ['Ada', 'Cleo', 'Finn']) await deliberation.feedback(turn(name), opened.deliberationId, block('for'));
  await deliberation.conclude(turn('Maren'), opened.deliberationId, { outcome: 'escalate', decision: 'This changes the milestone; the owner decides.', dissent: [] });
  assert.equal((await db.selectFrom('decisions').select('needs_human').executeTakeFirstOrThrow()).needs_human, true);
  assert.equal((await db.selectFrom('tasks').select('state').where('id', '=', taskId).executeTakeFirstOrThrow()).state, 'awaiting_decision');
  await storage.close();
});
