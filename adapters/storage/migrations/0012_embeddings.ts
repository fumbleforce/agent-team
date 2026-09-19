import type { Kysely } from 'kysely';
import type { MigrationContext } from '../contract.ts';

// Vectors are stored portably and compared in the coordinator; a dialect with a native vector index may take over later.
export async function up(db: Kysely<unknown>, _context: MigrationContext): Promise<void> {
  await db.schema.createTable('embeddings').addColumn('doc_type', 'text', c => c.notNull()).addColumn('doc_id', 'text', c => c.notNull()).addColumn('model', 'text', c => c.notNull())
    .addColumn('vector', 'text', c => c.notNull()).addPrimaryKeyConstraint('embeddings_pk', ['doc_type', 'doc_id']).execute();
}
