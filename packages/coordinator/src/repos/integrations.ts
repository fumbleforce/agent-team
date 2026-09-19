import { z } from 'zod';
import { newId } from '@agent-team/protocol';
import { HttpError, notFound, type Context } from '../context.ts';
import type { Turns } from '../runtime/turns.ts';
import { indexMessage } from '../knowledge/indexing.ts';

export const CATEGORIES = ['issue-boards', 'code', 'comms', 'storage', 'ai-workspaces', 'media', 'business', 'other'] as const;
export const ConnectionBody = z.object({
  kind: z.string().regex(/^[a-z][a-z0-9-]{0,40}$/), name: z.string().min(1).max(60), category: z.enum(CATEGORIES), mode: z.string().max(40).default('read'),
  // The name of the environment variable or secret that holds the credential on the workers, never its value.
  credentialRef: z.string().regex(/^[A-Z][A-Z0-9_]{0,80}$/).nullish(), config: z.record(z.string(), z.union([z.string().max(400), z.number(), z.boolean()])).default({}),
});
export const AttachHandoffBody = z.object({ taskId: z.string().min(1).max(80) });
export const HandoffResultBody = z.object({ result: z.string().trim().min(1).max(4000) });
export const HandoffBody = z.object({ source: z.string().min(1).max(40), title: z.string().min(1).max(200), summary: z.string().max(4000).default(''), context: z.record(z.string(), z.unknown()).default({}), attachmentId: z.string().nullish() });

