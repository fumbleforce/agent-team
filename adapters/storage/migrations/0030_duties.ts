import type { Kysely } from 'kysely';
import type { MigrationContext } from '../contract.ts';

// A standing duty: a recurring responsibility a seat owns, which opens a task for that seat each time it comes round, so the
// team does not wait to be asked. One open task per duty at a time: a duty whose last task is still open does not pile up.
export async function up(db: Kysely<unknown>, _context: MigrationContext): Promise<void> {
  await db.schema.createTable('duties').addColumn('id', 'text', c => c.primaryKey()).addColumn('project_id', 'text', c => c.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('agent_id', 'text', c => c.notNull().references('agents.id').onDelete('cascade')).addColumn('title', 'text', c => c.notNull()).addColumn('brief', 'text', c => c.notNull())
    .addColumn('result_kind', 'text', c => c.notNull().defaultTo('document')).addColumn('every_ms', 'bigint', c => c.notNull()).addColumn('next_at', 'bigint', c => c.notNull())
    .addColumn('last_task_id', 'text').addColumn('active', 'boolean', c => c.notNull().defaultTo(true)).addColumn('created_at', 'bigint', c => c.notNull()).execute();
  await db.schema.createIndex('duties_due').on('duties').columns(['active', 'next_at']).execute();
}
