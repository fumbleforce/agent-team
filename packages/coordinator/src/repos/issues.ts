import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import { newId, type CreateIssueBody } from '@agent-team/protocol';
import type { Tx } from '@agent-team/storage';
import { HttpError, notFound, type Context } from '../context.ts';
import { indexIssue } from '../knowledge/indexing.ts';
import { taskFromIssue, teamIdOf } from './issueTasks.ts';

const IMAGE = /^image\/(png|jpeg|webp|gif)$/;
const MAX_BYTES = 8 * 1024 * 1024;

// Issues are what a human raises: each has its own thread, and the PM triages it. Attachments are content-addressed files.
export function createIssues(context: Context, blobDir: string) {
  const { storage, events, now } = context;
  const db = storage.db;

  return {
    async attach(userId: string | null, input: { name: string; mime: string; bytes: Uint8Array }, executor: Tx | typeof db = db) {
      if (!IMAGE.test(input.mime)) throw new HttpError(415, 'attachment', 'Only PNG, JPEG, WebP and GIF images can be attached');
      if (input.bytes.length === 0 || input.bytes.length > MAX_BYTES) throw new HttpError(413, 'attachment', 'An attachment is at most 8 MB');
      const sha256 = createHash('sha256').update(input.bytes).digest('hex');
      const existing = await executor.selectFrom('attachments').select('id').where('sha256', '=', sha256).executeTakeFirst();
      if (existing) return existing.id;
      mkdirSync(blobDir, { recursive: true, mode: 0o700 });
      writeFileSync(path.join(blobDir, sha256), input.bytes, { mode: 0o600 });
      const id = newId(now());
      await executor.insertInto('attachments').values({ id, sha256, bytes: input.bytes.length, mime: input.mime, name: input.name.slice(0, 120), storage_kind: 'local', storage_key: sha256, created_by: userId, created_at: now() }).execute();
      return id;
    },

    async attachment(id: string) {
      const row = await db.selectFrom('attachments').selectAll().where('id', '=', id).executeTakeFirst();
      if (!row) throw notFound('Attachment');
      // The key is a hash the server computed, never a name a client chose.
      return { mime: row.mime, data: readFileSync(path.join(blobDir, row.storage_key)) };
    },

    // Raised by a person, or by an agent from its turn: then there is no user and the source says so.
    async create(userId: string | null, projectId: string, input: z.infer<typeof CreateIssueBody>, agentId: string | null = null) {
      const id = newId(now()), threadId = newId(now()), messageId = newId(now());
      const result = await storage.transaction(async tx => {
        const last = await tx.selectFrom('issues').select(eb => eb.fn.max('number').as('n')).where('project_id', '=', projectId).executeTakeFirst();
        const number = Number(last?.n ?? 0) + 1;
        await tx.insertInto('threads').values({ id: threadId, project_id: projectId, kind: 'issue', subject_type: 'issue', subject_id: id, title: input.title, visibility: 'team', owner_user_id: null, created_at: now() }).execute();
        await tx.insertInto('issues').values({ id, project_id: projectId, number, title: input.title, body: input.body, state: 'open', priority: 'normal', source: agentId ? 'agent' : input.source, owner_agent_id: null, author_user_id: userId, thread_id: threadId, attachment_id: input.attachmentId ?? null, created_at: now(), closed_at: null }).execute();
        // The first message of the thread is the issue body again, so the issue alone stands for both in search.
        await indexIssue(storage, tx, { id, projectId, number, title: input.title, body: input.body, threadId });
        await tx.insertInto('messages').values({ id: messageId, thread_id: threadId, author_kind: agentId ? 'agent' : 'user', author_id: agentId ?? userId, kind: 'note', body: input.body, payload: JSON.stringify({ ...(input.attachmentId ? { attachmentId: input.attachmentId } : {}), ...(input.markers.length ? { markers: input.markers } : {}), ...(input.environment ? { environment: input.environment } : {}) }), created_at: now() }).execute();
        return { number, published: await events.append(tx, [{ type: 'issue.created', actorKind: agentId ? 'agent' : 'user', userId, agentId, projectId, threadId, payload: { issueId: id, number } }]) };
      });
      events.published(result.published);
      // The first message is the issue body; whoever it names with @ is mentioned on that message.
      return { id, number: result.number, threadId, messageId };
    },

    // Newest first; `after` is the number of the last issue already seen.
    async list(projectId: string, page: { after?: number | undefined; limit?: number } = {}) {
      const rows = await db.selectFrom('issues').select(['id', 'number', 'title', 'state', 'priority', 'source', 'owner_agent_id', 'thread_id', 'attachment_id', 'created_at']).where('project_id', '=', projectId).$if(page.after !== undefined, query => query.where('number', '<', page.after!)).orderBy('number', 'desc').limit(page.limit ?? 200).execute();
      if (rows.length === 0) return [];
      // What became of each: the task it turned into, and whether someone is about to answer or answering right now.
      const tasks = await db.selectFrom('links').innerJoin('tasks', 'tasks.id', 'links.to_id').select(['links.from_id', 'tasks.key', 'tasks.state', 'tasks.assignee_agent_id']).where('links.from_type', '=', 'issue').where('links.to_type', '=', 'task').where('links.rel', '=', 'fixes').where('links.from_id', 'in', rows.map(row => row.id)).execute();
      const live = await db.selectFrom('work_items').select(['thread_id', 'agent_id', 'state']).where('project_id', '=', projectId).where('state', 'in', ['queued', 'leased']).where('thread_id', 'in', rows.map(row => row.thread_id)).execute();
      return rows.map(row => {
        const task = tasks.find(item => item.from_id === row.id), item = live.find(other => other.thread_id === row.thread_id);
        return { ...row, task: task ? { key: task.key, state: task.state, assigneeAgentId: task.assignee_agent_id } : null, pending: item ? { agentId: item.agent_id, running: item.state === 'leased' } : null };
      });
    },

    // A person makes the call themselves: the issue becomes a task for the teammate they name, and that teammate starts on it.
    async accept(userId: string, projectId: string, number: number, agentId: string) {
      const issue = await this.get(projectId, number);
      const teamId = await storage.transaction(tx => teamIdOf(tx, projectId));
      const owner = teamId ? await db.selectFrom('agents').select(['id', 'name']).where('id', '=', agentId).where('team_id', '=', teamId).where('status', '=', 'active').executeTakeFirst() : null;
      if (!owner) throw new HttpError(400, 'invalid', 'Pick someone on this project\'s team', { agentId: 'Pick someone on this project\'s team' });
      const result = await storage.transaction(async tx => {
        const made = await taskFromIssue(tx, { issue, ownerId: owner.id, authorAgentId: null, actor: { actorKind: 'user', userId }, now: now() });
        if (!made.taskId) throw new HttpError(409, 'conflict', 'This issue already has a task');
        await tx.updateTable('issues').set({ owner_agent_id: owner.id }).where('id', '=', issue.id).execute();
        return { taskId: made.taskId, published: await events.append(tx, made.events) };
      });
      events.published(result.published);
      return { taskId: result.taskId, ownerId: owner.id };
    },

    async get(projectId: string, number: number) {
      const issue = await db.selectFrom('issues').selectAll().where('project_id', '=', projectId).where('number', '=', number).executeTakeFirst();
      if (!issue) throw notFound('Issue');
      return issue;
    },

    async close(userId: string, projectId: string, number: number) {
      const issue = await this.get(projectId, number);
      const published = await storage.transaction(async tx => {
        await tx.updateTable('issues').set({ state: 'closed', closed_at: now() }).where('id', '=', issue.id).execute();
        return events.append(tx, [{ type: 'issue.closed', actorKind: 'user', userId, projectId, threadId: issue.thread_id, payload: { issueId: issue.id } }]);
      });
      events.published(published);
    },
  };
}
export type Issues = ReturnType<typeof createIssues>;
