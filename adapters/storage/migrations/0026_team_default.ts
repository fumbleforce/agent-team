import type { Kysely } from 'kysely';
import type { MigrationContext } from '../contract.ts';

// What an agent of the team runs on when it has no provider of its own. Empty means whatever the worker machine runs.
export async function up(db: Kysely<unknown>, _context: MigrationContext): Promise<void> {
  await db.schema.alterTable('teams').addColumn('default_provider_id', 'text').execute();
  await db.schema.alterTable('teams').addColumn('default_model', 'text').execute();
  // How much effort the model is asked to spend: the team's usual, and an agent's own.
  await db.schema.alterTable('teams').addColumn('default_effort', 'text').execute();
  await db.schema.alterTable('agents').addColumn('effort', 'text').execute();
}
