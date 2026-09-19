import { newId, type OrgRole, type ProjectRole } from '@agent-team/protocol';
import type { z } from 'zod';
import type { AcceptInviteBody, InviteBody, SetupBody } from '@agent-team/protocol';
import { HttpError, type Context } from '../context.ts';
import type { Viewer } from './rbac.ts';
import { hashPassword, hashToken, newToken, verifyPassword } from './secrets.ts';

const SESSION_MS = 30 * 24 * 3600_000;
const SETUP_MS = 30 * 60_000;
const INVITE_MS = 7 * 24 * 3600_000;
const MAX_FAILURES = 8;
const LOCK_MS = 15 * 60_000;

export interface Accounts {
  setupLink(): Promise<string | null>;
  setup(input: z.infer<typeof SetupBody>): Promise<string>;
  login(email: string, password: string, source: string): Promise<string>;
  // For sign-ins another module has already verified, such as single sign-on.
  sessionFor(userId: string): Promise<string>;
  logout(sessionToken: string): Promise<void>;
  viewer(sessionToken: string | undefined): Promise<Viewer | null>;
  invite(by: Viewer, input: z.infer<typeof InviteBody>): Promise<string>;
  acceptInvite(token: string, input: z.infer<typeof AcceptInviteBody>): Promise<string>;
}

export function createAccounts(context: Context): Accounts {
  const { storage, events, now } = context;
  const failures = new Map<string, { count: number; until: number }>();

  async function openSession(userId: string): Promise<string> {
    const token = newToken();
    await storage.db.insertInto('sessions').values({ id: newId(now()), user_id: userId, token_hash: hashToken(token), created_at: now(), expires_at: now() + SESSION_MS, last_seen_at: now(), revoked_at: null }).execute();
    return token;
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
      const key = `${source}|${email.toLowerCase()}`;
      const failed = failures.get(key);
      if (failed && failed.count >= MAX_FAILURES && failed.until > now()) throw new HttpError(429, 'locked', 'Too many attempts; try again later');
      const user = await storage.db.selectFrom('users').selectAll().where('email', '=', email.toLowerCase()).executeTakeFirst();
      // Verify against something even when the account is unknown, so timing does not reveal it.
      const ok = await verifyPassword(password, user?.password_hash ?? 'scrypt$AAAAAAAAAAAAAAAAAAAAAA$AA');
      if (!user || !ok || user.status !== 'active') {
        failures.set(key, { count: (failed?.count ?? 0) + 1, until: now() + LOCK_MS });
        throw new HttpError(401, 'credentials', 'Email or password is wrong');
      }
      failures.delete(key);
      await storage.db.updateTable('users').set({ last_login_at: now() }).where('id', '=', user.id).execute();
      return openSession(user.id);
    },

    async sessionFor(userId) {
      await storage.db.updateTable('users').set({ last_login_at: now() }).where('id', '=', userId).execute();
      return openSession(userId);
    },

    async logout(sessionToken) {
      await storage.db.updateTable('sessions').set({ revoked_at: now() }).where('token_hash', '=', hashToken(sessionToken)).execute();
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
      const token = newToken();
      const published = await storage.transaction(async tx => {
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
        await tx.updateTable('invites').set({ accepted_at: now() }).where('id', '=', invite.id).execute();
        await tx.insertInto('users').values({ id: userId, email: invite.email, name: input.name, password_hash: await hashPassword(input.password), org_role: invite.org_role, status: 'active', created_at: now(), last_login_at: now() }).execute();
        for (const grant of JSON.parse(invite.project_grants) as { projectId: string; role: string }[]) await tx.insertInto('project_members').values({ project_id: grant.projectId, user_id: userId, role: grant.role }).execute();
        return events.append(tx, [{ type: 'member.joined', category: 'audit', actorKind: 'user', userId }]);
      });
      events.published(published);
      return openSession(userId);
    },
  };
}
