import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '@agent-team/storage';
import { createContext } from '../context.ts';
import { createWorkspace } from '../repos/workspace.ts';
import { createKnowledge } from './knowledge.ts';
import { recall } from './recall.ts';

async function setup() {
  const storage = await createStorage({ kind: 'sqlite', path: ':memory:' });
  await storage.migrate();
  let clock = 1_800_000_000_000;
  const context = createContext({ storage, machineToken: 'x'.repeat(24), now: () => clock++ });
  const projectId = await createWorkspace(context).registerProject({ slug: 'shop', name: 'Shop', kind: 'repo', manifest: {} });
  const agents = Object.fromEntries((await storage.db.selectFrom('agents').select(['id', 'name']).execute()).map(agent => [agent.name, agent.id])) as Record<string, string>;
  await storage.db.insertInto('tasks').values({ id: 't1', project_id: projectId, key: 'T-1', source: 'internal', title: 'Refunds round to the cent', brief: 'Refunds of card payments come out a cent short when the amount has three decimals.', tag: null, priority: 0, milestone_id: null, state: 'in_progress', assignee_agent_id: agents.Ada!, author_agent_id: null, branch: null, head_sha: null, pr_url: null, blocked_reason: null, created_at: 1, updated_at: 1 }).execute();
  return { storage, context, projectId, agents, knowledge: createKnowledge(context), scope: { type: 'project' as const, id: projectId } };
}

test('a turn is given what bears on its task, the owner\'s word first, within its budget, and which memories it got is kept', async () => {
  const { storage, projectId, agents, knowledge, scope } = await setup();
  try {
    const money = await knowledge.fileMemory({ scope, agentId: agents.Ada!, type: 'gotcha', title: 'Money is kept in minor units', body: 'Amounts are integers of cents; rounding a refund with floats loses a cent on three-decimal card amounts.', abstract: 'Cents as integers; never round refunds with floats.' });
    const owner = await knowledge.fileMemory({ scope, agentId: null, type: 'decision', title: 'Refunds go back to the original card', body: 'Never refund to store credit.', source: 'owner' });
    const unrelated = await knowledge.fileMemory({ scope, agentId: agents.Rune!, type: 'observation', title: 'The staging cluster is slow on Mondays', body: 'Deploys queue behind the weekly backup.' });
    const replaced = await knowledge.fileMemory({ scope, agentId: agents.Ada!, type: 'gotcha', title: 'Refunds use floats', body: 'Refund amounts are floats of card payments.' });
    await knowledge.supersede({ kind: 'agent', id: agents.Ada! }, { memoryIds: [replaced], by: money, reason: 'Amounts moved to integer cents.' });
    const forReviewers = await knowledge.fileMemory({ scope, agentId: agents.Rune!, type: 'convention', title: 'Run the refund suite with the card fixtures', body: 'npm test -- refunds uses the fixtures in test/cards.', roleSlug: 'reviewer' });

    const given = await storage.transaction(tx => recall(tx, { turnId: 'turn-1', kind: 'work', agentId: agents.Ada!, projectId, taskId: 't1', now: 5 }));
    const ids = given.items.map(item => item.id);
    assert.deepEqual(ids.slice(0, 2).sort(), [money, owner].sort(), 'what fits the task and what the owner said come first');
    assert.ok(!ids.includes(unrelated), 'what has nothing to do with the task is left out');
    assert.ok(!ids.includes(replaced), 'a superseded memory is not given');
    assert.ok(!ids.includes(forReviewers), 'what is kept for another role is not given to this one');
    assert.match(given.text, /Refunds go back to the original card \(from the owner\)/);
    assert.deepEqual((await storage.db.selectFrom('memory_injections').select('memory_id').where('turn_id', '=', 'turn-1').execute()).map(row => row.memory_id).sort(), ids.sort());

    const reviewer = await storage.transaction(tx => recall(tx, { turnId: 'turn-2', kind: 'review', agentId: agents.Rune!, projectId, taskId: 't1', now: 6 }));
    assert.ok(reviewer.items.some(item => item.id === forReviewers), 'the reviewer is given what reviewers of this project learned');
    assert.deepEqual((await storage.transaction(tx => recall(tx, { turnId: 'turn-3', kind: 'capture', agentId: agents.Ada!, projectId, taskId: 't1', now: 7 }))).items, [], 'a turn that runs no model is given nothing');
  } finally { await storage.close(); }
});

test('every change to a memory is on record, and replacing one can be undone', async () => {
  const { storage, agents, knowledge, scope } = await setup();
  try {
    const old = await knowledge.fileMemory({ scope, agentId: agents.Ada!, type: 'gotcha', title: 'Old', body: 'Old way.' });
    const fresh = await knowledge.fileMemory({ scope, agentId: agents.Ada!, type: 'gotcha', title: 'New', body: 'New way.' });
    await knowledge.supersede({ kind: 'agent', id: agents.Ada! }, { memoryIds: [old], by: fresh, reason: 'The way changed.' });
    await knowledge.restoreMemory({ kind: 'user', id: 'owner' }, old);
    const rows = Object.fromEntries((await storage.db.selectFrom('memories').select(['id', 'status', 'superseded_by']).execute()).map(row => [row.id, row]));
    assert.deepEqual([rows[old]!.status, rows[old]!.superseded_by, rows[fresh]!.status], ['confirmed', null, 'retired']);
    await knowledge.setMemoryStatus({ kind: 'user', id: 'owner' }, old, 'retired');
    const types = (await storage.db.selectFrom('events').select('type').where('type', 'like', 'memory.%').orderBy('seq').execute()).map(row => row.type);
    assert.deepEqual(types, ['memory.filed', 'memory.filed', 'memory.superseded', 'memory.restored', 'memory.status_changed']);
  } finally { await storage.close(); }
});
