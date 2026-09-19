import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '@agent-team/storage';
import { createContext } from '../context.ts';
import { buildPacket } from '../runtime/packet.ts';
import { createTurns } from '../runtime/turns.ts';
import { ConnectionBody, createIntegrations } from './integrations.ts';
import { createWorkspace } from './workspace.ts';

test('a connection names its credential without holding it; a handoff reaches the discussion and the PM once', async () => {
  const storage = await createStorage({ kind: 'sqlite', path: ':memory:' });
  await storage.migrate();
  const context = createContext({ storage, machineToken: 'x'.repeat(24) });
  const workspace = createWorkspace(context);
  const projectId = await workspace.registerProject({ slug: 'shop', name: 'Shop', kind: 'repo', manifest: {} });
  const integrations = createIntegrations(context, createTurns(context));

  assert.equal(ConnectionBody.safeParse({ kind: 'slack', name: 'Slack', category: 'comms', credentialRef: 'xoxb-secret-value' }).success, false);
  await integrations.connect('u1', projectId, ConnectionBody.parse({ kind: 'slack', name: 'Slack', category: 'comms', mode: 'mirror', credentialRef: 'SLACK_BOT_TOKEN', config: { channel: '#shop' } }));
  await integrations.connect('u1', projectId, ConnectionBody.parse({ kind: 'notion', name: 'Notion', category: 'storage' }));
  assert.deepEqual((await integrations.connections(projectId)).map(item => [item.name, item.status, item.credentialRef]), [['Slack', 'connected', 'SLACK_BOT_TOKEN'], ['Notion', 'warning', null]]);

  const id = await integrations.receive('u1', projectId, { source: 'codex', title: 'Desk lamp 3D model', summary: 'lamp.glb, three variants.', context: { prompts: 12 } });
  const discussion = await workspace.discussion(projectId);
  await integrations.handToTeam('u1', projectId, id, await workspace.pm(projectId), discussion.id);
  await assert.rejects(integrations.handToTeam('u1', projectId, id, null, discussion.id), /already handed/);
  assert.match((await workspace.messages(discussion.id, { limit: 5 }))[0]!.body, /Handoff from codex: Desk lamp/);
  assert.equal((await storage.db.selectFrom('work_items').select('kind').execute()).length, 1);
  assert.deepEqual((({ state, target }) => ({ state, target: target?.type }))((await integrations.handoffs(projectId))[0]!), { state: 'handed', target: 'team' });
  await storage.close();
});

test('a handoff attaches to a task of its project, reaches whoever works on it, and an outbound one waits for its result', async () => {
  const storage = await createStorage({ kind: 'sqlite', path: ':memory:' });
  try {
    await storage.migrate();
    const context = createContext({ storage, machineToken: 'x'.repeat(24) });
    const workspace = createWorkspace(context), integrations = createIntegrations(context, createTurns(context)), db = storage.db;
    const projectId = await workspace.registerProject({ slug: 'shop', name: 'Shop', kind: 'repo', manifest: {} }), otherId = await workspace.registerProject({ slug: 'other', name: 'Other', kind: 'repo', manifest: {} });
    const project = await db.selectFrom('projects').select('team_id').where('id', '=', projectId).executeTakeFirstOrThrow();
    const agent = await db.selectFrom('agents').select('id').where('team_id', '=', project.team_id!).where('is_pm', '=', false).executeTakeFirstOrThrow();
    const task = (id: string, inProject: string) => ({ id, project_id: inProject, key: id.toUpperCase(), source: 'internal', title: 'Lamp page', brief: 'Build the page.', tag: null, priority: 0, milestone_id: null, state: 'assigned', assignee_agent_id: inProject === projectId ? agent.id : null, author_agent_id: null, branch: null, head_sha: null, pr_url: null, blocked_reason: null, created_at: 1, updated_at: 1 });
    await db.insertInto('tasks').values([task('t-1', projectId), task('t-2', otherId)]).execute();

    const id = await integrations.receive('u1', projectId, { source: 'design tool', title: 'Lamp renders', summary: 'Three variants, the second is preferred.', context: {} });
    await assert.rejects(integrations.attachToTask('u1', projectId, id, 't-2'), /not part of this project/);
    await assert.rejects(integrations.attachToTask('u1', otherId, id, 't-2'), /not found/i);
    await integrations.attachToTask('u1', projectId, id, 't-1');
    await assert.rejects(integrations.attachToTask('u1', projectId, id, 't-1'), /already attached/);
    await assert.rejects(integrations.handToTeam('u1', projectId, id, null, 'any'), /already attached/);

    const [shown] = await integrations.handoffs(projectId);
    assert.deepEqual([shown!.state, shown!.target], ['attached', { type: 'task', id: 't-1', key: 'T-1', title: 'Lamp page' }]);
    assert.deepEqual((await db.selectFrom('handoffs').select(['target_type', 'target_id']).where('id', '=', id).execute()).map(row => ({ ...row })), [{ target_type: 'task', target_id: 't-1' }]);
    assert.deepEqual((await db.selectFrom('links').select(['from_type', 'from_id', 'to_type', 'to_id']).execute()).map(row => ({ ...row })), [{ from_type: 'handoff', from_id: id, to_type: 'task', to_id: 't-1' }]);
    assert.deepEqual((await db.selectFrom('work_items').select(['agent_id', 'kind', 'task_id']).execute()).map(row => ({ ...row })), [{ agent_id: agent.id, kind: 'work', task_id: 't-1' }]);
    assert.equal((await db.selectFrom('events').select('type').where('type', '=', 'handoff.attached').execute()).length, 1);
    const packet = await storage.transaction(tx => buildPacket(tx, { kind: 'work', agentId: agent.id, projectId, taskId: 't-1', threadId: null }));
    assert.match(packet.prompt, /Handed over from elsewhere\n- From design tool: Lamp renders\n {2}Three variants/);

    const sent = await integrations.send(agent.id, projectId, { destination: 'print shop', title: 'Proofs for the lamp leaflet', summary: '', context: { copies: 3 }, taskId: 't-1' });
    await assert.rejects(integrations.recordResult('u1', projectId, id, 'x'), /still waiting/);
    assert.deepEqual((({ state, result, target }) => [state, result, target?.key])((await integrations.handoffs(projectId)).find(item => item.id === sent)!), ['outbox', null, 'T-1']);
    await integrations.recordResult('u1', projectId, sent, 'Proofs approved, printing on Friday.');
    assert.deepEqual((({ state, result }) => [state, result])((await integrations.handoffs(projectId)).find(item => item.id === sent)!), ['returned', 'Proofs approved, printing on Friday.']);
    await assert.rejects(integrations.recordResult('u1', projectId, sent, 'again'), /still waiting/);
  } finally { await storage.close(); }
});
