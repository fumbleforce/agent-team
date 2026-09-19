import test from 'node:test';
import assert from 'node:assert/strict';
import { seedDemo } from '../demo/seed.ts';
import { startCoordinator } from '../server.ts';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

test('raising an issue with a screenshot numbers it, opens its thread and hands it to the PM', async () => {
  const coordinator = await startCoordinator({ port: 0, storage: { kind: 'sqlite', path: ':memory:' }, machineToken: 'x'.repeat(24), webRoot: null });
  await seedDemo(coordinator.context);
  const login = await fetch(`${coordinator.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'demo@example.com', password: 'demo-password-1234' }) });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const call = async (path: string, init: RequestInit = {}) => { const response = await fetch(coordinator.url + path, { ...init, headers: { cookie, ...(init.headers as Record<string, string> | undefined) } }); return { status: response.status, response }; };
  const json = async (path: string, body?: unknown) => { const { status, response } = await call(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}); return { status, body: await response.json() as any }; };

  const upload = await call('/api/attachments?name=checkout-safari.png', { method: 'POST', headers: { 'content-type': 'image/png' }, body: PNG });
  const { id: attachmentId } = await upload.response.json() as { id: string };
  assert.equal((await call('/api/attachments', { method: 'POST', headers: { 'content-type': 'text/html' }, body: '<script>' })).status, 415);
  const again = await call('/api/attachments?name=other.png', { method: 'POST', headers: { 'content-type': 'image/png' }, body: PNG });
  assert.equal((await again.response.json() as { id: string }).id, attachmentId);
  const served = await call(`/api/attachments/${attachmentId}`);
  assert.deepEqual([served.response.headers.get('content-type'), served.response.headers.get('x-content-type-options'), (await served.response.arrayBuffer()).byteLength], ['image/png', 'nosniff', PNG.length]);

  const created = await json('/api/projects/checkout-v2/issues', { title: 'Pay button hangs after a network drop', body: 'Stays on Processing for 20 s on Safari.', source: 'product', attachmentId });
  assert.equal(created.body.number, 1);
  assert.equal((await json('/api/projects/checkout-v2/issues', { title: 'Second', body: 'b' })).body.number, 2);
  const thread = await json(`/api/threads/${created.body.threadId}/messages`);
  assert.equal(thread.body.messages[0].payload.attachmentId, attachmentId);
  const triage = await coordinator.context.storage.db.selectFrom('work_items').innerJoin('agents', 'agents.id', 'work_items.agent_id').select(['agents.name', 'work_items.kind']).where('work_items.thread_id', '=', created.body.threadId).executeTakeFirstOrThrow();
  assert.deepEqual([triage.name, triage.kind], ['Maren', 'triage']);

  // @name in the body of a new issue is a mention on its first message: the one named is asked directly and the PM still triages.
  const named = await json('/api/projects/checkout-v2/issues', { title: 'Webhook retries', body: 'Signature check fails on retry. @ada can you look? Not for @nobody.' });
  const db = coordinator.context.storage.db;
  const first = (await json(`/api/threads/${named.body.threadId}/messages`)).body.messages[0];
  assert.equal(first.id, named.body.messageId);
  assert.deepEqual((await db.selectFrom('mentions').innerJoin('agents', 'agents.id', 'mentions.agent_id').select(['mentions.message_id', 'agents.name', 'mentions.state', 'mentions.author_kind']).where('mentions.thread_id', '=', named.body.threadId).execute()).map(row => ({ ...row })), [{ message_id: first.id, name: 'Ada', state: 'woken', author_kind: 'user' }]);
  assert.deepEqual((await db.selectFrom('work_items').innerJoin('agents', 'agents.id', 'work_items.agent_id').select(['agents.name', 'work_items.kind', 'work_items.priority_class']).where('work_items.thread_id', '=', named.body.threadId).orderBy('work_items.kind').execute()).map(row => ({ ...row })), [{ name: 'Ada', kind: 'reply', priority_class: 1 }, { name: 'Maren', kind: 'triage', priority_class: 3 }]);

  // Images attached in a composer are stored on the message, not written into its text.
  const posted = await json(`/api/threads/${named.body.threadId}/messages`, { body: 'This is what it looks like.', attachmentIds: [attachmentId, attachmentId] });
  assert.equal(posted.status, 200);
  const stored = (await json(`/api/threads/${named.body.threadId}/messages`)).body.messages.at(-1);
  assert.deepEqual([stored.body, stored.payload], ['This is what it looks like.', { attachmentIds: [attachmentId] }]);
  assert.equal((await json(`/api/threads/${named.body.threadId}/messages`, { body: 'Missing image.', attachmentIds: ['no-such-image'] })).status, 400);

  await json('/api/projects/checkout-v2/issues/1/close', {});
  const listed = await json('/api/projects/checkout-v2/issues');
  assert.deepEqual(listed.body.issues.map((issue: any) => [issue.number, issue.state]), [[3, 'open'], [2, 'open'], [1, 'closed']]);
  await coordinator.close();
});
