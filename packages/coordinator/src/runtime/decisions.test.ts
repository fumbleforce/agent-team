import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStorage } from '@agent-team/storage';
import { newId } from '@agent-team/protocol';
import type { Answer, Decider } from '../../../../adapters/decider/contract.ts';
import { fakeDecider } from '../../../../adapters/decider/fake.ts';
import { createContext } from '../context.ts';
import { seedDemo } from '../demo/seed.ts';
import { createIssues } from '../repos/issues.ts';
import { createDecisions, readLines } from './decisions.ts';
import { buildPacket } from './packet.ts';
import { createScorecard } from './scorecard.ts';
import { createTurns } from './turns.ts';

const score = (probabilities: Record<string, number>, confidence: number, legend: string[]): Answer => ({ type: 'score', score: Object.entries(probabilities).reduce((sum, [level, p]) => sum + Number(level) * p, 0), confidence, legend: Object.fromEntries(legend.map((text, index) => [String(index), text])), probabilities });
const choice = (option: string, confidence: number, others: string[] = []): Answer => ({ type: 'choice', choice: option, confidence, probabilities: { [option]: confidence, ...Object.fromEntries(others.map(other => [other, (1 - confidence) / Math.max(1, others.length)])) } });

// A model that reads every report as an urgent, blocking defect for Ada, and every task as hard.
function sureModel() {
  return fakeDecider((_state, questions) => ({
    kind: choice('defect', 0.9, ['change', 'request']),
    ...(questions.severity?.type === 'score' ? { severity: score({ 0: 0, 1: 0.2, 2: 0.8 }, 0.7, questions.severity.criteria) } : {}),
    urgent: { type: 'noul', noul: 0.9 },
    ...(questions.seat?.type === 'choice' ? { seat: choice(Object.entries(questions.seat.criteria).find(([, about]) => about.startsWith('Ada,'))![0], 0.9) } : {}),
    ...(questions.duplicateOf ? { duplicateOf: choice('none', 0.95) } : {}),
    ...(questions.difficulty?.type === 'score' ? { difficulty: score({ 0: 0.05, 1: 0.1, 2: 0.85 }, 0.8, questions.difficulty.criteria) } : {}),
  }));
}

async function boot(decider: Decider | null) {
  const storage = await createStorage({ kind: 'sqlite', path: ':memory:' });
  await storage.migrate();
  let clock = Date.UTC(2026, 8, 1, 9);
  const context = createContext({ storage, machineToken: 'x'.repeat(24), now: () => clock, decider });
  await seedDemo(context);
  const db = storage.db;
  const project = await db.selectFrom('projects').select('id').where('slug', '=', 'checkout-v2').executeTakeFirstOrThrow();
  const agents = Object.fromEntries((await db.selectFrom('agents').select(['id', 'name']).execute()).map(row => [row.name, row.id])) as Record<string, string>;
  const issues = createIssues(context, mkdtempSync(path.join(os.tmpdir(), 'decisions-')));
  const raise = (title: string, body: string) => issues.create(null, project.id, { title, body, source: 'discussion', markers: [] });
  return { storage, db, context, turns: createTurns(context), decisions: createDecisions(context), projectId: project.id, agents, raise, tick: (ms: number) => { clock += ms; }, now: () => clock };
}

