import type { Kysely } from 'kysely';
import type { MigrationContext } from '../contract.ts';

// What makes a seat persist while its compute does not: the owner's running record of a task, and the seat's own notebook.
// Both live here, so any worker can run the next turn and an engine session that is gone costs nothing.
export async function up(db: Kysely<unknown>, _context: MigrationContext): Promise<void> {
  // JSON: { standing, next, open, turnId, at }.
  await db.schema.alterTable('tasks').addColumn('journal', 'text').execute();
  await db.schema.alterTable('agents').addColumn('notebook', 'text').execute();
}
