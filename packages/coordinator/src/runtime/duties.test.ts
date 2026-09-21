import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '@agent-team/storage';
import { createContext } from '../context.ts';
import { seedDemo } from '../demo/seed.ts';
import { createDuties } from './duties.ts';
import { createScorecard } from './scorecard.ts';
import { createTurns } from './turns.ts';

const HOUR = 3600_000;

async function boot() {
  const storage = await createStorage({ kind: 'sqlite', path: ':memory:' });
  await storage.migrate();
  let clock = Date.UTC(2026, 5, 1, 7);
  const context = createContext({ storage, machineToken: 'x'.repeat(24), now: () => clock });
  await seedDemo(context);
  const db = storage.db;
  const project = await db.selectFrom('projects').select('id').where('slug', '=', 'checkout-v2').executeTakeFirstOrThrow();
  const agents = Object.fromEntries((await db.selectFrom('agents').select(['id', 'name']).execute()).map(row => [row.name, row.id])) as Record<string, string>;
  const turns = createTurns(context);
  return { storage, db, context, duties: createDuties(context, turns), projectId: project.id, agents, tick: (ms: number) => { clock += ms; }, now: () => clock };
}

test('a standing duty opens a task for its owner each time it comes round, starts them on it, and waits while the last one is open', async () => {
  const { storage, db, context, duties, projectId, agents, tick, now } = await boot();
  try {
    const set = await duties.set(projectId, { title: 'Read what users reported', brief: 'Read yesterday\'s reports. Write what matters as a page under reports/, and raise an issue for anything that needs work.', ownerAgentId: agents.Cleo!, everyHours: 24, result: 'document' });
    assert.equal(set.state, 'set');
    assert.equal(await duties.sweep(), 1, 'the first round is due at once');
    const first = await db.selectFrom('tasks').select(['id', 'title', 'state', 'assignee_agent_id', 'tag', 'result_kind']).where('tag', '=', 'duty').executeTakeFirstOrThrow();
    assert.deepEqual([first.title, first.state, first.assignee_agent_id, first.result_kind], ['Read what users reported (2026-06-01)', 'assigned', agents.Cleo, 'document']);
    assert.equal((await db.selectFrom('work_items').select('agent_id').where('task_id', '=', first.id).where('kind', '=', 'work').where('state', '=', 'queued').executeTakeFirstOrThrow()).agent_id, agents.Cleo);

    // A day on, the last round is still open: nothing piles up.
    tick(24 * HOUR + 1000);
    assert.equal(await duties.sweep(), 0);
    await db.updateTable('tasks').set({ state: 'done', updated_at: now() }).where('id', '=', first.id).execute();
    assert.equal(await duties.sweep(), 1);
    assert.equal((await db.selectFrom('tasks').select('id').where('tag', '=', 'duty').execute()).length, 2);
    assert.equal(await duties.sweep(), 0, 'not again before it comes round');

    // Finished work nobody asked for counts as the team's own.
    const card = await createScorecard(context).compute(projectId, { from: now() - 48 * HOUR, to: now() + 1000 });
    const own = card.figures.find(figure => figure.id === 'A5')!;
    assert.ok(own.value! > 0 && own.sample >= 1);

    // Changing a duty keeps its rhythm; ending it stops it.
    assert.equal((await duties.set(projectId, { title: 'Read what users reported', brief: 'Shorter.', ownerAgentId: agents.Ada!, everyHours: 12, result: 'document' })).state, 'changed');
    assert.equal((await duties.set(projectId, { title: 'Read what users reported', brief: 'x', ownerAgentId: agents.Ada!, everyHours: 0, result: 'document' })).state, 'ended');
    tick(48 * HOUR);
    await db.updateTable('tasks').set({ state: 'done' }).where('tag', '=', 'duty').execute();
    assert.equal(await duties.sweep(), 0);
    await assert.rejects(duties.set(projectId, { title: 'Other', brief: 'x', ownerAgentId: 'nobody', everyHours: 24, result: 'document' }), /not a seat of this team/);
  } finally { await storage.close(); }
});
