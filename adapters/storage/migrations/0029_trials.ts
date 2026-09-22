import type { Kysely } from 'kysely';
import type { MigrationContext } from '../contract.ts';

// A change the team made to how it works, run as a trial: what was changed, from what to what, which figure it was expected to
// move and which way, the figure before, and the verdict once the trial ended. Kept or reverted, never left unjudged.
export async function up(db: Kysely<unknown>, _context: MigrationContext): Promise<void> {
  await db.schema.createTable('trials').addColumn('id', 'text', c => c.primaryKey()).addColumn('project_id', 'text', c => c.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('proposal_id', 'text').addColumn('kind', 'text', c => c.notNull()).addColumn('target', 'text', c => c.notNull())
    .addColumn('before', 'text', c => c.notNull()).addColumn('after', 'text', c => c.notNull())
    .addColumn('measure', 'text', c => c.notNull()).addColumn('expect', 'text', c => c.notNull()).addColumn('baseline', 'real')
    .addColumn('started_at', 'bigint', c => c.notNull()).addColumn('ends_at', 'bigint', c => c.notNull())
    .addColumn('state', 'text', c => c.notNull()).addColumn('result', 'real').addColumn('verdict', 'text').addColumn('judged_at', 'bigint').execute();
  await db.schema.createIndex('trials_project_state').on('trials').columns(['project_id', 'state']).execute();
}
