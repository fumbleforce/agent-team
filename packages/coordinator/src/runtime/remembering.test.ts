import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '@agent-team/storage';
import { createContext } from '../context.ts';
import { createKnowledge } from '../knowledge/knowledge.ts';
import { MemoryRefused, recordMemories } from '../knowledge/remember.ts';
import { createWorkspace } from '../repos/workspace.ts';
import { buildPacket } from './packet.ts';
import { createRemembering } from './remembering.ts';
import { moveTask } from './taskMoves.ts';
import { createTurns } from './turns.ts';

async function setup() {
  const storage = await createStorage({ kind: 'sqlite', path: ':memory:' });
  await storage.migrate();
  let clock = 1_800_000_000_000;
  const context = createContext({ storage, machineToken: 'x'.repeat(24), now: () => clock++ });
  const projectId = await createWorkspace(context).registerProject({ slug: 'shop', name: 'Shop', kind: 'repo', manifest: {} });
  const agents = Object.fromEntries((await storage.db.selectFrom('agents').select(['id', 'name']).execute()).map(agent => [agent.name, agent.id])) as Record<string, string>;
  await storage.db.insertInto('tasks').values({ id: 't1', project_id: projectId, key: 'T-1', source: 'internal', title: 'Refunds round to the cent', brief: 'Refunds come out a cent short on three-decimal amounts.', tag: null, priority: 0, milestone_id: null, state: 'in_review', assignee_agent_id: agents.Ada!, author_agent_id: null, branch: null, head_sha: null, pr_url: null, blocked_reason: null, created_at: 1, updated_at: 1 }).execute();
  const knowledge = createKnowledge(context), turns = createTurns(context);
  return { storage, context, projectId, agents, knowledge, turns, scope: { type: 'project' as const, id: projectId } };
}

test('what the team learns from is followed by one memory turn per task, on the seat that did the work', async () => {
  const { storage, context, projectId, agents, turns } = await setup();
  try {
    const remembering = createRemembering(context, turns);
    assert.equal(await remembering.sweep(), 0, 'the first sweep only marks where the log stands');
    const move = async (to: 'done' | 'in_progress') => context.events.published(await storage.transaction(async tx => context.events.append(tx, await moveTask(tx, 't1', to, { now: context.now(), actor: { actorKind: 'system' } }))));
    await move('in_progress');
    assert.equal(await remembering.sweep(), 0, 'an ordinary move teaches nothing');
    context.events.published(await storage.transaction(tx => context.events.append(tx, [{ type: 'review.recorded', actorKind: 'agent', agentId: agents.Rune!, projectId, taskId: 't1', payload: { kind: 'reviewer', verdict: 'changes' } }])));
    await move('done');
    assert.equal(await remembering.sweep(), 1, 'two triggers on one task make one memory turn');
    const items = await storage.db.selectFrom('work_items').select(['agent_id', 'kind', 'dedupe_key', 'lane']).where('kind', '=', 'remember').execute();
    assert.deepEqual(items.map(item => [item.agent_id, item.dedupe_key, item.lane]), [[agents.Ada, 'remember:t1', 'bounded']]);
  } finally { await storage.close(); }
});

