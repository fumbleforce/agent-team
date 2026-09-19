import type { Kysely } from 'kysely';
import type { MigrationContext } from '../contract.ts';

export async function up(db: Kysely<unknown>, context: MigrationContext): Promise<void> {
  const s = db.schema;
  const ms = 'bigint' as const, bool = context.booleanType;

  await s.createTable('deliberations').addColumn('id', 'text', c => c.primaryKey()).addColumn('project_id', 'text', c => c.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('thread_id', 'text', c => c.notNull().references('threads.id')).addColumn('kind', 'text', c => c.notNull()).addColumn('task_id', 'text')
    .addColumn('question', 'text', c => c.notNull()).addColumn('proposer_agent_id', 'text', c => c.notNull()).addColumn('decider_agent_id', 'text')
    .addColumn('state', 'text', c => c.notNull()).addColumn('revised', bool, c => c.notNull()).addColumn('blocking', bool, c => c.notNull())
    .addColumn('feedback_deadline', ms, c => c.notNull()).addColumn('extended', bool, c => c.notNull()).addColumn('created_at', ms, c => c.notNull()).execute();
  await s.createIndex('deliberations_open').on('deliberations').columns(['state', 'feedback_deadline']).execute();
  await s.createTable('deliberation_participants').addColumn('deliberation_id', 'text', c => c.notNull().references('deliberations.id').onDelete('cascade'))
    .addColumn('agent_id', 'text', c => c.notNull()).addColumn('state', 'text', c => c.notNull()).addColumn('stance', 'text').addColumn('is_blocking', bool, c => c.notNull())
    .addColumn('message_id', 'text').addPrimaryKeyConstraint('deliberation_participants_pk', ['deliberation_id', 'agent_id']).execute();
  await s.createTable('decisions').addColumn('id', 'text', c => c.primaryKey()).addColumn('project_id', 'text', c => c.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('thread_id', 'text', c => c.notNull()).addColumn('message_id', 'text', c => c.notNull()).addColumn('deliberation_id', 'text').addColumn('kind', 'text', c => c.notNull())
    .addColumn('outcome', 'text', c => c.notNull()).addColumn('summary', 'text', c => c.notNull()).addColumn('needs_human', bool, c => c.notNull())
    .addColumn('resolved_by_user', 'text').addColumn('resolved_at', ms).addColumn('created_at', ms, c => c.notNull()).execute();
  await s.createIndex('decisions_needs_human').on('decisions').columns(['needs_human', 'resolved_at']).execute();
}
