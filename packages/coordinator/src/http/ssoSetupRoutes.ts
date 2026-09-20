import type { Context as Hc, Hono } from 'hono';
import { z } from 'zod';
import { IDENTITY_CATALOG, identityEntry, SECRET_VARIABLE, type IdentityEntry } from '../../../../adapters/identity/catalog.ts';
import { createAuthSettings } from '../auth/authSettings.ts';
import { can, type Viewer } from '../auth/rbac.ts';
import { forbidden, HttpError, type Context } from '../context.ts';
import { parseBody } from './conventions.ts';

type Env = { Variables: { viewer: Viewer } };
type Values = Record<string, string>;
const Entered = { kind: z.string().max(40), clientSecret: z.string().trim().min(4).max(2000).regex(/^\S+$/, 'That does not look like a client secret').optional(), values: z.record(z.string().max(40), z.string().max(400)).default({}) };
// Without a kind the check is of what is already set up.
const TestBody = z.object({ ...Entered, kind: Entered.kind.optional() });
const SetupBody = z.object({ ...Entered, allowedDomains: z.string().max(400).default(''), defaultRole: z.enum(['viewer', 'member']).default('viewer') });
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
interface Deps { context: Context; callbackUri(c: Hc): string; env?: NodeJS.ProcessEnv; fetch?: typeof fetch }

