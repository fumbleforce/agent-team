import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { startCoordinator } from '../server.ts';

// A minimal identity provider: discovery, keys, and a token endpoint that signs an ID token for whoever "signed in".
async function identityProvider(person: { sub: string; email: string; name: string; email_verified?: boolean }) {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  let issuer = '', nonce = '';
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', issuer);
    const json = (body: unknown) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(body)); };
    if (url.pathname === '/.well-known/openid-configuration') return json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'] });
    if (url.pathname === '/jwks') return json({ keys: [jwk] });
    if (url.pathname === '/token') {
      void new SignJWT({ ...person, nonce }).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(issuer).setAudience('agent-team').setSubject(person.sub).setIssuedAt().setExpirationTime('5m').sign(privateKey)
        .then(idToken => json({ access_token: 'at', token_type: 'Bearer', id_token: idToken }));
      return;
    }
    response.statusCode = 404; response.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { issuer, remember: (value: string) => { nonce = value; }, close: () => new Promise(resolve => server.close(resolve)) };
}

async function boot(person: Parameters<typeof identityProvider>[0], allowedDomains: string[] = []) {
  const idp = await identityProvider(person);
  const coordinator = await startCoordinator({ port: 0, storage: { kind: 'sqlite', path: ':memory:' }, machineToken: 'x'.repeat(24), webRoot: null, trackers: null });
  await coordinator.context.storage.db.insertInto('org').values({ id: 'org', name: 'Acme', accent: 'amber', currency: 'EUR', created_at: 1, settings: JSON.stringify({ oidc: { issuer: idp.issuer, clientId: 'agent-team', allowedDomains, defaultRole: 'member', allowInsecure: true } }) }).execute();
  const signIn = async () => {
    const start = await fetch(`${coordinator.url}/api/auth/oidc/start`, { redirect: 'manual' });
    const authorize = new URL(start.headers.get('location')!);
    idp.remember(authorize.searchParams.get('nonce')!);
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
    return fetch(`${coordinator.url}/api/auth/oidc/callback?code=abc&state=${authorize.searchParams.get('state')}`, { redirect: 'manual' });
  };
  return { coordinator, idp, signIn, close: async () => { await coordinator.close(); await idp.close(); } };
}

test('a new person signs in through the provider, joins with the default role, and is recognized by identity next time', async () => {
  const { coordinator, signIn, close } = await boot({ sub: 'u-1', email: 'Ida@Acme.example', name: 'Ida' }, ['acme.example']);
  assert.deepEqual(await (await fetch(`${coordinator.url}/api/auth/oidc`)).json(), { enabled: true });
  const first = await signIn();
  assert.equal(first.status, 302);
  const cookie = first.headers.get('set-cookie')!.split(';')[0]!;
  const me = await (await fetch(`${coordinator.url}/api/me`, { headers: { cookie } })).json() as { user: { email: string; orgRole: string } };
  assert.deepEqual([me.user.email, me.user.orgRole], ['ida@acme.example', 'member']);
  assert.equal((await signIn()).status, 302);
  assert.equal((await coordinator.context.storage.db.selectFrom('users').select('id').execute()).length, 1);
  await close();
});

test('a foreign domain, an unverified email and a replayed state are refused', async () => {
  const foreign = await boot({ sub: 'u-2', email: 'eve@evil.example', name: 'Eve' }, ['acme.example']);
  assert.equal((await foreign.signIn()).status, 403);
  await foreign.close();

  const unverified = await boot({ sub: 'u-3', email: 'ida@acme.example', name: 'Ida', email_verified: false });
  assert.equal((await unverified.signIn()).status, 401);
  assert.equal((await fetch(`${unverified.coordinator.url}/api/auth/oidc/callback?code=abc&state=made-up`, { redirect: 'manual' })).status, 400);
  await unverified.close();
});
