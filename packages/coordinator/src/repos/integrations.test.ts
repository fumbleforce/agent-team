import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '@agent-team/storage';
import { createContext } from '../context.ts';
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
  await integrations.handToTeam('u1', id, await workspace.pm(projectId), discussion.id);
  await assert.rejects(integrations.handToTeam('u1', id, null, discussion.id), /already handed/);
  assert.match((await workspace.messages(discussion.id, { limit: 5 }))[0]!.body, /Handoff from codex: Desk lamp/);
  assert.equal((await storage.db.selectFrom('work_items').select('kind').execute()).length, 1);
  assert.equal((await integrations.handoffs(projectId))[0]!.state, 'handed');
  await storage.close();
});
