import type { Kysely } from 'kysely';
import type { MigrationContext } from '../contract.ts';

export async function up(db: Kysely<unknown>, _context: MigrationContext): Promise<void> {
  const s = db.schema;
  const ms = 'bigint' as const;

  await s.createTable('cost_entries').addColumn('id', 'text', c => c.primaryKey()).addColumn('turn_id', 'text').addColumn('agent_id', 'text')
    .addColumn('project_id', 'text', c => c.notNull().references('projects.id').onDelete('cascade')).addColumn('provider_id', 'text').addColumn('billing_kind', 'text', c => c.notNull())
    .addColumn('tokens_in', 'integer', c => c.notNull()).addColumn('tokens_out', 'integer', c => c.notNull()).addColumn('amount_minor', 'integer', c => c.notNull())
    .addColumn('currency', 'text', c => c.notNull()).addColumn('at', ms, c => c.notNull()).execute();
  await s.createIndex('cost_entries_project_at').on('cost_entries').columns(['project_id', 'at']).execute();
  // An empty agent_id stands for spend without an agent, so the key needs no expression index.
  await s.createTable('cost_daily').addColumn('day', 'text', c => c.notNull()).addColumn('project_id', 'text', c => c.notNull()).addColumn('agent_id', 'text', c => c.notNull())
    .addColumn('amount_minor', 'integer', c => c.notNull()).addColumn('tokens', 'integer', c => c.notNull()).addPrimaryKeyConstraint('cost_daily_pk', ['day', 'project_id', 'agent_id']).execute();
  await s.createTable('budgets').addColumn('scope', 'text', c => c.notNull()).addColumn('scope_id', 'text', c => c.notNull()).addColumn('period', 'text', c => c.notNull())
    .addColumn('amount_minor', 'integer', c => c.notNull()).addPrimaryKeyConstraint('budgets_pk', ['scope', 'scope_id', 'period']).execute();

  await s.createTable('kb_pages').addColumn('id', 'text', c => c.primaryKey()).addColumn('scope_type', 'text', c => c.notNull()).addColumn('scope_id', 'text', c => c.notNull())
    .addColumn('path', 'text', c => c.notNull()).addColumn('title', 'text', c => c.notNull()).addColumn('current_rev', 'integer', c => c.notNull()).addColumn('archived_at', ms)
    .addColumn('updated_at', ms, c => c.notNull()).addUniqueConstraint('kb_pages_scope_path', ['scope_type', 'scope_id', 'path']).execute();
  await s.createTable('kb_revisions').addColumn('page_id', 'text', c => c.notNull().references('kb_pages.id').onDelete('cascade')).addColumn('rev_no', 'integer', c => c.notNull())
    .addColumn('body', 'text', c => c.notNull()).addColumn('author_kind', 'text', c => c.notNull()).addColumn('author_id', 'text').addColumn('note', 'text')
    .addColumn('created_at', ms, c => c.notNull()).addPrimaryKeyConstraint('kb_revisions_pk', ['page_id', 'rev_no']).execute();
  await s.createTable('kb_reads').addColumn('page_id', 'text', c => c.notNull().references('kb_pages.id').onDelete('cascade')).addColumn('rev_no', 'integer', c => c.notNull())
    .addColumn('agent_id', 'text', c => c.notNull()).addColumn('turn_id', 'text').addColumn('at', ms, c => c.notNull()).execute();
  await s.createIndex('kb_reads_page_at').on('kb_reads').columns(['page_id', 'at']).execute();
  await s.createTable('memories').addColumn('id', 'text', c => c.primaryKey()).addColumn('scope_type', 'text', c => c.notNull()).addColumn('scope_id', 'text', c => c.notNull())
    .addColumn('agent_id', 'text').addColumn('type', 'text', c => c.notNull()).addColumn('title', 'text', c => c.notNull()).addColumn('body', 'text', c => c.notNull())
    .addColumn('status', 'text', c => c.notNull()).addColumn('hits', 'integer', c => c.notNull()).addColumn('last_hit_at', ms).addColumn('promoted_page_id', 'text')
    .addColumn('created_at', ms, c => c.notNull()).execute();
  await s.createIndex('memories_scope').on('memories').columns(['scope_type', 'scope_id', 'status']).execute();

  // The portable search corpus. A dialect may index it natively; the portable query matches terms against it.
  await s.createTable('search_docs').addColumn('doc_type', 'text', c => c.notNull()).addColumn('doc_id', 'text', c => c.notNull()).addColumn('scope_type', 'text', c => c.notNull())
    .addColumn('scope_id', 'text', c => c.notNull()).addColumn('title', 'text', c => c.notNull()).addColumn('body', 'text', c => c.notNull())
    .addPrimaryKeyConstraint('search_docs_pk', ['doc_type', 'doc_id']).execute();
  await s.createIndex('search_docs_scope').on('search_docs').columns(['scope_type', 'scope_id']).execute();
}
