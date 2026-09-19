import assert from 'node:assert/strict';
import { newId, type OrgRole, type ProjectRole } from '@agent-team/protocol';
import { createAccounts } from '../auth/accounts.ts';
import { startCoordinator, type CoordinatorConfig } from '../server.ts';

export const TOKEN = 'machine-token-for-tests-0123456789';
export const PASSWORD = 'a-long-enough-password';

// A coordinator on a throwaway database with an owner, plus helpers to call it and to make people and projects. Close it in `finally`.
export async function boot(config: Partial<CoordinatorConfig> = {}) {
  const coordinator = await startCoordinator({ port: 0, storage: { kind: 'sqlite', path: ':memory:' }, machineToken: TOKEN, webRoot: null, trackers: null, ...config });
  const db = coordinator.context.storage.db;
  const call = async (path: string, options: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) => {
    const response = await fetch(coordinator.url + path, {
      method: options.method ?? (options.body !== undefined ? 'POST' : 'GET'),
      headers: { ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(options.cookie ? { cookie: options.cookie } : {}), ...options.headers },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    const text = await response.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, json, text, headers: response.headers, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const machine = { authorization: `Bearer ${TOKEN}` };
  const owner = async () => {
    const link = await call('/machine/setup-link', { method: 'POST', headers: machine });
    const setup = await call('/api/auth/setup', { body: { token: new URL(link.json.path, 'http://x').searchParams.get('token'), email: 'owner@example.com', name: 'Owner', password: PASSWORD, orgName: 'Acme' } });
    assert.equal(setup.status, 200);
    return setup.cookie!;
  };
  const cookieName = config.secureCookies ? '__Host-session' : 'session';
  // A person with a session, made directly: the invitation flow has its own test.
  const person = async (name: string, orgRole: OrgRole, grants: Record<string, ProjectRole> = {}) => {
    const id = newId();
    await db.insertInto('users').values({ id, email: `${name}@example.com`, name, password_hash: null, org_role: orgRole, status: 'active', created_at: 1, last_login_at: null }).execute();
    for (const [projectId, role] of Object.entries(grants)) await db.insertInto('project_members').values({ project_id: projectId, user_id: id, role }).execute();
    return { id, cookie: `${cookieName}=${await createAccounts(coordinator.context).sessionFor(id, 'test')}` };
  };
  const project = async (slug: string) => (await call('/machine/projects', { headers: machine, body: { slug, name: slug } })).json.id as string;
  return { coordinator, db, call, machine, owner, person, project };
}
