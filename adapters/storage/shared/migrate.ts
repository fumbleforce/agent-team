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
import * as gaps from '../migrations/0019_gaps.ts';
import * as artifacts from '../migrations/0020_artifacts.ts';
import * as sync from '../migrations/0021_sync.ts';
import * as search from '../migrations/0022_search.ts';
import * as costs from '../migrations/0023_costs.ts';
import * as runtimeLimits from '../migrations/0024_runtime_limits.ts';
import * as secrets from '../migrations/0025_secrets.ts';
import * as teamDefault from '../migrations/0026_team_default.ts';
import * as continuity from '../migrations/0027_continuity.ts';
import * as documents from '../migrations/0028_documents.ts';
import * as trials from '../migrations/0029_trials.ts';
import * as duties from '../migrations/0030_duties.ts';
import * as decisions from '../migrations/0031_decisions.ts';
import * as syncedState from '../migrations/0032_synced_state.ts';

type ContextMigration = { up(db: Kysely<unknown>, context: MigrationContext): Promise<void> };
const MIGRATIONS: Record<string, ContextMigration> = { '0001_init': init, '0002_runtime': runtime, '0003_costs_knowledge': knowledge, '0004_deliberation': deliberation, '0005_delivery': delivery, '0006_checks': checks, '0007_proposals': proposals, '0008_issues': issues, '0009_integrations': integrations, '0010_product': product, '0011_schedules': schedules, '0012_embeddings': embeddings, '0013_snapshots': snapshots, '0014_mentions': mentions, '0015_rules': rules, '0016_org_auth': orgAuth, '0017_sessions': agentSessions, '0019_gaps': gaps, '0020_artifacts': artifacts, '0021_sync': sync, '0022_search': search, '0023_costs': costs, '0024_runtime_limits': runtimeLimits, '0025_secrets': secrets, '0026_team_default': teamDefault, '0027_continuity': continuity, '0028_documents': documents, '0029_trials': trials, '0030_duties': duties, '0031_decisions': decisions, '0032_synced_state': syncedState };

// Forward-only, each in its own transaction, recorded in Kysely's migration table.
export async function runMigrations(db: Kysely<never> | Kysely<any>, context: MigrationContext, upTo?: string): Promise<void> {
  const migrations: Record<string, Migration> = {};
  for (const [name, migration] of Object.entries(MIGRATIONS)) migrations[name] = { up: target => migration.up(target, context) };
  const migrator = new Migrator({ db: db as Kysely<any>, provider: { getMigrations: async () => migrations } });
  const { error } = await (upTo ? migrator.migrateTo(upTo) : migrator.migrateToLatest());
  if (error) throw error;
}
