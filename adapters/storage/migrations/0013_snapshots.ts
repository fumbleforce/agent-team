import type { Kysely } from 'kysely';
import type { MigrationContext } from '../contract.ts';

// A snapshot is a worker-side page capture at a viewport. It is requested first and filled when the capture turn reports.
export async function up(db: Kysely<unknown>, _context: MigrationContext): Promise<void> {
  await db.schema.alterTable('product_envs').addColumn('last_status', 'text').execute();
  await db.schema.alterTable('product_envs').addColumn('last_latency_ms', 'integer').execute();
  await db.schema.createTable('snapshots').addColumn('id', 'text', c => c.primaryKey()).addColumn('project_id', 'text', c => c.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('env_id', 'text', c => c.notNull().references('product_envs.id').onDelete('cascade')).addColumn('url', 'text', c => c.notNull()).addColumn('viewport', 'text', c => c.notNull())
    .addColumn('state', 'text', c => c.notNull()).addColumn('error', 'text').addColumn('attachment_id', 'text', c => c.references('attachments.id'))
    .addColumn('markers', 'text', c => c.notNull().defaultTo('[]')).addColumn('description', 'text').addColumn('issue_id', 'text').addColumn('work_item_id', 'text')
    .addColumn('requested_by', 'text').addColumn('created_at', 'bigint', c => c.notNull()).addColumn('captured_at', 'bigint').execute();
  await db.schema.createIndex('snapshots_env').on('snapshots').columns(['env_id', 'viewport', 'created_at']).execute();
  await db.schema.createIndex('snapshots_work_item').on('snapshots').column('work_item_id').execute();
}
