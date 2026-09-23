import type { Kysely } from 'kysely';
import type { MigrationContext } from '../contract.ts';

// Telling the owner: each thing on Needs you by its key, when it was first seen, when the owner was told and reminded, and when it went.
export async function up(db: Kysely<unknown>, _context: MigrationContext): Promise<void> {
  await db.schema.createTable('notifications').addColumn('key', 'text', c => c.primaryKey()).addColumn('project_id', 'text').addColumn('title', 'text', c => c.notNull())
    .addColumn('first_seen_at', 'bigint', c => c.notNull()).addColumn('notified_at', 'bigint').addColumn('reminded_at', 'bigint').addColumn('resolved_at', 'bigint').execute();
  await db.schema.createIndex('notifications_open').on('notifications').columns(['resolved_at', 'first_seen_at']).execute();
}
