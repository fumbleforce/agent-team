import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '@agent-team/storage';
import { createContext } from '../context.ts';
import { createWorkspace } from '../repos/workspace.ts';
import { createTrackerSync, taskStateOf, type TrackerIssue } from './tracker.ts';

const issue = (identifier: string, title: string, type: string, labels: string[] = [], name = type): TrackerIssue => ({ identifier, title, state: { name, type }, labels: labels.map(label => ({ name: label })) });

test('tracker states and progress labels map onto board columns', () => {
  assert.equal(taskStateOf(issue('A-1', 't', 'backlog')), 'backlog');
  assert.equal(taskStateOf(issue('A-1', 't', 'unstarted', ['agent:in-progress'])), 'in_progress');
  assert.equal(taskStateOf(issue('A-1', 't', 'started', [], 'In Review')), 'in_review');
  assert.equal(taskStateOf(issue('A-1', 't', 'completed')), 'done');
  assert.equal(taskStateOf(issue('A-1', 't', 'canceled')), 'canceled');
});

test('a poll mirrors issues; remote wins for title and state, local working states are kept', async () => {
  const storage = await createStorage({ kind: 'sqlite', path: ':memory:' });
  await storage.migrate();
  const context = createContext({ storage, machineToken: 'x'.repeat(24) });
  const projectId = await createWorkspace(context).registerProject({ slug: 'shop', name: 'Shop', kind: 'repo', manifest: {} });
  const sync = createTrackerSync(context);
  let issues = [issue('GH-1', 'Pay button hangs', 'unstarted', ['payments', 'agent:ready']), issue('GH-2', 'Old idea', 'canceled')];
  const client = { snapshot: async () => ({ allIssues: issues }) };

  assert.deepEqual(await sync.syncProject(projectId, client), { created: 1, updated: 0 });
  assert.deepEqual(await sync.syncProject(projectId, client), { created: 0, updated: 0 });
  const task = await storage.db.selectFrom('tasks').selectAll().executeTakeFirstOrThrow();
  assert.deepEqual([task.key, task.tag, task.state], ['GH-1', 'payments', 'backlog']);

  await storage.db.updateTable('tasks').set({ state: 'awaiting_decision', assignee_agent_id: null }).where('id', '=', task.id).execute();
  issues = [issue('GH-1', 'Pay button hangs on Safari', 'started', ['payments'])];
  await sync.syncProject(projectId, client);
  const kept = await storage.db.selectFrom('tasks').select(['title', 'state']).where('id', '=', task.id).executeTakeFirstOrThrow();
  assert.deepEqual([kept.title, kept.state], ['Pay button hangs on Safari', 'awaiting_decision']);

  issues = [issue('GH-1', 'Pay button hangs on Safari', 'completed')];
  await sync.syncProject(projectId, client);
  assert.equal((await storage.db.selectFrom('tasks').select('state').where('id', '=', task.id).executeTakeFirstOrThrow()).state, 'done');
  await storage.close();
});

test('the coordinator polls each project with a tracker and survives one that fails', async () => {
  const { startCoordinator } = await import('../server.ts');
  const coordinator = await startCoordinator({ port: 0, storage: { kind: 'sqlite', path: ':memory:' }, machineToken: 'x'.repeat(24), webRoot: null,
    trackers: async kind => (kind === 'broken' ? { snapshot: async () => { throw new Error('down'); } } : { snapshot: async () => ({ allIssues: [issue('GH-9', 'From the tracker', 'unstarted')] }) }) });
  const workspace = createWorkspace(coordinator.context);
  await workspace.registerProject({ slug: 'bad', name: 'Bad', kind: 'repo', manifest: { tracker: { kind: 'broken' } } });
  const good = await workspace.registerProject({ slug: 'good', name: 'Good', kind: 'repo', manifest: { tracker: { kind: 'github' } } });
  await workspace.registerProject({ slug: 'none', name: 'None', kind: 'repo', manifest: {} });
  await coordinator.poll();
  const tasks = await coordinator.context.storage.db.selectFrom('tasks').select(['project_id', 'key']).execute();
  assert.deepEqual(tasks.map(task => [task.project_id, task.key]), [[good, 'GH-9']]);
  await coordinator.close();
});
