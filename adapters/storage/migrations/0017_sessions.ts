import type { Kysely } from 'kysely';
import type { MigrationContext } from '../contract.ts';

// Engine sessions scoped to (agent, task), the context mode of each turn, and the text artifacts of trace steps (diffs, run output, think text).
export async function up(db: Kysely<unknown>, _context: MigrationContext): Promise<void> {
  const ms = 'bigint' as const;
  await db.schema.createTable('agent_sessions').addColumn('id', 'text', c => c.primaryKey()).addColumn('agent_id', 'text', c => c.notNull().references('agents.id').onDelete('cascade'))
    .addColumn('task_id', 'text', c => c.references('tasks.id')).addColumn('purpose', 'text', c => c.notNull()).addColumn('engine', 'text').addColumn('provider_id', 'text').addColumn('model', 'text')
    .addColumn('engine_session_id', 'text').addColumn('worker_id', 'text', c => c.notNull()).addColumn('state', 'text', c => c.notNull()).addColumn('context_tokens', 'integer', c => c.notNull())
    .addColumn('turn_count', 'integer', c => c.notNull()).addColumn('rotated_from', 'text').addColumn('base_sha', 'text').addColumn('created_at', ms, c => c.notNull()).addColumn('last_turn_at', ms, c => c.notNull()).execute();
  await db.schema.createIndex('agent_sessions_scope').on('agent_sessions').columns(['agent_id', 'task_id', 'state']).execute();
  await db.schema.alterTable('turns').addColumn('session_id', 'text').execute();
  await db.schema.alterTable('turns').addColumn('context_mode', 'text').execute();
  await db.schema.createTable('step_artifacts').addColumn('turn_id', 'text', c => c.notNull().references('turns.id').onDelete('cascade')).addColumn('seq', 'integer', c => c.notNull())
    .addColumn('kind', 'text', c => c.notNull()).addColumn('body', 'text', c => c.notNull()).addColumn('bytes', 'integer', c => c.notNull()).addColumn('truncated', 'integer', c => c.notNull())
    .addColumn('created_at', ms, c => c.notNull()).addPrimaryKeyConstraint('step_artifacts_pk', ['turn_id', 'seq']).execute();
}
