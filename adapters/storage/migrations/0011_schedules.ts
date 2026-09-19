import type { Kysely } from 'kysely';
import type { MigrationContext } from '../contract.ts';

export async function up(db: Kysely<unknown>, _context: MigrationContext): Promise<void> {
  await db.schema.createTable('schedules').addColumn('id', 'text', c => c.primaryKey()).addColumn('project_id', 'text', c => c.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('kind', 'text', c => c.notNull()).addColumn('interval_ms', 'bigint', c => c.notNull()).addColumn('next_at', 'bigint', c => c.notNull()).addColumn('last_at', 'bigint')
    .addUniqueConstraint('schedules_project_kind', ['project_id', 'kind']).execute();
}
