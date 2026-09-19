import type { Kysely } from 'kysely';
import { Migrator, type Migration } from 'kysely/migration';
import type { MigrationContext } from '../contract.ts';
import * as init from '../migrations/0001_init.ts';
import * as runtime from '../migrations/0002_runtime.ts';
import * as knowledge from '../migrations/0003_costs_knowledge.ts';
import * as deliberation from '../migrations/0004_deliberation.ts';
import * as delivery from '../migrations/0005_delivery.ts';
import * as checks from '../migrations/0006_checks.ts';
import * as proposals from '../migrations/0007_proposals.ts';
import * as issues from '../migrations/0008_issues.ts';
import * as integrations from '../migrations/0009_integrations.ts';
import * as product from '../migrations/0010_product.ts';
import * as schedules from '../migrations/0011_schedules.ts';
import * as embeddings from '../migrations/0012_embeddings.ts';
import * as snapshots from '../migrations/0013_snapshots.ts';
import * as mentions from '../migrations/0014_mentions.ts';
import * as rules from '../migrations/0015_rules.ts';
import * as orgAuth from '../migrations/0016_org_auth.ts';
import * as agentSessions from '../migrations/0017_sessions.ts';

type ContextMigration = { up(db: Kysely<unknown>, context: MigrationContext): Promise<void> };
const MIGRATIONS: Record<string, ContextMigration> = { '0001_init': init, '0002_runtime': runtime, '0003_costs_knowledge': knowledge, '0004_deliberation': deliberation, '0005_delivery': delivery, '0006_checks': checks, '0007_proposals': proposals, '0008_issues': issues, '0009_integrations': integrations, '0010_product': product, '0011_schedules': schedules, '0012_embeddings': embeddings, '0013_snapshots': snapshots, '0014_mentions': mentions, '0015_rules': rules, '0016_org_auth': orgAuth, '0017_sessions': agentSessions };

// Forward-only, each in its own transaction, recorded in Kysely's migration table.
export async function runMigrations(db: Kysely<never> | Kysely<any>, context: MigrationContext): Promise<void> {
  const migrations: Record<string, Migration> = {};
  for (const [name, migration] of Object.entries(MIGRATIONS)) migrations[name] = { up: target => migration.up(target, context) };
  const migrator = new Migrator({ db: db as Kysely<any>, provider: { getMigrations: async () => migrations } });
  const { error } = await migrator.migrateToLatest();
  if (error) throw error;
}
