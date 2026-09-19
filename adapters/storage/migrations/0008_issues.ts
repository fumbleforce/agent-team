import type { Kysely } from 'kysely';
import type { MigrationContext } from '../contract.ts';

export async function up(db: Kysely<unknown>, _context: MigrationContext): Promise<void> {
  await db.schema.createTable('issues').addColumn('id', 'text', c => c.primaryKey()).addColumn('project_id', 'text', c => c.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('number', 'integer', c => c.notNull()).addColumn('title', 'text', c => c.notNull()).addColumn('body', 'text', c => c.notNull()).addColumn('state', 'text', c => c.notNull())
    .addColumn('priority', 'text', c => c.notNull()).addColumn('source', 'text', c => c.notNull()).addColumn('owner_agent_id', 'text').addColumn('author_user_id', 'text')
    .addColumn('thread_id', 'text', c => c.notNull().references('threads.id')).addColumn('attachment_id', 'text').addColumn('created_at', 'bigint', c => c.notNull()).addColumn('closed_at', 'bigint')
    .addUniqueConstraint('issues_project_number', ['project_id', 'number']).execute();
}
