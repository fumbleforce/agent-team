import type { Kysely } from 'kysely';
import type { MigrationContext } from '../contract.ts';

export async function up(db: Kysely<unknown>, _context: MigrationContext): Promise<void> {
  const s = db.schema;
  await s.createTable('proposals').addColumn('id', 'text', c => c.primaryKey()).addColumn('project_id', 'text', c => c.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('category', 'text', c => c.notNull()).addColumn('title', 'text', c => c.notNull()).addColumn('why', 'text', c => c.notNull()).addColumn('what_changes', 'text', c => c.notNull())
    .addColumn('change', 'text', c => c.notNull()).addColumn('evidence', 'text', c => c.notNull()).addColumn('proposer_agent_id', 'text', c => c.notNull()).addColumn('state', 'text', c => c.notNull())
    .addColumn('resolved_by_user', 'text').addColumn('resolution_note', 'text').addColumn('created_at', 'bigint', c => c.notNull()).addColumn('resolved_at', 'bigint').execute();
  await s.createIndex('proposals_project_state').on('proposals').columns(['project_id', 'state']).execute();
  await s.createTable('proposal_votes').addColumn('proposal_id', 'text', c => c.notNull().references('proposals.id').onDelete('cascade')).addColumn('agent_id', 'text', c => c.notNull())
    .addColumn('stance', 'text', c => c.notNull()).addColumn('note', 'text', c => c.notNull()).addPrimaryKeyConstraint('proposal_votes_pk', ['proposal_id', 'agent_id']).execute();
}