test('a triage turn carries the model’s first read: what it is, who fits, sorted ahead when urgent, with its cost and event recorded together', async () => {
  const model = sureModel();
  const { storage, db, turns, projectId, agents, raise } = await boot(model);
  try {
    const issue = await raise('Checkout fails on Safari', 'Pressing pay on Safari 18 shows a spinner forever. Chrome works.');
    const itemId = await turns.enqueue({ agentId: agents.Maren!, projectId, kind: 'triage', threadId: issue.threadId, dedupeKey: `triage:${issue.threadId}` });
    assert.ok(itemId);
    assert.equal((await db.selectFrom('work_items').select('priority_class').where('id', '=', itemId!).executeTakeFirstOrThrow()).priority_class, 2, 'urgent by the read: ahead of ordinary triage');

    // What the model was asked: the report and its thread, each seat with what its roles look for, the open board.
    assert.equal(model.calls.length, 1);
    const asked = model.calls[0]!;
    assert.deepEqual(Object.keys(asked.questions), ['kind', 'severity', 'urgent', 'seat', 'duplicateOf']);
    assert.match(JSON.stringify(asked.state), /spinner forever/);
    assert.ok(asked.questions.seat?.type === 'choice' && agents.Ada! in asked.questions.seat.criteria);

    const read = await db.selectFrom('machine_decisions').selectAll().where('thread_id', '=', issue.threadId).executeTakeFirstOrThrow();
    assert.deepEqual([read.purpose, read.model, Boolean(read.applied), read.judged_at], ['triage', 'fake', true, null]);
    assert.equal(read.confidence, 0.7, 'the least sure of its answers');
    assert.ok(read.input_tokens > 0 && read.usd_micro > 0);
    const cost = await db.selectFrom('cost_entries').selectAll().where('project_id', '=', projectId).where('turn_id', 'is', null).executeTakeFirstOrThrow();
    assert.deepEqual([cost.tokens_in, cost.provider_id, cost.billing_kind], [read.input_tokens, null, 'metered']);
    const event = await db.selectFrom('events').select('payload').where('type', '=', 'decision.machine').executeTakeFirstOrThrow();
    assert.deepEqual((JSON.parse(event.payload) as { answers: Record<string, unknown> }).answers, { kind: 'defect', severity: 'Blocking: no workaround', urgent: true, seat: agents.Ada, duplicateOf: 'none' });

    // The PM's packet shows the read, by name, as a first look and not a verdict.
    const packet = await storage.transaction(tx => buildPacket(tx, { kind: 'triage', agentId: agents.Maren!, projectId, taskId: null, threadId: issue.threadId }));
    assert.match(packet.prompt, /# First read \(a decision model, not a colleague\)\n- kind: defect \(0\.90\)\n- severity: blocking \(0\.70\)\n- urgent: yes \(0\.80\)\n- seat: Ada \(ownerAgentId [^)]+\) \(0\.90\)\n- duplicateOf: none \(0\.95\)\nYou decide; this is only a first read\./);

    // The same wake again is absorbed before the model is asked.
    assert.equal(await turns.enqueue({ agentId: agents.Maren!, projectId, kind: 'triage', threadId: issue.threadId, dedupeKey: `triage:${issue.threadId}` }), null);
    assert.equal(model.calls.length, 1);
  } finally { await storage.close(); }
});

test('a task is sized once before its first work turn, and a routing rule can send hard work elsewhere', async () => {
  const model = sureModel();
  const { storage, db, turns, projectId, agents } = await boot(model);
  try {
    const task = await db.selectFrom('tasks').select(['id', 'difficulty']).where('key', '=', 'CK-31').executeTakeFirstOrThrow();
    assert.equal(task.difficulty, null);
    await turns.enqueue({ agentId: agents.Bram!, projectId, kind: 'work', taskId: task.id });
    assert.equal((await db.selectFrom('tasks').select('difficulty').where('id', '=', task.id).executeTakeFirstOrThrow()).difficulty, 'hard');
    assert.equal(model.calls.length, 1);
    assert.deepEqual(Object.keys(model.calls[0]!.questions), ['difficulty']);
    await turns.enqueue({ agentId: agents.Ada!, projectId, kind: 'work', taskId: task.id });
    assert.equal(model.calls.length, 1, 'sized once');
    // The read is kept with the task, and the sizing turns up in the scorecard's count of reads.
    const read = await db.selectFrom('machine_decisions').select(['purpose', 'applied']).where('task_id', '=', task.id).executeTakeFirstOrThrow();
    assert.deepEqual({ ...read, applied: Boolean(read.applied) }, { purpose: 'difficulty', applied: true });
  } finally { await storage.close(); }
});

test('an unsure read changes nothing and is shown as unsure; no model or a failing one leaves the platform as it was', async () => {
  const unsure = fakeDecider({ difficulty: score({ 0: 0.4, 1: 0.35, 2: 0.25 }, 0.2, ['a', 'b', 'c']), kind: choice('question', 0.4, ['defect', 'request']) });
  const { storage, db, turns, projectId, agents, raise } = await boot(unsure);
  try {
    const task = await db.selectFrom('tasks').select('id').where('key', '=', 'CK-31').executeTakeFirstOrThrow();
    await turns.enqueue({ agentId: agents.Bram!, projectId, kind: 'work', taskId: task.id });
    assert.equal((await db.selectFrom('tasks').select('difficulty').where('id', '=', task.id).executeTakeFirstOrThrow()).difficulty, null);
    assert.equal(Boolean((await db.selectFrom('machine_decisions').select('applied').where('task_id', '=', task.id).executeTakeFirstOrThrow()).applied), false);
    await turns.enqueue({ agentId: agents.Ada!, projectId, kind: 'work', taskId: task.id });
    assert.equal(unsure.calls.length, 1, 'not asked again about a task it could not size');
    const issue = await raise('Hm', 'Is the pay button meant to be green?');
    const itemId = await turns.enqueue({ agentId: agents.Maren!, projectId, kind: 'triage', threadId: issue.threadId });
    assert.equal((await db.selectFrom('work_items').select('priority_class').where('id', '=', itemId!).executeTakeFirstOrThrow()).priority_class, 3, 'nothing urgent read: ordinary triage');
    assert.deepEqual(readLines({ answers: { kind: choice('question', 0.4) } }), ['- kind: unsure (question 0.40)']);
  } finally { await storage.close(); }

  for (const decider of [null, { name: 'down', decide: async () => { throw new Error('offline'); } }, fakeDecider({})]) {
    const world = await boot(decider);
    try {
      const issue = await world.raise('Broken', 'Nothing loads.');
      const itemId = await world.turns.enqueue({ agentId: world.agents.Maren!, projectId: world.projectId, kind: 'triage', threadId: issue.threadId });
      assert.ok(itemId);
      assert.equal((await world.db.selectFrom('machine_decisions').selectAll().execute()).length, 0);
      assert.equal((await world.db.selectFrom('cost_entries').selectAll().where('turn_id', 'is', null).execute()).length, 0);
      const packet = await world.storage.transaction(tx => buildPacket(tx, { kind: 'triage', agentId: world.agents.Maren!, projectId: world.projectId, taskId: null, threadId: issue.threadId }));
      assert.doesNotMatch(packet.prompt, /First read/);
    } finally { await world.storage.close(); }
  }
});

test('a read is judged by what the PM decided: a sure kind or seat the PM chose against is an overturn, and the scorecard counts them', async () => {
  const { storage, db, context, turns, decisions, projectId, agents, raise, tick, now } = await boot(sureModel());
  try {
    const agreed = await raise('Pay fails', 'Paying fails on Safari.'), disagreed = await raise('Pay fails again', 'Paying fails on Firefox.'), ignored = await raise('Pay fails once more', 'Paying fails on Edge.');
    for (const issue of [agreed, disagreed, ignored]) await turns.enqueue({ agentId: agents.Maren!, projectId, kind: 'triage', threadId: issue.threadId });
    assert.equal(await decisions.sweep(), 0, 'nothing decided yet');
    tick(60_000);
    const decide = async (threadId: string, outcome: string, ownerAgentId: string | null) => {
      const messageId = newId(now());
      await db.insertInto('messages').values({ id: messageId, thread_id: threadId, author_kind: 'agent', author_id: agents.Maren!, kind: 'decision', body: 'Decided', payload: JSON.stringify({ triage: true, outcome, ownerAgentId }), created_at: now() }).execute();
      await db.insertInto('decisions').values({ id: newId(now()), project_id: projectId, thread_id: threadId, message_id: messageId, deliberation_id: null, kind: 'triage', outcome, summary: 'Decided', needs_human: false, resolved_by_user: null, resolved_at: null, created_at: now() }).execute();
    };
    await decide(agreed.threadId, 'accept', agents.Ada!);
    await decide(disagreed.threadId, 'accept', agents.Bram!);
    assert.equal(await decisions.sweep(), 2);
    const rows = Object.fromEntries((await db.selectFrom('machine_decisions').select(['thread_id', 'judged_at', 'overturned_at', 'overturned_by']).execute()).map(row => [row.thread_id, row]));
    assert.ok(rows[agreed.threadId]!.judged_at !== null && rows[agreed.threadId]!.overturned_at === null);
    assert.deepEqual([rows[disagreed.threadId]!.overturned_at, rows[disagreed.threadId]!.overturned_by], [now(), agents.Maren]);
    assert.equal(rows[ignored.threadId]!.judged_at, null, 'not decided yet: still open');
    assert.equal(await decisions.sweep(), 0, 'judged once');

    const card = await createScorecard(context).compute(projectId, { from: now() - 3600_000, to: now() + 1 });
    const byId = Object.fromEntries(card.figures.map(item => [item.id, item]));
    assert.deepEqual([byId.C1!.value, byId.C1!.sample, byId.C1!.met], [0.5, 2, false]);
    assert.ok(byId.C2!.value! > 0 && byId.C2!.sample === 3);
    assert.equal(byId.C3!.value, 0);

    // Two weeks on, what nobody decided is judged as neither right nor wrong.
    tick(15 * 24 * 3600_000);
    assert.equal(await decisions.sweep(), 1);
    assert.ok((await db.selectFrom('machine_decisions').select('overturned_at').where('thread_id', '=', ignored.threadId).executeTakeFirstOrThrow()).overturned_at === null);
  } finally { await storage.close(); }
});
