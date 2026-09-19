import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '@agent-team/storage';
import { createContext } from '../context.ts';
import { createWorkspace } from '../repos/workspace.ts';
import { createRetro } from './retro.ts';
import { createTurns } from './turns.ts';

test('a due retro posts the week’s figures and asks the seats that worked, the PM last; an idle week asks nobody', async () => {
  const storage = await createStorage({ kind: 'sqlite', path: ':memory:' });
  await storage.migrate();
  let clock = 1_000_000;
  const context = createContext({ storage, machineToken: 'x'.repeat(24), now: () => clock });
  const workspace = createWorkspace(context);
  const projectId = await workspace.registerProject({ slug: 'shop', name: 'Shop', kind: 'repo', manifest: {} });
  const turns = createTurns(context), retro = createRetro(context, turns);
  await retro.ensureSchedule(projectId, 1000);
  await retro.ensureSchedule(projectId, 1000);
  const agents = Object.fromEntries((await storage.db.selectFrom('agents').select(['id', 'name']).execute()).map(agent => [agent.name, agent.id])) as Record<string, string>;

  for (const name of ['Ada', 'Maren']) {
    await turns.enqueue({ agentId: agents[name]!, projectId, kind: 'reply' });
    const claimed = (await turns.claim({ workerId: 'w1', free: { bounded: 1 }, projects: [projectId] }))!;
    clock += 60_000;
    await turns.finish(claimed.turnId, 'w1', claimed.leaseToken, { state: name === 'Ada' ? 'failed' : 'completed', costMinor: 40 });
  }
  await retro.sweep();
  const discussion = await workspace.discussion(projectId);
  const posted = (await workspace.messages(discussion.id, { limit: 5 })).at(-1)!;
  assert.match(posted.body, /Ada: 1 turns, 1 failed, 0\.40 spent, 1 min busy/);
  const asked = await storage.db.selectFrom('work_items').innerJoin('agents', 'agents.id', 'work_items.agent_id').select(['agents.name', 'work_items.not_before']).where('work_items.kind', '=', 'retro').execute();
  assert.deepEqual(asked.map(row => [row.name, row.not_before === null]).sort(), [['Ada', true], ['Maren', false]]);

  await storage.db.deleteFrom('work_items').where('kind', '=', 'retro').execute();
  clock += 2000;
  await retro.sweep();
  assert.equal((await storage.db.selectFrom('work_items').select('id').where('kind', '=', 'retro').execute()).length, 0);
  await storage.close();
});
