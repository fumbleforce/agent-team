import type { Context } from '../context.ts';

// How far each poll of an outside system got, and whether it is failing. The scope is the project (or connection) polled.
// The error kept is the adapter's own short text; adapters never put a response body or a credential in it.
export function createCursors(context: Context) {
  const { storage, now } = context;
  const db = storage.db;

  async function write(scopeId: string, resource: string, values: { cursor?: string | null; last_ok_at?: number; error: string | null; failing_since: number | null }) {
    const existing = await db.selectFrom('sync_cursors').select(['cursor', 'failing_since']).where('scope_id', '=', scopeId).where('resource', '=', resource).executeTakeFirst();
    // "Failing since" is the first failure of the streak, not the latest.
    const failingSince = values.error === null ? null : existing?.failing_since ?? values.failing_since;
    if (existing) await db.updateTable('sync_cursors').set({ ...(values.cursor !== undefined ? { cursor: values.cursor } : {}), ...(values.last_ok_at !== undefined ? { last_ok_at: values.last_ok_at } : {}), error: values.error, failing_since: failingSince }).where('scope_id', '=', scopeId).where('resource', '=', resource).execute();
    else await db.insertInto('sync_cursors').values({ scope_id: scopeId, resource, cursor: values.cursor ?? null, last_ok_at: values.last_ok_at ?? null, error: values.error, failing_since: failingSince }).execute();
  }

  return {
    async cursor(scopeId: string, resource: string): Promise<string | null> {
      return (await db.selectFrom('sync_cursors').select('cursor').where('scope_id', '=', scopeId).where('resource', '=', resource).executeTakeFirst())?.cursor ?? null;
    },
    ok: (scopeId: string, resource: string, cursor?: string | null) => write(scopeId, resource, { ...(cursor !== undefined ? { cursor } : {}), last_ok_at: now(), error: null, failing_since: null }),
    fail: (scopeId: string, resource: string, error: unknown, cursor?: string | null) => write(scopeId, resource, { ...(cursor !== undefined ? { cursor } : {}), error: (error instanceof Error ? error.message : 'Sync failed').slice(0, 300), failing_since: now() }),
    // What the integrations page shows: last synced, or failing since.
    async status(scopeId: string) {
      const rows = await db.selectFrom('sync_cursors').select(['resource', 'last_ok_at', 'error', 'failing_since']).where('scope_id', '=', scopeId).orderBy('resource').execute();
      return rows.map(row => ({ resource: row.resource, lastOkAt: row.last_ok_at === null ? null : Number(row.last_ok_at), error: row.error, failingSince: row.failing_since === null ? null : Number(row.failing_since) }));
    },
  };
}
export type Cursors = ReturnType<typeof createCursors>;
