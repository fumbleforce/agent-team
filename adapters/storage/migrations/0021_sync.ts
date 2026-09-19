import type { Kysely } from 'kysely';
import type { MigrationContext } from '../contract.ts';

// Where a local entity lives in another system, and how far each poll of that system got.
export async function up(db: Kysely<unknown>, _context: MigrationContext): Promise<void> {
  const s = db.schema;
  // One row per entity and system: a task, issue, message or page with its identifier, link and last seen version over there.
  await s.createTable('external_refs').addColumn('entity_type', 'text', c => c.notNull()).addColumn('entity_id', 'text', c => c.notNull()).addColumn('system', 'text', c => c.notNull())
    .addColumn('external_id', 'text', c => c.notNull()).addColumn('url', 'text').addColumn('synced_at', 'bigint', c => c.notNull()).addColumn('remote_version', 'text')
    .addPrimaryKeyConstraint('external_refs_pk', ['entity_type', 'entity_id', 'system']).execute();
  await s.createIndex('external_refs_external').on('external_refs').columns(['system', 'external_id']).execute();
  // `scope_id` is the connection or project a poll belongs to. The error is the adapter's own short text, never a response body.
  await s.createTable('sync_cursors').addColumn('scope_id', 'text', c => c.notNull()).addColumn('resource', 'text', c => c.notNull()).addColumn('cursor', 'text')
    .addColumn('last_ok_at', 'bigint').addColumn('error', 'text').addColumn('failing_since', 'bigint')
    .addPrimaryKeyConstraint('sync_cursors_pk', ['scope_id', 'resource']).execute();
}
