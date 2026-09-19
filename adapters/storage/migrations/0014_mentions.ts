import type { Kysely } from 'kysely';
import type { MigrationContext } from '../contract.ts';

// A mention is a directed request that earns exactly one reply turn. A tool call is remembered by key, so a retry
// returns what the first attempt returned, and the rows are what the per-turn limits are counted from.
export async function up(db: Kysely<unknown>, _context: MigrationContext): Promise<void> {
  const s = db.schema;
  await s.createTable('mentions').addColumn('id', 'text', c => c.primaryKey()).addColumn('message_id', 'text', c => c.notNull().references('messages.id').onDelete('cascade'))
    .addColumn('thread_id', 'text', c => c.notNull()).addColumn('project_id', 'text', c => c.notNull()).addColumn('author_kind', 'text', c => c.notNull()).addColumn('author_id', 'text')
    .addColumn('target_type', 'text', c => c.notNull()).addColumn('target_id', 'text', c => c.notNull()).addColumn('agent_id', 'text').addColumn('expects', 'text', c => c.notNull())
    .addColumn('state', 'text', c => c.notNull()).addColumn('depth', 'integer', c => c.notNull()).addColumn('work_item_id', 'text').addColumn('reply_message_id', 'text')
    .addColumn('created_at', 'bigint', c => c.notNull()).execute();
  await s.createIndex('mentions_thread_agent').on('mentions').columns(['thread_id', 'agent_id', 'created_at']).execute();
  await s.createIndex('mentions_work_item').on('mentions').column('work_item_id').execute();
  await s.createTable('tool_calls').ifNotExists().addColumn('turn_id', 'text', c => c.notNull().references('turns.id').onDelete('cascade')).addColumn('seq', 'integer', c => c.notNull())
    .addColumn('tool', 'text', c => c.notNull()).addColumn('args_hash', 'text', c => c.notNull()).addColumn('idempotency_key', 'text').addColumn('result', 'text')
    .addColumn('created_at', 'bigint', c => c.notNull()).addPrimaryKeyConstraint('tool_calls_pk', ['turn_id', 'seq']).addUniqueConstraint('tool_calls_key', ['turn_id', 'idempotency_key']).execute();
}
