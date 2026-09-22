import type { Kysely } from 'kysely';
import type { MigrationContext } from '../contract.ts';

// Work whose result is a document rather than a change to a repository: a page of the knowledge store at a revision,
// reviewed at that revision the way a change is reviewed at a commit, and done when that revision is accepted.
export async function up(db: Kysely<unknown>, _context: MigrationContext): Promise<void> {
  await db.schema.alterTable('tasks').addColumn('result_kind', 'text', c => c.notNull().defaultTo('change')).execute();
  // JSON: { pageId, path, rev }, set when the owner submits the document for review.
  await db.schema.alterTable('tasks').addColumn('result_ref', 'text').execute();
}
