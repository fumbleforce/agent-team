import { z } from 'zod';
import { newId } from '@agent-team/protocol';
import { HttpError, notFound, type Context } from '../context.ts';
import type { Turns } from '../runtime/turns.ts';

export const CATEGORIES = ['issue-boards', 'code', 'comms', 'storage', 'ai-workspaces', 'media', 'business', 'other'] as const;
export const ConnectionBody = z.object({
  kind: z.string().regex(/^[a-z][a-z0-9-]{0,40}$/), name: z.string().min(1).max(60), category: z.enum(CATEGORIES), mode: z.string().max(40).default('read'),
  // The name of the environment variable or secret that holds the credential on the workers, never its value.
  credentialRef: z.string().regex(/^[A-Z][A-Z0-9_]{0,80}$/).nullish(), config: z.record(z.string(), z.union([z.string().max(400), z.number(), z.boolean()])).default({}),
});
export const HandoffBody = z.object({ source: z.string().min(1).max(40), title: z.string().min(1).max(200), summary: z.string().max(4000).default(''), context: z.record(z.string(), z.unknown()).default({}), attachmentId: z.string().nullish() });

// Connections describe what the team may reach; handoffs bring in work done elsewhere together with its context.
export function createIntegrations(context: Context, turns: Turns) {
  const { storage, events, now } = context;
  const db = storage.db;

  return {
    async connections(projectId: string) {
      const rows = await db.selectFrom('connections').selectAll().where(eb => eb.or([eb('project_id', '=', projectId), eb('project_id', 'is', null)])).orderBy('category').orderBy('name').execute();
      return rows.map(row => ({ id: row.id, kind: row.kind, name: row.name, category: row.category, mode: row.mode, status: row.status, statusDetail: row.status_detail, credentialRef: row.credential_ref, config: JSON.parse(row.config) as Record<string, unknown>, lastSyncAt: row.last_sync_at === null ? null : Number(row.last_sync_at) }));
    },

    async connect(userId: string, projectId: string, input: z.infer<typeof ConnectionBody>) {
      const id = newId(now());
      const published = await storage.transaction(async tx => {
        await tx.insertInto('connections').values({ id, project_id: projectId, kind: input.kind, name: input.name, category: input.category, mode: input.mode, config: JSON.stringify(input.config), status: input.credentialRef ? 'connected' : 'warning', status_detail: input.credentialRef ? null : 'No credential named yet', credential_ref: input.credentialRef ?? null, last_sync_at: null, created_at: now() }).execute();
        return events.append(tx, [{ type: 'connection.added', category: 'audit', actorKind: 'user', userId, projectId, payload: { kind: input.kind, name: input.name } }]);
      });
      events.published(published);
      return id;
    },

    async handoffs(projectId: string) {
      const rows = await db.selectFrom('handoffs').selectAll().where('project_id', '=', projectId).orderBy('created_at', 'desc').limit(50).execute();
      return rows.map(row => ({ id: row.id, direction: row.direction, source: row.source, title: row.title, summary: row.summary, attachmentId: row.attachment_id, targetTaskId: row.target_task_id, state: row.state, pickedByAgentId: row.picked_by_agent_id, createdAt: Number(row.created_at) }));
    },

    async receive(userId: string | null, projectId: string, input: z.infer<typeof HandoffBody>) {
      const id = newId(now());
      const published = await storage.transaction(async tx => {
        await tx.insertInto('handoffs').values({ id, project_id: projectId, direction: 'in', source: input.source, title: input.title, summary: input.summary, context: JSON.stringify(input.context), attachment_id: input.attachmentId ?? null, target_task_id: null, state: 'new', picked_by_agent_id: null, created_by: userId, created_at: now() }).execute();
        return events.append(tx, [{ type: 'handoff.received', actorKind: userId ? 'user' : 'system', userId, projectId, payload: { handoffId: id, source: input.source } }]);
      });
      events.published(published);
      return id;
    },

    // Handing it to the team posts it in the discussion with its context and asks the PM to place it.
    async handToTeam(userId: string, handoffId: string, pm: string | null, discussionThreadId: string | null) {
      const handoff = await db.selectFrom('handoffs').selectAll().where('id', '=', handoffId).executeTakeFirst();
      if (!handoff) throw notFound('Handoff');
      if (handoff.state !== 'new') throw new HttpError(409, 'handoff', `This handoff is already ${handoff.state}`);
      if (!discussionThreadId) throw new HttpError(409, 'handoff', 'The project has no discussion to hand it to');
      const published = await storage.transaction(async tx => {
        await tx.updateTable('handoffs').set({ state: 'handed' }).where('id', '=', handoffId).execute();
        await tx.insertInto('messages').values({ id: newId(now()), thread_id: discussionThreadId, author_kind: 'user', author_id: userId, kind: 'handoff', body: `Handoff from ${handoff.source}: ${handoff.title}\n\n${handoff.summary}`, payload: JSON.stringify({ handoffId, ...(handoff.attachment_id ? { attachmentId: handoff.attachment_id } : {}) }), created_at: now() }).execute();
        return events.append(tx, [{ type: 'message.posted', actorKind: 'user', userId, projectId: handoff.project_id, threadId: discussionThreadId, payload: { kind: 'handoff' } }, { type: 'handoff.handed', actorKind: 'user', userId, projectId: handoff.project_id, payload: { handoffId } }]);
      });
      events.published(published);
      if (pm) await turns.enqueue({ agentId: pm, projectId: handoff.project_id, kind: 'triage', threadId: discussionThreadId, dedupeKey: `triage:${discussionThreadId}` });
    },
  };
}
