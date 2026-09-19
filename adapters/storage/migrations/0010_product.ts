import type { Kysely } from 'kysely';
import type { MigrationContext } from '../contract.ts';

export async function up(db: Kysely<unknown>, _context: MigrationContext): Promise<void> {
  await db.schema.createTable('product_envs').addColumn('id', 'text', c => c.primaryKey()).addColumn('project_id', 'text', c => c.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('name', 'text', c => c.notNull()).addColumn('branch', 'text').addColumn('url', 'text', c => c.notNull()).addColumn('source', 'text', c => c.notNull())
    .addColumn('created_at', 'bigint', c => c.notNull()).execute();
}