// Guided setup of single sign-on. The words and the way a sign-in address is derived come from the identity catalog;
// this file validates what was entered, asks the address whether it is a sign-in service, and saves through the same
// code as the sign-in settings. Admins read; only the owner checks, sets up and turns off.
export function mountSsoSetupRoutes(app: Hono<any>, deps: Deps) {
  const env = deps.env ?? deps.context.env, request = deps.fetch ?? deps.context.fetch, has = (variable: string) => Boolean(env[variable]) || deps.context.secrets.has(variable), settings = createAuthSettings(deps.context);
  const viewer = (c: Hc<Env>) => c.get('viewer');
  const owner = (c: Hc<Env>) => { if (!can(viewer(c), 'org.settings')) throw forbidden(); };

  function checked(input: { kind: string; values: Values }): { entry: IdentityEntry; values: Values; issuer: string; insecure: boolean } {
    const entry = identityEntry(input.kind);
    if (!entry) throw new HttpError(404, 'not_found', 'That sign-in product is not supported');
    const values: Values = {}, fields: Values = {};
    for (const field of entry.fields) {
      const value = (input.values[field.key] ?? '').trim();
      if (!value) { if (field.required) fields[field.key] = `${field.label} is needed`; continue; }
      if (field.pattern && !new RegExp(`^(?:${field.pattern})$`).test(value)) { fields[field.key] = `${field.label} does not look right${field.placeholder ? `; it should look like ${field.placeholder}` : ''}`; continue; }
      values[field.key] = value;
    }
    if (Object.keys(fields).length) throw new HttpError(400, 'invalid', 'Some fields need another look', fields);
    const issuer = entry.issuer(values), address = URL.canParse(issuer) ? new URL(issuer) : null;
    const blame = (message: string) => new HttpError(400, 'invalid', 'Some fields need another look', { [entry.addressField ?? 'clientId']: message });
    if (!address) throw blame('That is not an address');
    // A sign-in over plain HTTP can be read on the way; it is only for a service on this machine.
    const insecure = address.protocol === 'http:';
    if (insecure && !LOOPBACK.has(address.hostname)) throw blame('Use an address that starts with https://. Plain http:// is only accepted for a service on this machine.');
    return { entry, values, issuer, insecure };
  }

  function domainsOf(text: string): string[] {
    const domains = text.split(/[\s,;]+/).map(item => item.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
    const odd = domains.find(domain => !DOMAIN.test(domain));
    if (odd) throw new HttpError(400, 'invalid', 'Some fields need another look', { allowedDomains: `"${odd}" does not look like an email domain; write it like example.com` });
    return [...new Set(domains)];
  }

  // OpenID discovery: the address must answer with a document that names itself as that address. Nothing of the answer is passed on.
  async function discover(issuer: string): Promise<'found' | 'silent' | 'other-name'> {
    const plain = (address: string) => address.replace(/\/+$/, '');
    try {
      const response = await request(`${plain(issuer)}/.well-known/openid-configuration`, { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(8000) });
      if (!response.ok) return 'silent';
      const document = await response.json() as { issuer?: unknown; authorization_endpoint?: unknown; token_endpoint?: unknown };
      if (typeof document.issuer !== 'string' || typeof document.authorization_endpoint !== 'string' || typeof document.token_endpoint !== 'string') return 'silent';
      return plain(document.issuer) === plain(issuer) ? 'found' : 'other-name';
    } catch { return 'silent'; }
  }

  const titleOf = (entry: IdentityEntry, issuer: string) => (entry.addressField === 'issuer' && URL.canParse(issuer) ? new URL(issuer).host : entry.title);
  const generic = () => identityEntry('oidc') ?? IDENTITY_CATALOG.at(-1)!;

  app.get('/api/settings/sso/catalog', async c => {
    if (!can(viewer(c), 'org.members')) throw forbidden();
    const saved = await settings.oidc();
    const entry = saved ? identityEntry(saved.provider ?? '') ?? generic() : null;
    return c.json({
      entries: IDENTITY_CATALOG.map(({ issuer, found, notFound, addressField, ...rest }) => rest),
      redirectUri: deps.callbackUri(c), secret: { variable: SECRET_VARIABLE, present: has(SECRET_VARIABLE) }, canEdit: can(viewer(c), 'org.settings'),
      current: saved && entry ? { kind: entry.kind, title: titleOf(entry, saved.issuer), allowedDomains: saved.allowedDomains, defaultRole: saved.defaultRole, secret: { variable: saved.clientSecretEnv, present: has(saved.clientSecretEnv) } } : null,
    });
  });

  app.post('/api/settings/sso/test', async c => {
    owner(c);
    const input = await parseBody(c, TestBody), saved = input.kind === undefined ? await settings.oidc() : null;
    if (input.kind === undefined && !saved) throw new HttpError(404, 'not_found', 'Single sign-on is not set up');
    const { entry, issuer } = saved ? { entry: identityEntry(saved.provider ?? '') ?? generic(), issuer: saved.issuer } : checked({ kind: input.kind!, values: input.values });
    const variable = saved?.clientSecretEnv ?? SECRET_VARIABLE, outcome = await discover(issuer);
    const checks = [
      outcome === 'found' ? { ok: true, message: entry.found } : { ok: false, message: outcome === 'silent' ? entry.notFound : 'A sign-in service answers there, but it goes by another address. Copy the address exactly as the product shows it.' },
      has(variable) || input.clientSecret ? { ok: true, message: 'The client secret is here.' } : { ok: false, message: 'Paste the client secret.' },
    ];
    return c.json({ ok: checks.every(check => check.ok), checks });
  });

  app.post('/api/settings/sso/setup', async c => {
    owner(c);
    const input = await parseBody(c, SetupBody);
    const { entry, values, issuer, insecure } = checked(input);
    if (input.clientSecret) await deps.context.secrets.set(SECRET_VARIABLE, input.clientSecret, viewer(c).userId);
    await settings.save(viewer(c).userId, { oidc: { issuer, clientId: values.clientId!, clientSecretEnv: SECRET_VARIABLE, allowedDomains: domainsOf(input.allowedDomains), defaultRole: input.defaultRole, allowInsecure: insecure, provider: entry.kind } });
    return c.json({ ok: true, secretPresent: has(SECRET_VARIABLE) });
  });

  app.post('/api/settings/sso/off', async c => { owner(c); await settings.save(viewer(c).userId, { oidc: null }); return c.json({ ok: true }); });
}
