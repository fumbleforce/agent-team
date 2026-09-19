import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, PASSWORD, TOKEN } from '../http/testing.ts';
import { startCoordinator } from '../server.ts';
import { LOGIN_LIMITS } from './rateLimit.ts';

test('an account locks after repeated failures, the lock lives in storage, and the right password does not lift it', async () => {
  const { coordinator, db, call, owner } = await boot();
  try {
    await owner();
    const login = (password: string, email = 'owner@example.com') => call('/api/auth/login', { body: { email, password } });
    for (let attempt = 0; attempt < LOGIN_LIMITS.account; attempt++) assert.equal((await login('wrong-password-here')).status, 401);
    const refused = await login(PASSWORD);
    assert.equal(refused.status, 429);
    assert.equal(refused.json.error.code, 'locked');
    const row = await db.selectFrom('login_attempts').selectAll().where('subject', '=', 'account:owner@example.com').executeTakeFirstOrThrow();
    assert.equal(Number(row.failures), LOGIN_LIMITS.account);
    assert.ok(Number(row.locked_until) > Date.now());
    // The address is counted too, but one locked account does not lock everybody behind the same address.
    assert.ok(await db.selectFrom('login_attempts').select('subject').where('subject', 'like', 'ip:%').executeTakeFirst());
    assert.equal((await login('whatever-password', 'someone-else@example.com')).status, 401);
    const audit = await db.selectFrom('events').select('type').where('category', '=', 'audit').where('type', 'in', ['auth.login_failed', 'auth.locked']).execute();
    assert.equal(audit.filter(event => event.type === 'auth.locked').length, 1);
    // Once the lock has passed, the account signs in and its count is cleared.
    await db.updateTable('login_attempts').set({ locked_until: 1 }).where('subject', '=', 'account:owner@example.com').execute();
    assert.equal((await login(PASSWORD)).status, 200);
    assert.equal(await db.selectFrom('login_attempts').select('subject').where('subject', '=', 'account:owner@example.com').executeTakeFirst(), undefined);
  } finally { await coordinator.close(); }
});

test('an address locks across accounts', async () => {
  const { coordinator, db, call } = await boot();
  try {
    await db.insertInto('login_attempts').values({ subject: 'ip:203.0.113.9', failures: LOGIN_LIMITS.ip - 1, window_start: Date.now(), locked_until: null }).execute();
    // The test client is on loopback, which is where a forwarded address is believed.
    const from = { 'x-forwarded-for': '203.0.113.9' };
    assert.equal((await call('/api/auth/login', { headers: from, body: { email: 'a@example.com', password: 'wrong-password-here' } })).status, 401);
    assert.equal((await call('/api/auth/login', { headers: from, body: { email: 'b@example.com', password: 'wrong-password-here' } })).status, 429);
    assert.equal((await call('/api/auth/login', { body: { email: 'b@example.com', password: 'wrong-password-here' } })).status, 401);
  } finally { await coordinator.close(); }
});

test('named machine tokens work next to the root token until revoked, and are stored hashed', async () => {
  const { coordinator, db, call, owner, person } = await boot();
  try {
    const cookie = await owner();
    const member = await person('member', 'member');
    assert.equal((await call('/api/machine-tokens', { cookie: member.cookie, body: { name: 'x' } })).status, 403);
    assert.equal((await call('/api/machine-tokens', { cookie: member.cookie })).status, 403);
    const created = await call('/api/machine-tokens', { cookie, body: { name: 'build box' } });
    assert.equal(created.status, 200);
    const bearer = { authorization: `Bearer ${created.json.token}` };
    const stored = await db.selectFrom('machine_tokens').selectAll().executeTakeFirstOrThrow();
    assert.notEqual(stored.token_hash, created.json.token);
    assert.ok(!JSON.stringify(stored).includes(created.json.token));

    assert.equal((await call('/machine/projects', { headers: bearer, body: { slug: 'shop', name: 'Shop' } })).status, 200);
    assert.equal((await call('/worker/claim', { headers: bearer, body: { workerId: 'w1', free: { work: 1 }, projects: [] } })).status, 200);
    assert.equal((await call('/worker/claim', { headers: { authorization: `Bearer ${TOKEN}` }, body: { workerId: 'w1', free: { work: 1 }, projects: [] } })).status, 200);
    assert.equal((await call('/worker/claim', { headers: { authorization: 'Bearer mt_not-a-real-token' }, body: { workerId: 'w1', free: { work: 1 }, projects: [] } })).status, 401);
    // A machine token is not a person.
    assert.equal((await call('/api/me', { headers: bearer })).status, 401);

    const listed = await call('/api/machine-tokens', { cookie });
    assert.equal(listed.json.tokens[0].name, 'build box');
    assert.ok(listed.json.tokens[0].lastUsedAt);
    assert.equal(listed.json.tokens[0].token, undefined);
    assert.equal((await call(`/api/machine-tokens/${created.json.id}/revoke`, { cookie, method: 'POST' })).status, 200);
    assert.equal((await call('/worker/claim', { headers: bearer, body: { workerId: 'w1', free: { work: 1 }, projects: [] } })).status, 401);
    const audit = await db.selectFrom('events').select(['type', 'user_id']).where('type', 'like', 'auth.machine_token_%').orderBy('seq').execute();
    assert.deepEqual(audit.map(event => event.type), ['auth.machine_token_created', 'auth.machine_token_revoked']);
    assert.ok(audit.every(event => event.user_id));
  } finally { await coordinator.close(); }
});

