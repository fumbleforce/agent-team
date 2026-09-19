import type { Kysely } from 'kysely';
import type { MigrationContext } from '../contract.ts';

export async function up(db: Kysely<unknown>, _context: MigrationContext): Promise<void> {
  const s = db.schema;
  // A connection names where its credential lives; the value itself is never stored here.
  await s.createTable('connections').addColumn('id', 'text', c => c.primaryKey()).addColumn('project_id', 'text', c => c.references('projects.id').onDelete('cascade'))
    .addColumn('kind', 'text', c => c.notNull()).addColumn('name', 'text', c => c.notNull()).addColumn('category', 'text', c => c.notNull()).addColumn('mode', 'text', c => c.notNull())
    .addColumn('config', 'text', c => c.notNull()).addColumn('status', 'text', c => c.notNull()).addColumn('status_detail', 'text').addColumn('credential_ref', 'text')
    .addColumn('last_sync_at', 'bigint').addColumn('created_at', 'bigint', c => c.notNull()).execute();
  await s.createTable('handoffs').addColumn('id', 'text', c => c.primaryKey()).addColumn('project_id', 'text', c => c.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('direction', 'text', c => c.notNull()).addColumn('source', 'text', c => c.notNull()).addColumn('title', 'text', c => c.notNull()).addColumn('summary', 'text', c => c.notNull())
    .addColumn('context', 'text', c => c.notNull()).addColumn('attachment_id', 'text').addColumn('target_task_id', 'text').addColumn('state', 'text', c => c.notNull())
    .addColumn('picked_by_agent_id', 'text').addColumn('created_by', 'text').addColumn('created_at', 'bigint', c => c.notNull()).execute();
  await s.createIndex('handoffs_project').on('handoffs').columns(['project_id', 'created_at']).execute();
}
