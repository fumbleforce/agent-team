import test from 'node:test';
import assert from 'node:assert/strict';
import { newId } from '@agent-team/protocol';
import { startCoordinator } from '../server.ts';

const TOKEN = 'machine-token-for-tests-0123456789';

async function boot() {
  const coordinator = await startCoordinator({ port: 0, storage: { kind: 'sqlite', path: ':memory:' }, machineToken: TOKEN, webRoot: null });
  const call = async (path: string, options: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) => {
    const response = await fetch(coordinator.url + path, {
      method: options.method ?? (options.body ? 'POST' : 'GET'),
      headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.cookie ? { cookie: options.cookie } : {}), ...options.headers },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    return { status: response.status, json: await response.json().catch(() => null) as any, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  return { coordinator, call };
}

async function owner(call: Awaited<ReturnType<typeof boot>>['call']) {
  const link = await call('/machine/setup-link', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } });
  const token = new URL(link.json.path, 'http://x').searchParams.get('token');
  const setup = await call('/api/auth/setup', { body: { token, email: 'owner@example.com', name: 'Owner', password: 'a-long-enough-password', orgName: 'Acme' } });
  assert.equal(setup.status, 200);
  return setup.cookie!;
}

test('first run: setup link creates the owner once', async () => {
  const { coordinator, call } = await boot();
  assert.equal((await call('/machine/setup-link', { method: 'POST' })).status, 401);
  assert.equal((await call('/api/me')).status, 401);
  const cookie = await owner(call);
  const me = await call('/api/me', { cookie });
  assert.equal(me.json.user.orgRole, 'owner');
  assert.equal(me.json.org.name, 'Acme');
  const again = await call('/machine/setup-link', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(again.json.path, null);
  assert.equal((await call('/api/auth/login', { body: { email: 'owner@example.com', password: 'wrong-password-here' } })).status, 401);
  assert.equal((await call('/api/auth/login', { body: { email: 'owner@example.com', password: 'a-long-enough-password' } })).status, 200);
  await coordinator.close();
});

test('invited viewer reads its project, cannot post, and never sees another project', async () => {
  const { coordinator, call } = await boot();
  const cookie = await owner(call);
  const db = coordinator.context.storage.db;
  const project = (slug: string) => ({ id: newId(), slug, name: slug, kind: 'repo', parent_id: null, status: 'active', manifest: '{}', manifest_sha: null, team_id: null, sort: 0, created_at: 1 });
  const shop = project('shop'), secret = project('secret');
  await db.insertInto('projects').values([shop, secret]).execute();
  const threadId = newId();
  await db.insertInto('threads').values({ id: threadId, project_id: shop.id, kind: 'discussion', subject_type: null, subject_id: null, title: '#shop', visibility: 'team', owner_user_id: null, created_at: 1 }).execute();

  const invite = await call('/api/invites', { cookie, body: { email: 'v@example.com', orgRole: 'viewer', projects: [{ projectId: shop.id, role: 'member' }] } });
  const accepted = await call(`/api/auth${invite.json.path.replace('/invite/', '/invites/')}`, { body: { name: 'V', password: 'another-long-password' } });
  const viewer = accepted.cookie!;

  const tree = await call('/api/projects', { cookie: viewer });
  assert.deepEqual(tree.json.projects.map((p: any) => p.slug), ['shop']);
  assert.equal((await call('/api/projects/secret', { cookie: viewer })).status, 403);
  assert.equal((await call(`/api/threads/${threadId}/messages`, { cookie: viewer, body: { body: 'hello' } })).status, 403);
  assert.equal((await call(`/api/threads/${threadId}/messages`, { cookie, body: { body: 'hello team' } })).status, 200);
  const messages = await call(`/api/threads/${threadId}/messages`, { cookie: viewer });
  assert.equal(messages.json.messages[0].body, 'hello team');
  assert.equal((await call(`/api/threads/${threadId}/messages`, { cookie, body: { body: 'x' }, headers: { origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' } })).status, 403);
  await coordinator.close();
});

test('stream resumes after the last seen event and hides audit events', async () => {
  const { coordinator, call } = await boot();
  const cookie = await owner(call);
  const db = coordinator.context.storage.db;
  const projectId = newId(), threadId = newId();
  await db.insertInto('projects').values({ id: projectId, slug: 'p', name: 'P', kind: 'repo', parent_id: null, status: 'active', manifest: '{}', manifest_sha: null, team_id: null, sort: 0, created_at: 1 }).execute();
  await db.insertInto('threads').values({ id: threadId, project_id: projectId, kind: 'discussion', subject_type: null, subject_id: null, title: '#p', visibility: 'team', owner_user_id: null, created_at: 1 }).execute();
  await call(`/api/threads/${threadId}/messages`, { cookie, body: { body: 'one' } });
  const { seq } = (await call('/api/me', { cookie })).json;
  await call(`/api/threads/${threadId}/messages`, { cookie, body: { body: 'two' } });

  const controller = new AbortController();
  const response = await fetch(`${coordinator.url}/api/stream`, { headers: { cookie, 'last-event-id': String(seq) }, signal: controller.signal });
  const reader = response.body!.getReader();
  let text = '';
  while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value);
  controller.abort();
  assert.match(text, /"type":"message\.posted"/);
  assert.match(text, new RegExp(`id: ${seq + 1}`));
  assert.doesNotMatch(text, /auth\.owner_created/);
  await coordinator.close();
});
