import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { packageRoot } from '@agent-team/protocol';
import { createStorage } from '@agent-team/storage';
import { createContext } from '../context.ts';
import { createVersionedDocs } from '../repos/versionedDocs.ts';
import { createWorkspace } from '../repos/workspace.ts';
import { createProposals } from './proposals.ts';

async function boot() {
  const storage = await createStorage({ kind: 'sqlite', path: ':memory:' });
  await storage.migrate();
  const context = createContext({ storage, machineToken: 'x'.repeat(24) });
  // A role a proposal names has to be in the role library, as it is on every real start.
  await createVersionedDocs(context).seed('role', { type: 'library', id: '' }, JSON.parse(readFileSync(path.join(packageRoot(), 'blueprints', 'roles.json'), 'utf8')) as Record<string, unknown>);
  const projectId = await createWorkspace(context).registerProject({ slug: 'shop', name: 'Shop', kind: 'repo', manifest: {} });
  // A fourth seat, so that a majority is not everyone.
  const rune = await storage.db.selectFrom('agents').selectAll().where('name', '=', 'Rune').executeTakeFirstOrThrow();
  await storage.db.insertInto('agents').values({ ...rune, id: 'cleo', name: 'Cleo', initials: 'CL', sort: rune.sort + 1 }).execute();
  const agents = Object.fromEntries((await storage.db.selectFrom('agents').select(['id', 'name']).execute()).map(agent => [agent.name, agent.id])) as Record<string, string>;
  const turn = (name: string) => ({ agent_id: agents[name]!, project_id: projectId });
  return { storage, db: storage.db, proposals: createProposals(context), agents, turn, projectId };
}
const base = { why: 'Release week needs more e2e runs.', whatChanges: 'Raise the cap for a week.', evidence: [] };

test('inside the delegated bounds a majority applies the change without a human', async () => {
  const { storage, db, proposals, agents, turn } = await boot();
  const { proposalId } = await proposals.create(turn('Cleo'), { ...base, category: 'limits', title: 'Raise my cap', change: { kind: 'set_daily_cap', agentId: agents.Cleo!, capMinor: 1400 } });
  await assert.rejects(proposals.vote(turn('Cleo'), proposalId, { stance: 'for', note: 'mine' }), /own proposal/);
  assert.deepEqual(await proposals.vote(turn('Maren'), proposalId, { stance: 'for', note: 'fine for a week' }), { state: 'voting' });
  await proposals.vote(turn('Ada'), proposalId, { stance: 'against', note: 'route local instead' });
  assert.deepEqual(await proposals.vote(turn('Rune'), proposalId, { stance: 'for', note: 'ok' }), { state: 'auto_applied' });
  assert.equal((await db.selectFrom('agents').select('daily_cap_minor').where('id', '=', agents.Cleo!).executeTakeFirstOrThrow()).daily_cap_minor, 1400);
  await assert.rejects(proposals.vote(turn('Ada'), proposalId, { stance: 'for', note: 'late' }), /closed/);
  await storage.close();
});

test('outside the bounds it waits for a human, who approves or declines; a lost vote is declined', async () => {
  const { storage, db, proposals, agents, turn, projectId } = await boot();
  const everyone = async (id: string, by: string, stance: 'for' | 'against') => { let last: Awaited<ReturnType<typeof proposals.vote>> | undefined; for (const name of ['Maren', 'Ada', 'Cleo', 'Rune'].filter(item => item !== by)) last = await proposals.vote(turn(name), id, { stance, note: 'n' }); return last; };

  const retire = await proposals.create(turn('Maren'), { ...base, category: 'retire', title: 'Retire Rune', change: { kind: 'retire_agent', agentId: agents.Rune! } });
  assert.deepEqual(await everyone(retire.proposalId, 'Maren', 'for'), { state: 'needs_you' });
  assert.equal((await db.selectFrom('agents').select('status').where('id', '=', agents.Rune!).executeTakeFirstOrThrow()).status, 'active');
  await proposals.decide('user-1', retire.proposalId, 'approve', 'From next week');
  assert.equal((await db.selectFrom('agents').select('status').where('id', '=', agents.Rune!).executeTakeFirstOrThrow()).status, 'retired');
  await assert.rejects(proposals.decide('user-1', retire.proposalId, 'decline', null), /approved/);

  // A cap above what the team may grant itself also needs a human.
  const big = await proposals.create(turn('Cleo'), { ...base, category: 'limits', title: 'Big cap', change: { kind: 'set_daily_cap', agentId: agents.Cleo!, capMinor: 9000 } });
  for (const name of ['Maren', 'Ada']) await proposals.vote(turn(name), big.proposalId, { stance: 'for', note: 'n' });
  assert.equal((await proposals.list([projectId])).find(item => item.id === big.proposalId)!.state, 'needs_you');

  const lost = await proposals.create(turn('Ada'), { ...base, category: 'roles', title: 'Give me reviewer', change: { kind: 'add_role', agentId: agents.Ada!, role: 'reviewer' } });
  for (const name of ['Maren', 'Cleo']) await proposals.vote(turn(name), lost.proposalId, { stance: 'against', note: 'n' });
  const listed = await proposals.list([projectId]);
  assert.equal(listed.find(item => item.id === lost.proposalId)!.state, 'declined');
  assert.equal(listed.find(item => item.id === retire.proposalId)!.votes.length, 3);
  await storage.close();
});
