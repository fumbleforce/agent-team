import { newId, type OrgRole, type ProjectRole } from '@agent-team/protocol';
import type { z } from 'zod';
import type { AcceptInviteBody, InviteBody, SetupBody } from '@agent-team/protocol';
import type { Tx } from '@agent-team/storage';
import { forbidden, HttpError, type Context, type LocalOwner } from '../context.ts';
import { createLoginLimiter, loginSubjects } from './rateLimit.ts';
import type { Viewer } from './rbac.ts';
import { hashPassword, hashToken, newToken, verifyPassword } from './secrets.ts';

const SESSION_MS = 30 * 24 * 3600_000;
const SETUP_MS = 30 * 60_000;
const INVITE_MS = 7 * 24 * 3600_000;

export interface Accounts {
  setupLink(): Promise<string | null>;
  setup(input: z.infer<typeof SetupBody>): Promise<string>;
  login(email: string, password: string, source: string): Promise<string>;
  // For sign-ins another module has already verified, such as single sign-on.
  sessionFor(userId: string, method?: string): Promise<string>;
  // The email a loopback identity proxy vouches for: a known active account signs in, a pending invitation is accepted, anyone else is refused.
  trustedSession(email: string): Promise<string | null>;
  // The owner of a coordinator that is only for the person at this machine: the one there is, or one made now without a password.
  localOwner(input: LocalOwner): Promise<string>;
  logout(sessionToken: string): Promise<void>;
  viewer(sessionToken: string | undefined): Promise<Viewer | null>;
  invite(by: Viewer, input: z.infer<typeof InviteBody>): Promise<string>;
  acceptInvite(token: string, input: z.infer<typeof AcceptInviteBody>): Promise<string>;
}