test('the trusted header is refused on any bind but loopback', async () => {
  await assert.rejects(startCoordinator({ host: '100.64.0.1', port: 0, storage: { kind: 'sqlite', path: ':memory:' }, machineToken: TOKEN, webRoot: null, trustedHeader: 'X-Proxy-User' }), /loopback/);
});

test('on loopback the trusted header signs in a known person or a pending invitation, and nobody else', async () => {
  const { coordinator, db, call, owner } = await boot({ trustedHeader: 'X-Proxy-User' });
  try {
    const cookie = await owner();
    const known = await call('/api/me', { headers: { 'x-proxy-user': 'Owner@Example.com' } });
    assert.equal(known.status, 200);
    assert.equal(known.json.user.orgRole, 'owner');
    assert.ok(known.cookie, 'it opens an ordinary session');
    assert.equal((await call('/api/me', { cookie: known.cookie! })).status, 200);

    assert.equal((await call('/api/me', { headers: { 'x-proxy-user': 'stranger@example.com' } })).status, 401);
    await call('/api/invites', { cookie, body: { email: 'new@example.com', orgRole: 'member' } });
    const joined = await call('/api/me', { headers: { 'x-proxy-user': 'new@example.com' } });
    assert.equal(joined.json.user.orgRole, 'member');
    await db.updateTable('users').set({ status: 'disabled' }).where('email', '=', 'new@example.com').execute();
    assert.equal((await call('/api/me', { headers: { 'x-proxy-user': 'new@example.com' } })).status, 401);
    const status = await call('/api/settings/auth', { cookie });
    assert.deepEqual(status.json.trustedHeader, { enabled: true, header: 'x-proxy-user' });
  } finally { await coordinator.close(); }
});

test('without the mode configured the header means nothing', async () => {
  const { coordinator, call, owner } = await boot();
  try {
    await owner();
    assert.equal((await call('/api/me', { headers: { 'x-proxy-user': 'owner@example.com' } })).status, 401);
  } finally { await coordinator.close(); }
});

test('secure cookies carry the __Host- prefix, and signing out clears that cookie', async () => {
  const { coordinator, call } = await boot({ secureCookies: true });
  try {
    const link = await call('/machine/setup-link', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } });
    const setup = await call('/api/auth/setup', { body: { token: new URL(link.json.path, 'http://x').searchParams.get('token'), email: 'owner@example.com', name: 'Owner', password: PASSWORD, orgName: 'Acme' } });
    const header = setup.headers.get('set-cookie') ?? '';
    assert.match(header, /^__Host-session=/);
    assert.match(header, /Secure/);
    assert.match(header, /Path=\//);
    assert.doesNotMatch(header, /Domain=/i);
    const out = await call('/api/auth/logout', { method: 'POST', cookie: setup.cookie! });
    assert.equal(out.status, 200);
    assert.match(out.headers.get('set-cookie') ?? '', /^__Host-session=;/);
    assert.equal((await call('/api/me', { cookie: setup.cookie! })).status, 401);
  } finally { await coordinator.close(); }
});

test('passwords are at least 12 characters, and only the owner invites admins', async () => {
  const { coordinator, call, owner, person } = await boot();
  try {
    const cookie = await owner();
    const admin = await person('admin', 'admin');
    assert.equal((await call('/api/invites', { cookie: admin.cookie, body: { email: 'x@example.com', orgRole: 'admin' } })).status, 403);
    const invite = await call('/api/invites', { cookie, body: { email: 'x@example.com', orgRole: 'admin' } });
    const short = await call(`/api/auth${invite.json.path.replace('/invite/', '/invites/')}`, { body: { name: 'X', password: 'elevenchars' } });
    assert.equal(short.status, 400);
    assert.ok(short.json.error.fields.password);
    assert.equal((await call('/api/invites', { cookie, body: { email: 'owner@example.com', orgRole: 'member' } })).status, 409);
  } finally { await coordinator.close(); }
});
