import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Hono } from 'hono';
import type { Viewer } from '../auth/rbac.ts';
import { onError } from './conventions.ts';
import { mountSsoSetupRoutes } from './ssoSetupRoutes.ts';
import { boot } from './testing.ts';

const SECRET = 'AGENT_TEAM_OIDC_SECRET';

// A sign-in service on this machine: it answers discovery under its own address, under /renamed as somebody else, and everywhere else with a page that must never be passed on.
async function fakeIdentityService() {
  const server = createServer((request, response) => {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const document = (issuer: string) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ issuer, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token` })); };
    if (request.url === '/.well-known/openid-configuration') return document(origin);
    if (request.url === '/renamed/.well-known/openid-configuration') return document('https://elsewhere.example');
    response.statusCode = request.url?.startsWith('/page') ? 200 : 404;
    response.end('<html>INTERNAL-PAGE-BODY</html>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

test('single sign-on is set up through the guided flow: checked in plain words, saved through the sign-in settings, owner only', async () => {
  const { coordinator, db, call, owner, person } = await boot();
  const identity = await fakeIdentityService();
  const before = process.env[SECRET];
  try {
    delete process.env[SECRET];
    const cookie = await owner(), admin = await person('ada', 'admin'), member = await person('mel', 'member');

    // Admins read the catalog; it speaks each product's language and carries no functions.
    assert.equal((await call('/api/settings/sso/catalog', { cookie: member.cookie })).status, 403);
    const catalog = (await call('/api/settings/sso/catalog', { cookie: admin.cookie })).json;
    assert.deepEqual(catalog.entries.map((entry: { title: string }) => entry.title), ['Google Workspace', 'Microsoft Entra ID', 'Okta', 'Auth0', 'Keycloak', 'Another OpenID Connect provider']);
    assert.ok(catalog.entries.every((entry: { steps: string[]; issuer?: unknown; fields: { key: string }[] }) => entry.steps.length >= 4 && entry.issuer === undefined && entry.fields.some(field => field.key === 'clientId') && entry.steps.some(step => /Client secret/.test(step)) && !entry.steps.some(step => step.includes(SECRET))));
    assert.match(catalog.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/api\/auth\/oidc\/callback$/);
    assert.deepEqual([catalog.current, catalog.canEdit, catalog.secret], [null, false, { variable: SECRET, present: false }]);

    // Only the owner checks, sets up and turns off.
    const entered = { kind: 'oidc', values: { issuer: identity.origin, clientId: 'agent-team' } };
    for (const path of ['test', 'setup', 'off']) assert.equal((await call(`/api/settings/sso/${path}`, { cookie: admin.cookie, body: entered })).status, 403, path);
    assert.equal((await call('/api/settings/auth', { cookie })).json.oidc, null);

    // What was typed is answered field by field.
    const bad = await call('/api/settings/sso/setup', { cookie, body: { kind: 'microsoft-entra', values: { tenant: 'contoso', clientId: '' } } });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error.fields.tenant, /Directory \(tenant\) ID does not look right; it should look like 72f988bf/);
    assert.match(bad.json.error.fields.clientId, /Application \(client\) ID is needed/);
    assert.match((await call('/api/settings/sso/setup', { cookie, body: { kind: 'oidc', values: { issuer: 'http://id.example.com', clientId: 'x-y-z' } } })).json.error.fields.issuer, /starts with https:\/\//);
    assert.match((await call('/api/settings/sso/setup', { cookie, body: { ...entered, allowedDomains: 'example.com, acme' } })).json.error.fields.allowedDomains, /"acme" does not look like an email domain/);
    assert.equal((await call('/api/settings/sso/test', { cookie, body: {} })).status, 404);

    // The check finds the service and says the secret is missing; an address that is something else is said so, without its body.
    const waiting = (await call('/api/settings/sso/test', { cookie, body: entered })).json;
    assert.deepEqual([waiting.ok, waiting.checks[0], waiting.checks[1].ok], [false, { ok: true, message: 'Found a sign-in service at that address.' }, false]);
    assert.match(waiting.checks[1].message, /Paste the client secret/);
    for (const issuer of [`${identity.origin}/page`, `${identity.origin}/nothing`, 'http://127.0.0.1:1']) {
      const silent = await call('/api/settings/sso/test', { cookie, body: { kind: 'oidc', values: { issuer, clientId: 'agent-team' } } });
      assert.deepEqual(silent.json.checks[0], { ok: false, message: 'That address does not answer as a sign-in service.' }, issuer);
      assert.doesNotMatch(silent.text, /INTERNAL-PAGE-BODY/);
    }
    assert.match((await call('/api/settings/sso/test', { cookie, body: { kind: 'oidc', values: { issuer: `${identity.origin}/renamed`, clientId: 'agent-team' } } })).json.checks[0].message, /goes by another address/);
    process.env[SECRET] = 'shh';
    assert.equal((await call('/api/settings/sso/test', { cookie, body: entered })).json.ok, true);

    // Setting up writes the same settings the sign-in page reads, with the same audit entry.
    assert.equal((await call('/api/settings/sso/setup', { cookie, body: { ...entered, allowedDomains: '@Example.com example.org', defaultRole: 'member' } })).status, 200);
    assert.deepEqual((await call('/api/settings/auth', { cookie })).json.oidc, { issuer: identity.origin, clientId: 'agent-team', clientSecretEnv: SECRET, allowedDomains: ['example.com', 'example.org'], defaultRole: 'member', allowInsecure: true, provider: 'oidc' });
    assert.equal((await db.selectFrom('events').select('id').where('type', '=', 'settings.changed').execute()).length, 1);
    assert.equal((await call('/api/auth/oidc')).json.enabled, true);
    const current = (await call('/api/settings/sso/catalog', { cookie })).json.current;
    assert.deepEqual(current, { kind: 'oidc', title: new URL(identity.origin).host, allowedDomains: ['example.com', 'example.org'], defaultRole: 'member', secret: { variable: SECRET, present: true } });
    assert.equal((await call('/api/settings/sso/test', { cookie, body: {} })).json.ok, true, 'what is saved can be checked again');

    assert.equal((await call('/api/settings/sso/off', { cookie, body: {} })).status, 200);
    assert.deepEqual([(await call('/api/settings/auth', { cookie })).json.oidc, (await call('/api/auth/oidc')).json.enabled], [null, false]);
  } finally {
    if (before === undefined) delete process.env[SECRET]; else process.env[SECRET] = before;
    await identity.close();
    await coordinator.close();
  }
});

test('each product\'s sign-in address is derived from what was copied back, and discovery is asked there', async () => {
  const { coordinator } = await boot();
  try {
    const asked: string[] = [];
    const answers = new Map<string, string>([
      ['https://accounts.google.com', 'https://accounts.google.com'],
      ['https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47/v2.0', 'https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47/v2.0'],
      ['https://acme.okta.com', 'https://acme.okta.com'], ['https://acme.eu.auth0.com', 'https://acme.eu.auth0.com/'], ['https://id.example.com/realms/company', 'https://id.example.com/realms/company'],
    ]);
    const request = (async (input: string | URL | Request) => {
      const url = String(input), base = url.replace('/.well-known/openid-configuration', '');
      asked.push(url);
      const issuer = answers.get(base);
      return issuer ? Response.json({ issuer, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token` }) : new Response('{"error":"invalid_tenant","detail":"PRIVATE"}', { status: 400 });
    }) as typeof fetch;
    const app = new Hono<{ Variables: { viewer: Viewer } }>();
    app.onError(onError);
    app.use(async (c, next) => { c.set('viewer', { userId: 'u', orgRole: 'owner', projects: new Map() }); await next(); });
    mountSsoSetupRoutes(app, { context: coordinator.context, callbackUri: () => 'https://team.example.com/api/auth/oidc/callback', env: { AGENT_TEAM_OIDC_SECRET: 'shh' }, fetch: request });
    const check = async (kind: string, values: Record<string, string>) => (await app.request('/api/settings/sso/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, values }) })).json() as Promise<{ ok: boolean; checks: { ok: boolean; message: string }[] }>;

    const uuid = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
    assert.deepEqual(await check('microsoft-entra', { tenant: '72F988BF-86f1-41af-91ab-2d7cd011db47', clientId: uuid }), { ok: true, checks: [{ ok: true, message: 'Found Microsoft\'s sign-in service for your tenant.' }, { ok: true, message: 'The client secret is here.' }] });
    assert.equal((await check('google-workspace', { clientId: '123-abc.apps.googleusercontent.com' })).checks[0]!.message, 'Found Google\'s sign-in service.');
    assert.equal((await check('okta', { domain: 'acme.okta.com', clientId: '0oa1b2c3d4' })).ok, true);
    assert.equal((await check('auth0', { domain: 'acme.eu.auth0.com', clientId: 'aBcD1234' })).ok, true, 'an issuer that ends with a slash is the same service');
    assert.equal((await check('keycloak', { server: 'https://id.example.com/', realm: 'company', clientId: 'agent-team' })).ok, true);
    const unknown = await check('microsoft-entra', { tenant: '00000000-0000-4000-8000-000000000000', clientId: uuid });
    assert.deepEqual([unknown.ok, unknown.checks[0]!.ok], [false, false]);
    assert.match(unknown.checks[0]!.message, /Microsoft has no tenant with that ID/);
    assert.doesNotMatch(JSON.stringify(unknown), /PRIVATE|invalid_tenant/);
    assert.deepEqual(asked.slice(0, 2), ['https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47/v2.0/.well-known/openid-configuration', 'https://accounts.google.com/.well-known/openid-configuration']);
    assert.ok(asked.includes('https://acme.eu.auth0.com/.well-known/openid-configuration') && asked.includes('https://id.example.com/realms/company/.well-known/openid-configuration'));
  } finally { await coordinator.close(); }
});