export function createAccounts(context: Context): Accounts {
  const { storage, events, now } = context;
  const limiter = createLoginLimiter(context);

  async function openSession(userId: string): Promise<string> {
    const token = newToken();
    await storage.db.insertInto('sessions').values({ id: newId(now()), user_id: userId, token_hash: hashToken(token), created_at: now(), expires_at: now() + SESSION_MS, last_seen_at: now(), revoked_at: null }).execute();
    return token;
  }

  // Accepting an invitation: the account, its project grants and the event, in the caller's transaction.
  async function join(tx: Tx, invite: { id: string; email: string; org_role: string; project_grants: string }, userId: string, name: string, passwordHash: string | null) {
    await tx.updateTable('invites').set({ accepted_at: now() }).where('id', '=', invite.id).execute();
    await tx.insertInto('users').values({ id: userId, email: invite.email, name, password_hash: passwordHash, org_role: invite.org_role, status: 'active', created_at: now(), last_login_at: now() }).execute();
    for (const grant of JSON.parse(invite.project_grants) as { projectId: string; role: string }[]) await tx.insertInto('project_members').values({ project_id: grant.projectId, user_id: userId, role: grant.role }).execute();
    return events.append(tx, [{ type: 'member.joined', category: 'audit', actorKind: 'user', userId, payload: { orgRole: invite.org_role } }]);
  }

  return {
    // Only an organization without an owner can be set up.
    async setupLink() {
      if (await storage.db.selectFrom('users').select('id').where('org_role', '=', 'owner').executeTakeFirst()) return null;
      const token = newToken();
      await storage.db.insertInto('setup_tokens').values({ token_hash: hashToken(token), expires_at: now() + SETUP_MS, used_at: null }).execute();
      return `/setup?token=${token}`;
    },

    async setup(input) {
      const userId = newId(now());
      const published = await storage.transaction(async tx => {
        const row = await tx.selectFrom('setup_tokens').selectAll().where('token_hash', '=', hashToken(input.token)).executeTakeFirst();
        if (!row || row.used_at !== null || Number(row.expires_at) < now()) throw new HttpError(403, 'setup_token', 'This setup link is no longer valid');
        if (await tx.selectFrom('users').select('id').where('org_role', '=', 'owner').executeTakeFirst()) throw new HttpError(409, 'already_setup', 'This organization already has an owner');
        await tx.updateTable('setup_tokens').set({ used_at: now() }).where('token_hash', '=', row.token_hash).execute();
        await tx.deleteFrom('org').execute();
        await tx.insertInto('org').values({ id: newId(now()), name: input.orgName, accent: 'amber', currency: 'EUR', settings: '{}', created_at: now() }).execute();
        await tx.insertInto('users').values({ id: userId, email: input.email.toLowerCase(), name: input.name, password_hash: await hashPassword(input.password), org_role: 'owner', status: 'active', created_at: now(), last_login_at: now() }).execute();
        return events.append(tx, [{ type: 'auth.owner_created', category: 'audit', actorKind: 'user', userId }]);
      });
      events.published(published);
      return openSession(userId);
    },

    async login(email, password, source) {
      const subjects = loginSubjects(source, email);
      await limiter.check(subjects);
      const user = await storage.db.selectFrom('users').selectAll().where('email', '=', email.toLowerCase()).executeTakeFirst();
      // Verify against something even when the account is unknown, so timing does not reveal it.
      const ok = await verifyPassword(password, user?.password_hash ?? 'scrypt$AAAAAAAAAAAAAAAAAAAAAA$AA');
      if (!user || !ok || user.status !== 'active') {
        const locked = await limiter.fail(subjects);
        const published = await storage.transaction(tx => events.append(tx, [
          { type: 'auth.login_failed', category: 'audit', actorKind: 'user', userId: user?.id ?? null, payload: { email: email.toLowerCase(), source } },
          ...locked.map(subject => ({ type: 'auth.locked', category: 'audit' as const, actorKind: 'system' as const, userId: subject.startsWith('account:') ? (user?.id ?? null) : null, payload: { subject } })),
        ]));
        events.published(published);
        throw new HttpError(401, 'credentials', 'Email or password is wrong');
      }
      await limiter.clear(subjects[1]!);
      return this.sessionFor(user.id, 'password');
    },

    async sessionFor(userId, method = 'sso') {
      const published = await storage.transaction(async tx => {
        await tx.updateTable('users').set({ last_login_at: now() }).where('id', '=', userId).execute();
        return events.append(tx, [{ type: 'auth.signed_in', category: 'audit', actorKind: 'user', userId, payload: { method } }]);
      });
      events.published(published);
      return openSession(userId);
    },

    async trustedSession(email) {
      const address = email.trim().toLowerCase();
      const user = await storage.db.selectFrom('users').select(['id', 'status']).where('email', '=', address).executeTakeFirst();
      if (user) return user.status === 'active' ? this.sessionFor(user.id, 'trusted_header') : null;
      const joined = await storage.transaction(async tx => {
        const invite = (await tx.selectFrom('invites').selectAll().where('email', '=', address).where('accepted_at', 'is', null).where('expires_at', '>', now()).orderBy('expires_at', 'desc').executeTakeFirst()) ?? null;
        if (!invite) return null;
        const userId = newId(now());
        return { userId, published: await join(tx, invite, userId, address.split('@')[0] ?? address, null) };
      });
      if (!joined) return null;
      events.published(joined.published);
      return this.sessionFor(joined.userId, 'trusted_header');
    },

    async localOwner(input) {
      const existing = await storage.db.selectFrom('users').select('id').where('org_role', '=', 'owner').where('status', '=', 'active').orderBy('created_at').executeTakeFirst();
      if (existing) return existing.id;
      const userId = newId(now());
      const published = await storage.transaction(async tx => {
        if (await tx.selectFrom('users').select('id').where('org_role', '=', 'owner').executeTakeFirst()) return null;
        // A row left from before anyone owned the organization is kept, with its settings, and takes the new name.
        const org = await tx.selectFrom('org').select(['id']).executeTakeFirst();
        if (org) await tx.updateTable('org').set({ name: input.orgName }).where('id', '=', org.id).execute();
        else await tx.insertInto('org').values({ id: newId(now()), name: input.orgName, accent: 'amber', currency: 'EUR', settings: '{}', created_at: now() }).execute();
        await tx.insertInto('users').values({ id: userId, email: input.email.toLowerCase(), name: input.name, password_hash: null, org_role: 'owner', status: 'active', created_at: now(), last_login_at: now() }).execute();
        return events.append(tx, [{ type: 'auth.owner_created', category: 'audit', actorKind: 'user', userId, payload: { method: 'local' } }]);
      });
      if (published) { events.published(published); return userId; }
      return (await storage.db.selectFrom('users').select('id').where('org_role', '=', 'owner').orderBy('created_at').executeTakeFirstOrThrow()).id;
    },

    async logout(sessionToken) {
      const published = await storage.transaction(async tx => {
        const session = await tx.selectFrom('sessions').select(['id', 'user_id']).where('token_hash', '=', hashToken(sessionToken)).where('revoked_at', 'is', null).executeTakeFirst();
        if (!session) return [];
        await tx.updateTable('sessions').set({ revoked_at: now() }).where('id', '=', session.id).execute();
        return events.append(tx, [{ type: 'auth.signed_out', category: 'audit', actorKind: 'user', userId: session.user_id }]);
      });
      events.published(published);
    },

    async viewer(sessionToken) {
      if (!sessionToken) return null;
      const session = await storage.db.selectFrom('sessions').innerJoin('users', 'users.id', 'sessions.user_id')
        .select(['sessions.id as sessionId', 'sessions.expires_at', 'sessions.revoked_at', 'users.id as userId', 'users.org_role', 'users.status'])
        .where('sessions.token_hash', '=', hashToken(sessionToken)).executeTakeFirst();
      if (!session || session.revoked_at !== null || Number(session.expires_at) < now() || session.status !== 'active') return null;
      await storage.db.updateTable('sessions').set({ last_seen_at: now(), expires_at: now() + SESSION_MS }).where('id', '=', session.sessionId).execute();
      const grants = await storage.db.selectFrom('project_members').select(['project_id', 'role']).where('user_id', '=', session.userId).execute();
      return { userId: session.userId, orgRole: session.org_role as OrgRole, projects: new Map(grants.map(grant => [grant.project_id, grant.role as ProjectRole])) };
    },

    async invite(by, input) {
      // Only the owner makes admins.
      if (input.orgRole === 'admin' && by.orgRole !== 'owner') throw forbidden();
      const token = newToken();
      const published = await storage.transaction(async tx => {
        if (await tx.selectFrom('users').select('id').where('email', '=', input.email.toLowerCase()).executeTakeFirst()) throw new HttpError(409, 'member_exists', 'Someone with this email is already a member');
        await tx.insertInto('invites').values({ id: newId(now()), email: input.email.toLowerCase(), org_role: input.orgRole, project_grants: JSON.stringify(input.projects), token_hash: hashToken(token), invited_by: by.userId, expires_at: now() + INVITE_MS, accepted_at: null }).execute();
        return events.append(tx, [{ type: 'member.invited', category: 'audit', actorKind: 'user', userId: by.userId, payload: { email: input.email, orgRole: input.orgRole } }]);
      });
      events.published(published);
      return `/invite/${token}`;
    },

    async acceptInvite(token, input) {
      const userId = newId(now());
      const published = await storage.transaction(async tx => {
        const invite = await tx.selectFrom('invites').selectAll().where('token_hash', '=', hashToken(token)).executeTakeFirst();
        if (!invite || invite.accepted_at !== null || Number(invite.expires_at) < now()) throw new HttpError(403, 'invite', 'This invitation is no longer valid');
        return join(tx, invite, userId, input.name, await hashPassword(input.password));
      });
      events.published(published);
      return openSession(userId);
    },
  };
}
