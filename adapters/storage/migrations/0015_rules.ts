import type { Kysely } from 'kysely';
import type { MigrationContext } from '../contract.ts';

// What the scheduler and the rules remember: a provider's limit until its reset, the route a turn ran on,
// the period a budget already warned in, and whether an agent's idle period has been announced.
export async function up(db: Kysely<unknown>, _context: MigrationContext): Promise<void> {
  await db.schema.alterTable('providers').addColumn('limited_until', 'bigint').execute();
  await db.schema.alterTable('turns').addColumn('provider_id', 'text').execute();
  await db.schema.alterTable('turns').addColumn('model', 'text').execute();
  await db.schema.alterTable('budgets').addColumn('warned_period', 'text').execute();
  await db.schema.alterTable('agents').addColumn('idle_at', 'bigint').execute();
}
