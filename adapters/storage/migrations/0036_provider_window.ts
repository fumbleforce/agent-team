import type { Kysely } from 'kysely';
import type { MigrationContext } from '../contract.ts';

// How much of its usage window a provider has used and when that window resets, as the engine itself last said.
export async function up(db: Kysely<unknown>, _context: MigrationContext): Promise<void> {
  await db.schema.alterTable('providers').addColumn('window_used', 'real').execute();
  await db.schema.alterTable('providers').addColumn('window_reset_at', 'bigint').execute();
}
