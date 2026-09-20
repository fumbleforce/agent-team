import type { Kysely } from 'kysely';
import type { MigrationContext } from '../contract.ts';

// Keys and tokens entered in the app. Only the sealed form is stored; the key that opens it never is.
export async function up(db: Kysely<unknown>, _context: MigrationContext): Promise<void> {
  await db.schema.createTable('secrets')
    .addColumn('name', 'text', col => col.primaryKey())
    .addColumn('sealed', 'text', col => col.notNull())
    .addColumn('updated_by', 'text')
    .addColumn('updated_at', 'bigint', col => col.notNull())
    .execute();
}
