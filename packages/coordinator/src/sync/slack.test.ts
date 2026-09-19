import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '@agent-team/storage';
import { createContext } from '../context.ts';
import { ConnectionBody, createIntegrations } from '../repos/integrations.ts';
import { createWorkspace } from '../repos/workspace.ts';
import { createTurns } from '../runtime/turns.ts';
import { createSlackMirror } from './slack.ts';

test('team messages are mirrored once, with the token from the environment; private threads and old history are not', async () => {
  const storage = await createStorage({ kind: 'sqlite', path: ':memory:' });
  await storage.migrate();
  const context = createContext({ storage, machineToken: 'x'.repeat(24) });
  const workspace = createWorkspace(context);
  const projectId = await workspace.registerProject({ slug: 'shop', name: 'Shop', kind: 'repo', manifest: {} });
  await createIntegrations(context, createTurns(context)).connect('u1', projectId, ConnectionBody.parse({ kind: 'slack', name: 'Slack', category: 'comms', mode: 'mirror', credentialRef: 'SLACK_BOT_TOKEN', config: { channel: '#shop' } }));
  const discussion = await workspace.discussion(projectId);
  await workspace.postMessage({ kind: 'user', id: 'u1' }, discussion, { body: 'before the mirror started', kind: 'note' });

  const sent: { auth: string; body: { channel: string; text: string } }[] = [];
  const mirror = createSlackMirror(context, { env: { SLACK_BOT_TOKEN: 'xoxb-test' }, post: async (_url, init) => { sent.push({ auth: init.headers.authorization!, body: JSON.parse(init.body) }); return { ok: true, json: async () => ({ ok: true }) }; } });
  assert.equal(await mirror.sync(), 0);

  const maren = (await storage.db.selectFrom('agents').select('id').where('name', '=', 'Maren').executeTakeFirstOrThrow()).id;
  await workspace.postMessage({ kind: 'agent', id: maren }, discussion, { body: 'Ship it as revised.', kind: 'decision' });
  await storage.db.insertInto('threads').values({ id: 'dm', project_id: projectId, kind: 'dm', subject_type: null, subject_id: null, title: 'Direct', visibility: 'private', owner_user_id: 'u1', created_at: 1 }).execute();
  await workspace.postMessage({ kind: 'user', id: 'u1' }, { id: 'dm', project_id: projectId }, { body: 'private', kind: 'note' });

  assert.equal(await mirror.sync(), 1);
  assert.equal(await mirror.sync(), 0);
  assert.deepEqual([sent[0]!.auth, sent[0]!.body.channel], ['Bearer xoxb-test', '#shop']);
  assert.match(sent[0]!.body.text, /\*Maren\* \(#shop\): Decision — Ship it as revised\./);
  await storage.close();
});

test('a person’s reply in the channel arrives in the discussion, is acknowledged, and is not echoed back out', async () => {
  const { createSlackInbound } = await import('./slack.ts');
  const storage = await createStorage({ kind: 'sqlite', path: ':memory:' });
  await storage.migrate();
  const context = createContext({ storage, machineToken: 'x'.repeat(24) });
  const workspace = createWorkspace(context);
  const projectId = await workspace.registerProject({ slug: 'shop', name: 'Shop', kind: 'repo', manifest: {} });
  await createIntegrations(context, createTurns(context)).connect('u1', projectId, ConnectionBody.parse({ kind: 'slack', name: 'Slack', category: 'comms', credentialRef: 'SLACK_BOT_TOKEN', config: { channel: '#shop', channelId: 'C123' } }));
  const out: string[] = [];
  const mirror = createSlackMirror(context, { env: { SLACK_BOT_TOKEN: 't' }, post: async (_url, init) => { out.push(init.body); return { ok: true, json: async () => ({}) }; } });
  await mirror.sync();

  const acknowledged: string[] = [];
  const socket = { send: (data: string) => { acknowledged.push(data); }, close() {}, onmessage: null as ((event: { data: unknown }) => void) | null, onclose: null };
  const inbound = createSlackInbound(context, { env: { AGENT_TEAM_SLACK_APP_TOKEN: 'xapp-test' }, open: () => socket, post: async () => ({ ok: true, json: async () => ({ ok: true, url: 'wss://example.test/socket' }) }) });
  assert.ok(await inbound.connect());
  socket.onmessage!({ data: JSON.stringify({ envelope_id: 'e1', type: 'events_api', payload: { event: { type: 'message', channel: 'C123', user: 'U1', text: 'Ship it Friday.' } } }) });
  socket.onmessage!({ data: JSON.stringify({ envelope_id: 'e2', type: 'events_api', payload: { event: { type: 'message', channel: 'C123', bot_id: 'B1', text: 'mirrored post' } } }) });
  await new Promise(resolve => setTimeout(resolve, 50));

  assert.deepEqual(acknowledged.map(item => JSON.parse(item).envelope_id), ['e1', 'e2']);
  const discussion = await workspace.discussion(projectId);
  const messages = await workspace.messages(discussion.id, { limit: 10 });
  assert.deepEqual(messages.map(message => [message.body, message.payload.origin]), [['Ship it Friday.', 'slack']]);
  assert.equal(await mirror.sync(), 0);
  assert.equal(out.length, 0);
  assert.equal(await createSlackInbound(context, { env: {} }).connect(), null);
  await storage.close();
});
