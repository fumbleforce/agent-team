import type { Kysely } from 'kysely';
import type { MigrationContext } from '../contract.ts';

// Engines report US dollars; the organization reads its costs in its own currency. Each entry keeps what the engine
// reported and the rate that turned it into the amount shown, so a later rate never rewrites the ledger.
// Entries written before this were the engine's dollar figure stored as is: their rate is 1.
export async function up(db: Kysely<unknown>, _context: MigrationContext): Promise<void> {
  await db.schema.alterTable('cost_entries').addColumn('rate', 'double precision', c => c.notNull().defaultTo(1)).execute();
  await db.schema.alterTable('cost_entries').addColumn('usd_minor', 'integer', c => c.notNull().defaultTo(0)).execute();
  const loose = db as Kysely<{ cost_entries: { usd_minor: number; amount_minor: number } }>;
  await loose.updateTable('cost_entries').set(eb => ({ usd_minor: eb.ref('amount_minor') })).execute();
}
