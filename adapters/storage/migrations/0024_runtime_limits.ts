import { sql, type Kysely } from 'kysely';
import type { MigrationContext } from '../contract.ts';

// The claim's remaining guarantees, held by the database. One writer per worktree (turns_one_writer_per_task), one live work item
// per dedupe key (work_items_live_dedupe) and one running merge-queue entry per project (merge_queue_one_running) exist since
// 0002 and 0005; what was missing is one running turn per session and one running delivery turn per project.
// `git_admin` is set while a turn changes the shared git state of a primary checkout, so a lease lost in between quarantines the checkout.
export async function up(db: Kysely<unknown>, _context: MigrationContext): Promise<void> {
  await db.schema.alterTable('turns').addColumn('git_admin', 'text').execute();
  await db.schema.createIndex('turns_one_per_session').on('turns').column('session_id').unique().where(eb => eb.and([eb(sql.ref('state'), '=', 'running'), eb(sql.ref('session_id'), 'is not', null)])).execute();
  await db.schema.createIndex('turns_one_delivery_per_project').on('turns').column('project_id').unique().where(eb => eb.and([eb(sql.ref('state'), '=', 'running'), eb(sql.ref('kind'), '=', 'deliver')])).execute();
}
