import type { Kysely } from 'kysely';
import type { MigrationContext } from '../contract.ts';

// A step artifact too large for its row, or not text at all (a screenshot, the raw engine stream), lives in the artifact store:
// the row keeps the key, the media type and the size, and its body stays empty.
export async function up(db: Kysely<unknown>, _context: MigrationContext): Promise<void> {
  await db.schema.alterTable('step_artifacts').addColumn('storage_key', 'text').execute();
  await db.schema.alterTable('step_artifacts').addColumn('mime', 'text').execute();
}