test('a memory turn reads what happened with the memories near it, and keeps, replaces and retires them in one call', async () => {
  const { storage, context, projectId, agents, knowledge, scope } = await setup();
  try {
    const floats = await knowledge.fileMemory({ scope, agentId: agents.Ada!, type: 'gotcha', title: 'Refunds are floats', body: 'Refund amounts are floats of card payments.' });
    const wrong = await knowledge.fileMemory({ scope, agentId: agents.Ada!, type: 'observation', title: 'Refunds never round', body: 'Refund rounding never loses a cent.' });
    await storage.db.insertInto('approvals').values({ id: 'a1', task_id: 't1', kind: 'reviewer', agent_id: agents.Rune!, turn_id: 'r1', head_sha: 'c'.repeat(40), verdict: 'changes', findings: JSON.stringify([{ severity: 'high', path: 'src/refunds.ts', note: 'Math.round on a float loses the cent.' }]), summary: 'Rounds a float.', state: 'valid', created_at: context.now() }).execute();
    const packet = await storage.transaction(tx => buildPacket(tx, { kind: 'remember', agentId: agents.Ada!, projectId, taskId: 't1', threadId: null }));
    assert.match(packet.prompt, /Call memory.record once/);
    assert.match(packet.prompt, /# What review found\n- changes at cccccccccc: Rounds a float\.\n {2}- high src\/refunds\.ts: Math\.round on a float loses the cent\./);
    assert.ok(packet.prompt.includes(`- ${floats}: Refunds are floats.`) && packet.prompt.includes(wrong), 'the nearest memories are shown with their ids');

    const turn = { id: 'rem-1', agent_id: agents.Ada!, project_id: projectId, task_id: 't1' };
    await assert.rejects(recordMemories(context, knowledge, turn, scope, [{ action: 'keep', type: 'gotcha', title: 'x', abstract: 'x', body: 'x', replaces: ['nope'], fromOwner: false, why: 'x' }]), MemoryRefused);
    await assert.rejects(recordMemories(context, knowledge, turn, scope, [{ action: 'keep', type: 'gotcha', title: 'x', abstract: 'x', body: 'x', forRole: 'astronaut', replaces: [], fromOwner: false, why: 'x' }]), /Nobody on this team wears/);
    const done = await recordMemories(context, knowledge, turn, scope, [
      { action: 'keep', type: 'gotcha', title: 'Money is integer cents', abstract: 'Keep amounts as integer cents; never round refunds with floats.', body: 'Amounts are integers of cents. Math.round on a float refund loses a cent on three-decimal card amounts.', replaces: [floats], fromOwner: true, why: 'The review found floats lose a cent.' },
      { action: 'retire', replaces: [wrong], fromOwner: false, why: 'The review showed rounding does lose a cent.' },
    ]);
    assert.deepEqual([done.kept.length, done.retired], [1, 1]);
    const rows = Object.fromEntries((await storage.db.selectFrom('memories').select(['id', 'status', 'superseded_by', 'source', 'evidence']).execute()).map(row => [row.id, row]));
    assert.deepEqual([rows[floats]!.status, rows[floats]!.superseded_by, rows[wrong]!.status], ['superseded', done.kept[0], 'retired']);
    assert.equal(rows[done.kept[0]!]!.source, 'remember', 'nobody said it on the task, so it is not the owner\'s word');
    assert.deepEqual(JSON.parse(rows[done.kept[0]!]!.evidence), [{ kind: 'turn', id: 'rem-1' }, { kind: 'task', id: 't1' }]);
  } finally { await storage.close(); }
});

test('what the owner said on the task is kept as the owner\'s word', async () => {
  const { storage, context, projectId, agents, knowledge, scope } = await setup();
  try {
    await storage.db.insertInto('threads').values({ id: 'th1', project_id: projectId, kind: 'issue', subject_type: 'task', subject_id: 't1', title: 'T-1', visibility: 'team', owner_user_id: null, created_at: 1 }).execute();
    await storage.db.insertInto('messages').values({ id: 'm1', thread_id: 'th1', author_kind: 'user', author_id: 'owner', kind: 'note', body: 'Refunds always go back to the card they came from.', payload: '{}', created_at: context.now() }).execute();
    const done = await recordMemories(context, knowledge, { id: 'rem-2', agent_id: agents.Ada!, project_id: projectId, task_id: 't1' }, scope, [{ action: 'keep', type: 'decision', title: 'Refunds go to the original card', abstract: 'Refund to the card the payment came from.', body: 'The owner decided refunds always go back to the original card.', replaces: [], fromOwner: true, why: 'The owner said so on T-1.' }]);
    assert.equal((await storage.db.selectFrom('memories').select('source').where('id', '=', done.kept[0]!).executeTakeFirstOrThrow()).source, 'owner');
  } finally { await storage.close(); }
});
