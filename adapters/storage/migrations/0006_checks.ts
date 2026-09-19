import type { Kysely } from 'kysely';
import type { MigrationContext } from '../contract.ts';

export async function up(db: Kysely<unknown>, _context: MigrationContext): Promise<void> {
  const s = db.schema;
  await s.createTable('check_runs').addColumn('id', 'text', c => c.primaryKey()).addColumn('project_id', 'text', c => c.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('suite', 'text', c => c.notNull()).addColumn('kind', 'text', c => c.notNull()).addColumn('branch', 'text', c => c.notNull()).addColumn('sha', 'text')
    .addColumn('status', 'text', c => c.notNull()).addColumn('passed', 'integer', c => c.notNull()).addColumn('failed', 'integer', c => c.notNull()).addColumn('skipped', 'integer', c => c.notNull())
    .addColumn('total', 'integer', c => c.notNull()).addColumn('duration_ms', 'integer', c => c.notNull()).addColumn('source', 'text', c => c.notNull()).addColumn('created_at', 'bigint', c => c.notNull()).execute();
  await s.createIndex('check_runs_latest').on('check_runs').columns(['project_id', 'branch', 'suite', 'created_at']).execute();
  await s.createTable('check_cases').addColumn('run_id', 'text', c => c.notNull().references('check_runs.id').onDelete('cascade')).addColumn('name', 'text', c => c.notNull())
    .addColumn('status', 'text', c => c.notNull()).addColumn('message', 'text').execute();
  await s.createIndex('check_cases_run').on('check_cases').column('run_id').execute();
}
