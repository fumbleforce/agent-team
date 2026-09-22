import type { Kysely } from 'kysely';
import type { MigrationContext } from '../contract.ts';

// The column of the board a task and its tracker issue were last seen to agree on. With it a poll can tell which side moved:
// the one that left it. Without it, a move the platform made but never announced looked like the tracker had not moved, and
// the tracker's older column won. Null until the next poll sees both sides.
export async function up(db: Kysely<unknown>, _context: MigrationContext): Promise<void> {
  await db.schema.alterTable('external_refs').addColumn('synced_state', 'text').execute();
}
