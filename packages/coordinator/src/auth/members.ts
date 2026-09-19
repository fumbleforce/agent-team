import type { z } from 'zod';
import type { ProjectMemberBody, UserPatch } from '@agent-team/protocol';
import { forbidden, HttpError, notFound, type Context } from '../context.ts';
import type { Viewer } from './rbac.ts';

// Who belongs to the organization and to each project. Every change is an audit event by the person who made it.
export function createMembers(context: Context) {
  const { storage, events, now } = context;
  const db = storage.db;

  return {
    async list() {
      const users = await db.selectFrom('users').select(['id', 'email', 'name', 'org_role', 'status', 'password_hash', 'created_at', 'last_login_at']).orderBy('created_at').execute();
      const grants = await db.selectFrom('project_members').innerJoin('projects', 'projects.id', 'project_members.project_id').select(['project_members.user_id', 'project_members.role', 'projects.id as project_id', 'projects.slug', 'projects.name']).execute();
      const linked = new Set((await db.selectFrom('identities').select('user_id').execute()).map(row => row.user_id));
      const invites = await db.selectFrom('invites').leftJoin('users', 'users.id', 'invites.invited_by').select(['invites.id', 'invites.email', 'invites.org_role', 'invites.project_grants', 'invites.expires_at', 'users.name as invited_by']).where('invites.accepted_at', 'is', null).where('invites.expires_at', '>', now()).orderBy('invites.expires_at').execute();
      return {
        users: users.map(user => ({ id: user.id, email: user.email, name: user.name, orgRole: user.org_role, status: user.status, signIn: [...(user.password_hash ? ['password'] : []), ...(linked.has(user.id) ? ['sso'] : [])], createdAt: Number(user.created_at), lastLoginAt: user.last_login_at === null ? null : Number(user.last_login_at), projects: grants.filter(grant => grant.user_id === user.id).map(grant => ({ projectId: grant.project_id, slug: grant.slug, name: grant.name, role: grant.role })) })),
        invites: invites.map(invite => ({ id: invite.id, email: invite.email, orgRole: invite.org_role, projects: JSON.parse(invite.project_grants) as { projectId: string; role: string }[], expiresAt: Number(invite.expires_at), invitedBy: invite.invited_by })),
      };
    },

    // Admins manage members and viewers; only the owner touches admins and owners. Nobody changes their own account here, so an organization always keeps an owner.
    async patch(by: Viewer, userId: string, input: z.infer<typeof UserPatch>) {
      if (userId === by.userId) throw new HttpError(409, 'self', 'Ask another administrator to change your own account');
      const published = await storage.transaction(async tx => {
        const user = await tx.selectFrom('users').select(['org_role', 'status', 'email']).where('id', '=', userId).executeTakeFirst();
        if (!user) throw notFound('User');
        const elevated = (role: string | undefined) => role === 'owner' || role === 'admin';
        if (by.orgRole !== 'owner' && (elevated(user.org_role) || elevated(input.orgRole))) throw forbidden();
        const drafts = [];
        if (input.orgRole && input.orgRole !== user.org_role) {
          await tx.updateTable('users').set({ org_role: input.orgRole }).where('id', '=', userId).execute();
          drafts.push({ type: 'member.role_changed', category: 'audit' as const, actorKind: 'user' as const, userId: by.userId, payload: { target: userId, email: user.email, from: user.org_role, to: input.orgRole } });
        }
        if (input.status && input.status !== user.status) {
          await tx.updateTable('users').set({ status: input.status }).where('id', '=', userId).execute();
          // A disabled account loses its sessions at once.
          if (input.status === 'disabled') await tx.updateTable('sessions').set({ revoked_at: now() }).where('user_id', '=', userId).where('revoked_at', 'is', null).execute();
          drafts.push({ type: input.status === 'disabled' ? 'member.disabled' : 'member.enabled', category: 'audit' as const, actorKind: 'user' as const, userId: by.userId, payload: { target: userId, email: user.email } });
        }
        return drafts.length ? events.append(tx, drafts) : [];
      });
      events.published(published);
    },

    async revokeInvite(by: Viewer, inviteId: string) {
      const published = await storage.transaction(async tx => {
        const invite = await tx.selectFrom('invites').select(['email', 'accepted_at']).where('id', '=', inviteId).executeTakeFirst();
        if (!invite || invite.accepted_at !== null) throw notFound('Invitation');
        await tx.updateTable('invites').set({ expires_at: now() }).where('id', '=', inviteId).execute();
        return events.append(tx, [{ type: 'member.invite_revoked', category: 'audit', actorKind: 'user', userId: by.userId, payload: { email: invite.email } }]);
      });
      events.published(published);
    },

    async ofProject(projectId: string) {
      const members = await db.selectFrom('project_members').innerJoin('users', 'users.id', 'project_members.user_id').select(['users.id', 'users.name', 'users.email', 'users.org_role', 'project_members.role']).where('project_members.project_id', '=', projectId).orderBy('users.name').execute();
      const everyone = await db.selectFrom('users').select(['id', 'name', 'email', 'org_role']).where('status', '=', 'active').orderBy('name').execute();
      const taken = new Set(members.map(member => member.id));
      return {
        members: members.map(member => ({ id: member.id, name: member.name, email: member.email, orgRole: member.org_role, role: member.role })),
        // Owners and admins already administer every project, so they are not offered a grant.
        candidates: everyone.filter(user => !taken.has(user.id) && user.org_role !== 'owner' && user.org_role !== 'admin').map(user => ({ id: user.id, name: user.name, email: user.email })),
      };
    },

    // A null role removes the grant.
    async grant(by: Viewer, projectId: string, input: z.infer<typeof ProjectMemberBody>) {
      const published = await storage.transaction(async tx => {
        const user = await tx.selectFrom('users').select('email').where('id', '=', input.userId).executeTakeFirst();
        if (!user) throw notFound('User');
        await tx.deleteFrom('project_members').where('project_id', '=', projectId).where('user_id', '=', input.userId).execute();
        if (input.role) await tx.insertInto('project_members').values({ project_id: projectId, user_id: input.userId, role: input.role }).execute();
        return events.append(tx, [{ type: input.role ? 'member.granted' : 'member.removed', category: 'audit', actorKind: 'user', userId: by.userId, projectId, payload: { target: input.userId, email: user.email, role: input.role } }]);
      });
      events.published(published);
    },
  };
}
export type Members = ReturnType<typeof createMembers>;
