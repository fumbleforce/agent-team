import { sql, type Kysely } from 'kysely';
import type { MigrationContext } from '../contract.ts';

export async function up(db: Kysely<unknown>, _context: MigrationContext): Promise<void> {
  const s = db.schema;
  await s.createTable('approvals').addColumn('id', 'text', c => c.primaryKey()).addColumn('task_id', 'text', c => c.notNull().references('tasks.id').onDelete('cascade'))
    .addColumn('kind', 'text', c => c.notNull()).addColumn('agent_id', 'text', c => c.notNull()).addColumn('turn_id', 'text', c => c.notNull()).addColumn('head_sha', 'text', c => c.notNull())
    .addColumn('verdict', 'text', c => c.notNull()).addColumn('findings', 'text', c => c.notNull()).addColumn('summary', 'text', c => c.notNull()).addColumn('state', 'text', c => c.notNull())
    .addColumn('created_at', 'bigint', c => c.notNull()).execute();
  await s.createIndex('approvals_task').on('approvals').columns(['task_id', 'state']).execute();
  await s.createTable('merge_queue').addColumn('id', 'text', c => c.primaryKey()).addColumn('project_id', 'text', c => c.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('task_id', 'text', c => c.notNull().references('tasks.id')).addColumn('head_sha', 'text', c => c.notNull()).addColumn('state', 'text', c => c.notNull())
    .addColumn('reason', 'text').addColumn('created_at', 'bigint', c => c.notNull()).addColumn('finished_at', 'bigint').execute();
  // One delivery per project at a time, held by the database.
  await s.createIndex('merge_queue_one_running').on('merge_queue').column('project_id').unique().where(sql.ref('state'), '=', 'running').execute();
}