// Connections describe what the team may reach; handoffs bring in work done elsewhere together with its context.
export function createIntegrations(context: Context, turns: Turns) {
  const { storage, events, now } = context;
  const db = storage.db;

  return {
    async connections(projectId: string) {
      const rows = await db.selectFrom('connections').selectAll().where(eb => eb.or([eb('project_id', '=', projectId), eb('project_id', 'is', null)])).orderBy('category').orderBy('name').execute();
      return rows.map(row => ({ projectScoped: row.project_id !== null, id: row.id, kind: row.kind, name: row.name, category: row.category, mode: row.mode, status: row.status, statusDetail: row.status_detail, credentialRef: row.credential_ref, config: JSON.parse(row.config) as Record<string, unknown>, lastSyncAt: row.last_sync_at === null ? null : Number(row.last_sync_at) }));
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

    // Guided setup: a project has one tracker and one code host, and one connection per name, so setting one up again replaces it.
    async replace(userId: string, projectId: string, exclusive: string | null, input: { kind: string; name: string; category: string; mode: string; credentialRef: string | null; config: Record<string, string>; waiting: string | null; connected: boolean }) {
      const id = newId(now());
      const published = await storage.transaction(async tx => {
        const existing = await tx.selectFrom('connections').select(['id', 'kind', 'name', 'config']).where('project_id', '=', projectId).execute();
        const stale = existing.filter(row => (exclusive ? (JSON.parse(row.config) as { target?: string }).target === exclusive : row.kind === input.kind && row.name === input.name)).map(row => row.id);
        if (stale.length) await tx.deleteFrom('connections').where('id', 'in', stale).execute();
        await tx.insertInto('connections').values({ id, project_id: projectId, kind: input.kind, name: input.name, category: input.category, mode: input.mode, config: JSON.stringify(input.config), status: input.connected ? 'connected' : 'warning', status_detail: input.waiting, credential_ref: input.credentialRef, last_sync_at: null, created_at: now() }).execute();
        return events.append(tx, [{ type: 'connection.added', category: 'audit', actorKind: 'user', userId, projectId, payload: { kind: input.kind, name: input.name } }]);
      });
      events.published(published);
      return id;
    },

    async disconnect(userId: string, projectId: string, connectionId: string) {
      const published = await storage.transaction(async tx => {
        const row = await tx.selectFrom('connections').select(['kind', 'name', 'config']).where('id', '=', connectionId).where('project_id', '=', projectId).executeTakeFirst();
        if (!row) throw new HttpError(404, 'not_found', 'Connection not found');
        await tx.deleteFrom('connections').where('id', '=', connectionId).execute();
        // A tracker or code host set up in the app is also what the project's manifest points at.
        const target = (JSON.parse(row.config) as { target?: string }).target;
        if (target === 'tracker' || target === 'scm') {
          const project = await tx.selectFrom('projects').select('manifest').where('id', '=', projectId).executeTakeFirstOrThrow();
          const manifest = JSON.parse(project.manifest) as Record<string, unknown>;
          delete manifest[target];
          await tx.updateTable('projects').set({ manifest: JSON.stringify(manifest) }).where('id', '=', projectId).execute();
        }
        return events.append(tx, [{ type: 'connection.removed', category: 'audit', actorKind: 'user', userId, projectId, payload: { kind: row.kind, name: row.name } }]);
      });
      events.published(published);
    },

    async handoffs(projectId: string) {
      const rows = await db.selectFrom('handoffs').selectAll().where('project_id', '=', projectId).orderBy('created_at', 'desc').limit(50).execute();
      const taskIds = rows.flatMap(row => (row.target_type === 'task' && row.target_id ? [row.target_id] : []));
      const tasks = new Map((taskIds.length ? await db.selectFrom('tasks').select(['id', 'key', 'title']).where('id', 'in', taskIds).execute() : []).map(task => [task.id, task]));
      return rows.map(row => {
        const task = row.target_type === 'task' && row.target_id ? tasks.get(row.target_id) : undefined;
        const result = (JSON.parse(row.context) as { result?: unknown }).result;
        // The target says where it went: the team's discussion, or one task, named the way the board names it.
        return { id: row.id, direction: row.direction, source: row.source, title: row.title, summary: row.summary, attachmentId: row.attachment_id, target: row.target_type ? { type: row.target_type, id: row.target_id, key: task?.key ?? null, title: task?.title ?? null } : null, result: typeof result === 'string' ? result : null, state: row.state, pickedByAgentId: row.picked_by_agent_id, createdAt: Number(row.created_at) };
      });
    },

    async receive(userId: string | null, projectId: string, input: z.infer<typeof HandoffBody>) {
      const id = newId(now());
      const published = await storage.transaction(async tx => {
        await tx.insertInto('handoffs').values({ id, project_id: projectId, direction: 'in', source: input.source, title: input.title, summary: input.summary, context: JSON.stringify(input.context), attachment_id: input.attachmentId ?? null, target_task_id: null, target_type: null, target_id: null, state: 'new', picked_by_agent_id: null, created_by: userId, created_at: now() }).execute();
        return events.append(tx, [{ type: 'handoff.received', actorKind: userId ? 'user' : 'system', userId, projectId, payload: { handoffId: id, source: input.source } }]);
      });
      events.published(published);
      return id;
    },

    // Outbound: an agent records what it hands to someone outside the team. `source` names the other side in both directions.
    async send(agentId: string, projectId: string, input: { destination: string; title: string; summary: string; context: Record<string, unknown>; taskId?: string | undefined }) {
      const id = newId(now());
      const published = await storage.transaction(async tx => {
        await tx.insertInto('handoffs').values({ id, project_id: projectId, direction: 'out', source: input.destination, title: input.title, summary: input.summary, context: JSON.stringify(input.context), attachment_id: null, target_task_id: input.taskId ?? null, target_type: input.taskId ? 'task' : null, target_id: input.taskId ?? null, state: 'outbox', picked_by_agent_id: agentId, created_by: null, created_at: now() }).execute();
        return events.append(tx, [{ type: 'handoff.sent', actorKind: 'agent', agentId, projectId, taskId: input.taskId ?? null, payload: { handoffId: id, destination: input.destination } }]);
      });
      events.published(published);
      return id;
    },

    // Handing it to the team posts it in the discussion with its context and asks the PM to place it.
    async handToTeam(userId: string, projectId: string, handoffId: string, pm: string | null, discussionThreadId: string | null) {
      const handoff = await db.selectFrom('handoffs').selectAll().where('id', '=', handoffId).where('project_id', '=', projectId).executeTakeFirst();
      if (!handoff) throw notFound('Handoff');
      if (handoff.state !== 'new') throw new HttpError(409, 'handoff', `This handoff is already ${handoff.state}`);
      if (!discussionThreadId) throw new HttpError(409, 'handoff', 'The project has no discussion to hand it to');
      const published = await storage.transaction(async tx => {
        await tx.updateTable('handoffs').set({ state: 'handed', target_type: 'team', target_id: null }).where('id', '=', handoffId).execute();
        const messageId = newId(now()), text = `Handoff from ${handoff.source}: ${handoff.title}\n\n${handoff.summary}`;
        await tx.insertInto('messages').values({ id: messageId, thread_id: discussionThreadId, author_kind: 'user', author_id: userId, kind: 'handoff', body: text, payload: JSON.stringify({ handoffId, ...(handoff.attachment_id ? { attachmentId: handoff.attachment_id } : {}) }), created_at: now() }).execute();
        await indexMessage(storage, tx, { id: messageId, threadId: discussionThreadId, body: text });
        return events.append(tx, [{ type: 'message.posted', actorKind: 'user', userId, projectId: handoff.project_id, threadId: discussionThreadId, payload: { kind: 'handoff' } }, { type: 'handoff.handed', actorKind: 'user', userId, projectId: handoff.project_id, payload: { handoffId } }]);
      });
      events.published(published);
      if (pm) await turns.enqueue({ agentId: pm, projectId: handoff.project_id, kind: 'triage', threadId: discussionThreadId, dedupeKey: `triage:${discussionThreadId}` });
    },

    // Attaching it to a task puts its context in front of whoever works on that task, and wakes them if someone does.
    async attachToTask(userId: string, projectId: string, handoffId: string, taskId: string) {
      const result = await storage.transaction(async tx => {
        const handoff = await tx.selectFrom('handoffs').select(['id', 'state', 'direction']).where('id', '=', handoffId).where('project_id', '=', projectId).executeTakeFirst();
        if (!handoff) throw notFound('Handoff');
        if (handoff.direction !== 'in' || handoff.state !== 'new') throw new HttpError(409, 'handoff', `This handoff is already ${handoff.state}`);
        // It goes to a task of this project or of one of its sub-projects.
        const task = await tx.selectFrom('tasks').innerJoin('projects', 'projects.id', 'tasks.project_id').select(['tasks.id', 'tasks.project_id', 'tasks.assignee_agent_id', 'tasks.state']).where('tasks.id', '=', taskId).where(eb => eb.or([eb('projects.id', '=', projectId), eb('projects.parent_id', '=', projectId)])).executeTakeFirst();
        if (!task) throw new HttpError(404, 'not_found', 'That task is not part of this project');
        await tx.updateTable('handoffs').set({ state: 'attached', target_type: 'task', target_id: task.id, target_task_id: task.id }).where('id', '=', handoffId).execute();
        await tx.insertInto('links').values({ from_type: 'handoff', from_id: handoffId, to_type: 'task', to_id: task.id, rel: 'relates', created_at: now() }).onConflict(oc => oc.columns(['from_type', 'from_id', 'to_type', 'to_id', 'rel']).doNothing()).execute();
        return { task, published: await events.append(tx, [{ type: 'handoff.attached', actorKind: 'user', userId, projectId, taskId: task.id, payload: { handoffId } }]) };
      });
      events.published(result.published);
      const { task } = result;
      if (task.assignee_agent_id && !['done', 'canceled', 'stopped'].includes(task.state)) await turns.enqueue({ agentId: task.assignee_agent_id, projectId: task.project_id, kind: 'work', taskId: task.id, dedupeKey: `work:${task.id}` });
    },

    // What came back from the other side of an outbound handoff, written down by a person; until then it shows as waiting.
    async recordResult(userId: string, projectId: string, handoffId: string, text: string) {
      const published = await storage.transaction(async tx => {
        const handoff = await tx.selectFrom('handoffs').select(['state', 'direction', 'context', 'target_id', 'target_type']).where('id', '=', handoffId).where('project_id', '=', projectId).executeTakeFirst();
        if (!handoff) throw notFound('Handoff');
        if (handoff.direction !== 'out' || handoff.state !== 'outbox') throw new HttpError(409, 'handoff', 'Only an outbound handoff that is still waiting takes a result');
        await tx.updateTable('handoffs').set({ state: 'returned', context: JSON.stringify({ ...(JSON.parse(handoff.context) as Record<string, unknown>), result: text }) }).where('id', '=', handoffId).execute();
        return events.append(tx, [{ type: 'handoff.returned', actorKind: 'user', userId, projectId, taskId: handoff.target_type === 'task' ? handoff.target_id : null, payload: { handoffId } }]);
      });
      events.published(published);
    },
  };
}
export type Integrations = ReturnType<typeof createIntegrations>;
