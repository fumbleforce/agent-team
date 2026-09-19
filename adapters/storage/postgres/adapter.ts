import { Kysely, PostgresDialect, sql } from 'kysely';
import type { MigrationContext, StorageAdapter } from '../contract.ts';
import type { Schema } from '../schema.ts';
import { createBus } from '../shared/bus.ts';
import { runMigrations } from '../shared/migrate.ts';

const MIGRATION_CONTEXT: MigrationContext = {
  dialect: 'postgres',
  booleanType: 'boolean',
  serialType: 'bigserial',
  serialColumn: column => column.primaryKey(),
};
const APPEND_LOCK = 4310;

export async function createPostgresAdapter(config: { url: string }): Promise<StorageAdapter> {
  const name = 'pg';
  const pg = await import(name).catch(() => { throw new Error('The postgres storage adapter needs the "pg" package: npm install pg'); });
  const Pool = pg.default?.Pool ?? pg.Pool;
  // bigint columns are millisecond timestamps and sequence numbers, all within the safe integer range.
  (pg.default?.types ?? pg.types).setTypeParser(20, (value: string) => Number(value));
  const db = new Kysely<Schema>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: config.url }) }) });
  return {
    dialect: 'postgres',
    db,
    // One coordinator process appends events; a second process would need LISTEN/NOTIFY here.
    bus: createBus(),
    transaction: fn => db.transaction().execute(fn),
    appendLock: async tx => { await sql`select pg_advisory_xact_lock(${APPEND_LOCK})`.execute(tx); },
    migrate: () => runMigrations(db, MIGRATION_CONTEXT),
    close: () => db.destroy(),
  };
}
