import type { Kysely } from 'kysely';
import type { MigrationContext } from '../contract.ts';

// Memory that keeps itself true. A memory and a page carry a one-line abstract (and a page a short overview) written when they change,
// so a turn can be given many of them cheaply. A memory keeps the evidence it came from, the role it is for when it is about how a role
// works, and what superseded it instead of being deleted. Its score moves with how the turns given it fared, and which memories a turn
// was given is kept. A seat's notebook keeps its history.
export async function up(db: Kysely<unknown>, _context: MigrationContext): Promise<void> {
  await db.schema.alterTable('memories').addColumn('abstract', 'text', c => c.notNull().defaultTo('')).execute();
  await db.schema.alterTable('memories').addColumn('role_slug', 'text').execute();
  // JSON: [{ kind: 'task' | 'turn' | 'event' | 'review' | 'decision', id }].
  await db.schema.alterTable('memories').addColumn('evidence', 'text', c => c.notNull().defaultTo('[]')).execute();
  await db.schema.alterTable('memories').addColumn('superseded_by', 'text').execute();
  await db.schema.alterTable('memories').addColumn('superseded_at', 'bigint').execute();
  await db.schema.alterTable('memories').addColumn('supersede_reason', 'text').execute();
  await db.schema.alterTable('memories').addColumn('score', 'integer', c => c.notNull().defaultTo(0)).execute();
  // Who it came from: an agent that filed it, the memory turn, or the owner, whose word outranks the rest.
  await db.schema.alterTable('memories').addColumn('source', 'text', c => c.notNull().defaultTo('agent')).execute();
  await db.schema.alterTable('kb_pages').addColumn('abstract', 'text', c => c.notNull().defaultTo('')).execute();
  await db.schema.alterTable('kb_pages').addColumn('overview', 'text', c => c.notNull().defaultTo('')).execute();
  await db.schema.createTable('memory_injections').addColumn('turn_id', 'text', c => c.notNull()).addColumn('memory_id', 'text', c => c.notNull().references('memories.id').onDelete('cascade'))
    .addColumn('depth', 'text', c => c.notNull()).addColumn('created_at', 'bigint', c => c.notNull()).addPrimaryKeyConstraint('memory_injections_pk', ['turn_id', 'memory_id']).execute();
  await db.schema.createIndex('memory_injections_memory').on('memory_injections').columns(['memory_id']).execute();
  await db.schema.createTable('notebook_revisions').addColumn('agent_id', 'text', c => c.notNull().references('agents.id').onDelete('cascade')).addColumn('rev', 'integer', c => c.notNull())
    .addColumn('body', 'text', c => c.notNull()).addColumn('turn_id', 'text').addColumn('created_at', 'bigint', c => c.notNull()).addPrimaryKeyConstraint('notebook_revisions_pk', ['agent_id', 'rev']).execute();
}
