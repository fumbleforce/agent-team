import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '@agent-team/storage';
import { createContext } from '../context.ts';
import { seedDemo } from '../demo/seed.ts';
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

test('the retro is held over the scorecard too: what misses its target, and whether the team\'s own finished ideas moved the figure they named', async () => {
  const storage = await createStorage({ kind: 'sqlite', path: ':memory:' });
  await storage.migrate();
  let clock = Date.UTC(2026, 5, 8);
  const context = createContext({ storage, machineToken: 'x'.repeat(24), now: () => clock });
  try {
    await seedDemo(context, { activity: true });
    const db = storage.db, turns = createTurns(context), retro = createRetro(context, turns);
    const project = await db.selectFrom('projects').select('id').where('slug', '=', 'checkout-v2').executeTakeFirstOrThrow();
    const agent = await db.selectFrom('agents').select('id').executeTakeFirstOrThrow();
    const WEEK = 7 * 24 * 3600_000, HOUR = 3600_000;
    await db.updateTable('work_items').set({ state: 'done' }).execute();
    await db.deleteFrom('schedules').execute();
    await retro.ensureSchedule(project.id, WEEK);
    const task = (id: string, brief: string, created: number, done: number) => ({ id, project_id: project.id, key: id.toUpperCase(), source: 'tracker', title: `Idea ${id}`, brief, tag: null, priority: 9, milestone_id: null, state: 'done', assignee_agent_id: agent.id, author_agent_id: null, branch: null, head_sha: null, pr_url: null, blocked_reason: null, created_at: created, updated_at: done });
    // The week before, work took ten hours; this week, two. One idea named that figure, the other named none.
    await db.deleteFrom('tasks').where('state', '=', 'done').execute();
    await db.insertInto('tasks').values([task('old-1', 'plain', clock - 10 * HOUR, clock - 1000)] as never).execute();
    clock += WEEK;
    await db.insertInto('tasks').values([
      task('idea-1', 'Problem: slow.\nWould show it worked\nScorecard figure P1 going down\nAgent-Team idea: t1:1', clock - 2 * HOUR, clock - 1000),
      task('idea-2', 'Problem: dull.\nAgent-Team idea: t1:2', clock - 2 * HOUR, clock - 1000),
    ] as never).execute();
    // Somebody worked this week, so the retro opens.
    await db.insertInto('workers').values({ id: 'w-retro', name: 'w', lanes: '{}', isolation: 'isolated', providers: '[]', projects: '[]', last_seen_at: clock }).execute();
    await db.insertInto('work_items').values({ id: 'wi-retro', agent_id: agent.id, project_id: project.id, kind: 'work', lane: 'work', task_id: 'idea-1', thread_id: null, priority_class: 5, state: 'done', defer_reason: null, not_before: null, dedupe_key: 'r', cause_event_id: null, created_at: clock } as never).execute();
    await db.insertInto('turns').values({ id: 't-retro', work_item_id: 'wi-retro', agent_id: agent.id, project_id: project.id, task_id: 'idea-1', kind: 'work', lane: 'work', access: 'write', state: 'completed', stop_reason: null, worker_id: 'w-retro', lease_token_hash: 'h', lease_until: clock, grants: '{}', summary: 's', tokens_in: 0, tokens_out: 0, cost_minor: 0, started_at: clock - HOUR, finished_at: clock - HOUR / 2, provider_id: null, model: null, session_id: null, context_mode: 'packet', git_admin: false } as never).execute();
    clock += 1000;
    await retro.sweep();
    const note = await db.selectFrom('messages').select('body').where('payload', 'like', '%"retro":true%').orderBy('created_at', 'desc').executeTakeFirstOrThrow();
    assert.match(note.body, /Ideas of ours finished this week, and the figure each named:/);
    assert.match(note.body, /IDEA-1 Idea idea-1: P1 went from 10\.0 h to 2\.0 h, expected down: it moved as said/);
    assert.match(note.body, /IDEA-2 Idea idea-2: named no figure, so nothing says whether it was worth it/);
  } finally { await storage.close(); }
});
