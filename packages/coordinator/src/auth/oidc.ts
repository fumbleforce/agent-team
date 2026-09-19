import * as client from 'openid-client';
import { newId, OidcSettings } from '@agent-team/protocol';
import { HttpError, type Context } from '../context.ts';

export { OidcSettings };
const FLOW_MS = 10 * 60_000;

// Authorization code with PKCE. An identity is the issuer and subject; email is only used to find or name the account.
export function createOidc(context: Context, env: NodeJS.ProcessEnv = process.env) {
  const { storage, events, now } = context;
  const db = storage.db;
  const flows = new Map<string, { verifier: string; nonce: string; redirectUri: string; at: number }>();
  let cached: { key: string; config: client.Configuration } | null = null;

  async function settings(): Promise<OidcSettings | null> {
    const org = await db.selectFrom('org').select('settings').executeTakeFirst();
    const parsed = OidcSettings.safeParse((JSON.parse(org?.settings ?? '{}') as { oidc?: unknown }).oidc);
    return parsed.success ? parsed.data : null;
  }

  async function configuration(oidc: OidcSettings) {
    const key = JSON.stringify(oidc);
    if (cached?.key === key) return cached.config;
    const secret = env[oidc.clientSecretEnv];
    const config = await client.discovery(new URL(oidc.issuer), oidc.clientId, secret, undefined, oidc.allowInsecure ? { execute: [client.allowInsecureRequests] } : undefined);
    cached = { key, config };
    return config;
  }

  return {
    enabled: async () => (await settings()) !== null,

    async start(redirectUri: string): Promise<string> {
      const oidc = await settings();
      if (!oidc) throw new HttpError(404, 'oidc', 'Single sign-on is not configured');
      for (const [state, flow] of flows) if (flow.at + FLOW_MS < now()) flows.delete(state);
      const verifier = client.randomPKCECodeVerifier(), state = client.randomState(), nonce = client.randomNonce();
      flows.set(state, { verifier, nonce, redirectUri, at: now() });
      const url = client.buildAuthorizationUrl(await configuration(oidc), { redirect_uri: redirectUri, scope: 'openid email profile', code_challenge: await client.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256', state, nonce });
      return url.href;
    },

    // Returns the user to sign in. A known identity signs in; a known email is linked; a new person joins with the default role if their domain is allowed.
    async finish(callbackUrl: URL): Promise<string> {
      const oidc = await settings();
      const state = callbackUrl.searchParams.get('state') ?? '';
      const flow = flows.get(state);
      flows.delete(state);
      if (!oidc || !flow || flow.at + FLOW_MS < now()) throw new HttpError(400, 'oidc', 'This sign-in attempt expired; start again');
      const tokens = await client.authorizationCodeGrant(await configuration(oidc), callbackUrl, { pkceCodeVerifier: flow.verifier, expectedState: state, expectedNonce: flow.nonce }).catch(() => { throw new HttpError(401, 'oidc', 'The identity provider did not confirm the sign-in'); });
      const claims = tokens.claims();
      const email = typeof claims?.email === 'string' ? claims.email.toLowerCase() : null;
      if (!claims?.sub || !email || claims.email_verified === false) throw new HttpError(401, 'oidc', 'The identity provider returned no verified email');
      if (oidc.allowedDomains.length && !oidc.allowedDomains.some(domain => domain.toLowerCase() === (email.split('@')[1] ?? ''))) throw new HttpError(403, 'oidc', 'This email domain is not allowed here');

      const issuer = String(claims.iss), subject = claims.sub;
      const result = await storage.transaction(async tx => {
        const known = await tx.selectFrom('identities').select('user_id').where('issuer', '=', issuer).where('subject', '=', subject).executeTakeFirst();
        if (known) return { userId: known.user_id, published: [] };
        const byEmail = await tx.selectFrom('users').select(['id', 'status']).where('email', '=', email).executeTakeFirst();
        const userId = byEmail?.id ?? newId(now());
        if (!byEmail) await tx.insertInto('users').values({ id: userId, email, name: typeof claims.name === 'string' ? claims.name.slice(0, 80) : email, password_hash: null, org_role: oidc.defaultRole, status: 'active', created_at: now(), last_login_at: now() }).execute();
        await tx.insertInto('identities').values({ user_id: userId, issuer, subject }).execute();
        return { userId, published: await events.append(tx, [{ type: byEmail ? 'auth.identity_linked' : 'member.joined', category: 'audit', actorKind: 'user', userId, payload: { issuer } }]) };
      });
      events.published(result.published);
      const user = await db.selectFrom('users').select('status').where('id', '=', result.userId).executeTakeFirstOrThrow();
      if (user.status !== 'active') throw new HttpError(403, 'oidc', 'This account is disabled');
      return result.userId;
    },
  };
}
