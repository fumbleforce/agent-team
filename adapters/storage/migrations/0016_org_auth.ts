import type { Kysely } from 'kysely';
import type { MigrationContext } from '../contract.ts';

// Sign-in throttling, replayable creates, revocable machine credentials in use, and the organization's cross-project edges.
export async function up(db: Kysely<unknown>, _context: MigrationContext): Promise<void> {
  const s = db.schema;
  // One row per throttled subject: "ip:<address>" or "account:<email>".
  await s.createTable('login_attempts').addColumn('subject', 'text', c => c.primaryKey()).addColumn('failures', 'integer', c => c.notNull())
    .addColumn('window_start', 'bigint', c => c.notNull()).addColumn('locked_until', 'bigint').execute();
  // status 0 marks a request still running; a finished one keeps its answer until it expires.
  await s.createTable('idempotency_keys').addColumn('user_id', 'text', c => c.notNull()).addColumn('key', 'text', c => c.notNull()).addColumn('fingerprint', 'text', c => c.notNull())
    .addColumn('status', 'integer', c => c.notNull()).addColumn('response', 'text').addColumn('created_at', 'bigint', c => c.notNull()).addColumn('expires_at', 'bigint', c => c.notNull())
    .addPrimaryKeyConstraint('idempotency_keys_pk', ['user_id', 'key']).execute();
  await s.createIndex('idempotency_keys_expiry').on('idempotency_keys').column('expires_at').execute();
  await s.alterTable('machine_tokens').addColumn('last_used_at', 'bigint').execute();

  await s.createTable('project_links').addColumn('id', 'text', c => c.primaryKey()).addColumn('from_project_id', 'text', c => c.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('to_project_id', 'text', c => c.notNull().references('projects.id').onDelete('cascade')).addColumn('kind', 'text', c => c.notNull()).addColumn('note', 'text', c => c.notNull())
    .addColumn('created_by', 'text').addColumn('created_at', 'bigint', c => c.notNull()).addUniqueConstraint('project_links_edge', ['from_project_id', 'to_project_id', 'kind']).execute();
  await s.createTable('seat_loans').addColumn('id', 'text', c => c.primaryKey()).addColumn('agent_id', 'text', c => c.notNull().references('agents.id').onDelete('cascade'))
    .addColumn('to_project_id', 'text', c => c.notNull().references('projects.id').onDelete('cascade')).addColumn('state', 'text', c => c.notNull()).addColumn('note', 'text', c => c.notNull())
    .addColumn('created_by', 'text').addColumn('created_at', 'bigint', c => c.notNull()).addColumn('ended_at', 'bigint').execute();
  await s.createIndex('seat_loans_agent').on('seat_loans').columns(['agent_id', 'state']).execute();
  await s.createIndex('seat_loans_project').on('seat_loans').columns(['to_project_id', 'state']).execute();
}
