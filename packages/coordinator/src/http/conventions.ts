import { createHash } from 'node:crypto';
import type { Context as Hc, ErrorHandler, MiddlewareHandler, NotFoundHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ExpressionBuilder } from 'kysely';
import { z } from 'zod';
import type { Schema } from '@agent-team/storage';
import { PageQuery } from '@agent-team/protocol';
import { HttpError, type Context } from '../context.ts';

// The API conventions of docs/SPEC.md section 7 in one place: the error shape, request bodies, cursors, If-Match and Idempotency-Key.

// Every failure answers {error: {code, message, fields?}}.
export const onError: ErrorHandler = (error, c) => {
  if (error instanceof HttpError) return c.json({ error: { code: error.code, message: error.message, ...(error.fields ? { fields: error.fields } : {}) } }, error.status as 400);
  if (error instanceof HTTPException) return c.json({ error: { code: error.status === 400 ? 'invalid' : 'http', message: error.message || 'Request refused' } }, error.status);
  console.error(error);
  return c.json({ error: { code: 'internal', message: 'Internal error' } }, 500);
};
export const onNotFound: NotFoundHandler = c => c.json({ error: { code: 'not_found', message: 'Not found' } }, 404);

// A refused body names each field that was wrong, so a form can show the message next to it.
export function invalid(error: z.ZodError): HttpError {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) fields[issue.path.join('.') || '_'] ??= issue.message;
  return new HttpError(400, 'invalid', z.prettifyError(error), fields);
}
export async function parseBody<T extends z.ZodType>(c: Hc, schema: T): Promise<z.infer<T>> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw invalid(parsed.error);
  return parsed.data;
}

// Who is asking, for sign-in throttling. A forwarded address is believed only from a proxy on this machine; anyone else could write the header themselves.
export function clientAddress(c: Hc): string {
  const remote = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress ?? 'local';
  const local = remote === 'local' || remote === '::1' || remote.startsWith('127.') || remote.startsWith('::ffff:127.');
  return (local ? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() : undefined) || remote;
}

// A request from a browser on this machine to this machine by its loopback name: the socket is loopback (a proxy's forwarded address is not
// looked at), the Host header names loopback, so a page on another name that resolves here is refused, and the browser does not call it cross-site.
export function fromThisMachine(c: Hc): boolean {
  const remote = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress ?? 'local';
  const socket = remote === 'local' || remote === '::1' || remote.startsWith('127.') || remote.startsWith('::ffff:127.');
  const host = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/.test(c.req.header('host') ?? '');
  const site = c.req.header('sec-fetch-site');
  return socket && host && (site === undefined || site === 'same-origin' || site === 'none');
}

// `?after=&limit=`: the cursor is whatever the list's `next` last returned.
export function pageOf(c: Hc): PageQuery {
  const parsed = PageQuery.safeParse({ after: c.req.query('after') || undefined, limit: c.req.query('limit') || undefined });
  if (!parsed.success) throw invalid(parsed.error);
  return parsed.data;
}
// `If-Match: <version>` on a versioned document; quoted and weak forms are accepted. Absent means "whatever is current".
export function ifMatch(c: Hc): number | undefined {
  const header = c.req.header('if-match');
  if (header === undefined || header.trim() === '*') return undefined;
  const version = /^(?:W\/)?"?(\d{1,9})"?$/.exec(header.trim())?.[1];
  if (version === undefined) throw new HttpError(400, 'invalid', 'If-Match carries the document version you last read', { 'if-match': 'Expected a version number' });
  return Number(version);
}
// The document store reports a lost race as "stale"; when the client sent the precondition, HTTP calls that 412.
export async function preconditioned<T>(expected: number | undefined, write: () => Promise<T>): Promise<T> {
  try { return await write(); } catch (error) {
    if (expected !== undefined && error instanceof HttpError && error.code === 'stale') throw new HttpError(412, 'precondition_failed', error.message);
    throw error;
  }
}

const KEY_MS = 24 * 3600_000;
// A claim whose request never finished (the process died) stops blocking the key after this long.
const PENDING_MS = 2 * 60_000;
const MAX_STORED = 256 * 1024;

// `Idempotency-Key` on a POST: the same key from the same person answers with the first response instead of creating again.
// Mount after the middleware that sets the viewer. A key reused for a different request is refused; a request still running answers 409.
export function idempotency(context: Context): MiddlewareHandler<{ Variables: { viewer: { userId: string } } }> {
  const { storage, now } = context;
  return async (c, next) => {
    const key = c.req.header('idempotency-key');
    const viewer = c.get('viewer') as { userId: string } | undefined;
    if (c.req.method !== 'POST' || key === undefined || !viewer) return next();
    if (key.length < 8 || key.length > 200) throw new HttpError(400, 'invalid', 'Idempotency-Key is 8 to 200 characters', { 'idempotency-key': 'Use 8 to 200 characters' });
    const fingerprint = createHash('sha256').update(`${c.req.path}\n`).update(new Uint8Array(await c.req.raw.clone().arrayBuffer())).digest('hex');
    const mine = (eb: ExpressionBuilder<Schema, 'idempotency_keys'>) => eb.and([eb('user_id', '=', viewer.userId), eb('key', '=', key)]);

    // Claiming the key and finding an earlier claim happen in one transaction, so two racing requests cannot both run.
    const prior = await storage.transaction(async tx => {
      await tx.deleteFrom('idempotency_keys').where('expires_at', '<', now()).execute();
      const row = await tx.selectFrom('idempotency_keys').select(['fingerprint', 'status', 'response']).where(mine).executeTakeFirst();
      if (!row) await tx.insertInto('idempotency_keys').values({ user_id: viewer.userId, key, fingerprint, status: 0, response: null, created_at: now(), expires_at: now() + PENDING_MS }).execute();
      return row ?? null;
    }).catch(async error => {
      // Two first requests at the same instant: the loser of the insert sees the winner's row.
      const row = await storage.db.selectFrom('idempotency_keys').select(['fingerprint', 'status', 'response']).where(mine).executeTakeFirst();
      if (!row) throw error;
      return row;
    });
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new HttpError(422, 'idempotency_mismatch', 'This Idempotency-Key was used for a different request');
      if (prior.status === 0 || prior.response === null) throw new HttpError(409, 'in_progress', 'The first request with this Idempotency-Key is still running');
      return c.body(prior.response, prior.status as 200, { 'content-type': 'application/json', 'idempotent-replayed': 'true' });
    }

    await next();
    const status = c.res.status;
    const text = status >= 200 && status < 300 && (c.res.headers.get('content-type') ?? '').includes('json') ? await c.res.clone().text() : null;
    // Only a success is remembered: a refusal or a failure frees the key, so the client may correct the request and try again.
    if (text === null || text.length > MAX_STORED) await storage.db.deleteFrom('idempotency_keys').where(mine).execute();
    else await storage.db.updateTable('idempotency_keys').set({ status, response: text, expires_at: now() + KEY_MS }).where(mine).execute();
  };
}
