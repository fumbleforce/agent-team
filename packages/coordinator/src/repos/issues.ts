import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import { newId, type CreateIssueBody } from '@agent-team/protocol';
import { HttpError, notFound, type Context } from '../context.ts';

const IMAGE = /^image\/(png|jpeg|webp|gif)$/;
const MAX_BYTES = 8 * 1024 * 1024;

// Issues are what a human raises: each has its own thread, and the PM triages it. Attachments are content-addressed files.
export function createIssues(context: Context, blobDir: string) {
  const { storage, events, now } = context;
  const db = storage.db;

  return {
    async attach(userId: string, input: { name: string; mime: string; bytes: Uint8Array }) {
      if (!IMAGE.test(input.mime)) throw new HttpError(415, 'attachment', 'Only PNG, JPEG, WebP and GIF images can be attached');
      if (input.bytes.length === 0 || input.bytes.length > MAX_BYTES) throw new HttpError(413, 'attachment', 'An attachment is at most 8 MB');
      const sha256 = createHash('sha256').update(input.bytes).digest('hex');
      const existing = await db.selectFrom('attachments').select('id').where('sha256', '=', sha256).executeTakeFirst();
      if (existing) return existing.id;
      mkdirSync(blobDir, { recursive: true, mode: 0o700 });
      writeFileSync(path.join(blobDir, sha256), input.bytes, { mode: 0o600 });
      const id = newId(now());
      await db.insertInto('attachments').values({ id, sha256, bytes: input.bytes.length, mime: input.mime, name: input.name.slice(0, 120), storage_kind: 'local', storage_key: sha256, created_by: userId, created_at: now() }).execute();
      return id;
    },

    async attachment(id: string) {
      const row = await db.selectFrom('attachments').selectAll().where('id', '=', id).executeTakeFirst();
      if (!row) throw notFound('Attachment');
      // The key is a hash the server computed, never a name a client chose.
      return { mime: row.mime, data: readFileSync(path.join(blobDir, row.storage_key)) };
    },

    async create(userId: string, projectId: string, input: z.infer<typeof CreateIssueBody>) {
      const id = newId(now()), threadId = newId(now());
      const result = await storage.transaction(async tx => {
        const last = await tx.selectFrom('issues').select(eb => eb.fn.max('number').as('n')).where('project_id', '=', projectId).executeTakeFirst();
        const number = Number(last?.n ?? 0) + 1;
        await tx.insertInto('threads').values({ id: threadId, project_id: projectId, kind: 'issue', subject_type: 'issue', subject_id: id, title: input.title, visibility: 'team', owner_user_id: null, created_at: now() }).execute();
        await tx.insertInto('issues').values({ id, project_id: projectId, number, title: input.title, body: input.body, state: 'open', priority: 'normal', source: input.source, owner_agent_id: null, author_user_id: userId, thread_id: threadId, attachment_id: input.attachmentId ?? null, created_at: now(), closed_at: null }).execute();
        await tx.insertInto('messages').values({ id: newId(now()), thread_id: threadId, author_kind: 'user', author_id: userId, kind: 'note', body: input.body, payload: JSON.stringify({ ...(input.attachmentId ? { attachmentId: input.attachmentId } : {}), ...(input.markers.length ? { markers: input.markers } : {}), ...(input.environment ? { environment: input.environment } : {}) }), created_at: now() }).execute();
        return { number, published: await events.append(tx, [{ type: 'issue.created', actorKind: 'user', userId, projectId, threadId, payload: { issueId: id, number } }]) };
      });
      events.published(result.published);
      return { id, number: result.number, threadId };
    },

    async list(projectId: string) {
      return db.selectFrom('issues').select(['id', 'number', 'title', 'state', 'priority', 'source', 'owner_agent_id', 'thread_id', 'attachment_id', 'created_at']).where('project_id', '=', projectId).orderBy('number', 'desc').limit(200).execute();
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
