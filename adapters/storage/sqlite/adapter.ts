import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Kysely, SqliteDialect, type KyselyPlugin, type PluginTransformQueryArgs, type PluginTransformResultArgs, type QueryResult, type RootOperationNode, type UnknownRow } from 'kysely';
import type { MigrationContext, StorageAdapter, Tx } from '../contract.ts';
import { BOOLEAN_COLUMNS, type Schema } from '../schema.ts';
import { createBus } from '../shared/bus.ts';
import { runMigrations } from '../shared/migrate.ts';

type Param = null | number | bigint | string | Uint8Array;
const bind = (values: readonly unknown[]): Param[] => values.map(value => (typeof value === 'boolean' ? Number(value) : (value ?? null)) as Param);

// The shape Kysely's SQLite driver expects, over the runtime's built-in database.
function kyselyDatabase(database: DatabaseSync) {
  return {
    close: () => database.close(),
    prepare(sql: string) {
      const statement = database.prepare(sql);
      return {
        reader: statement.columns().length > 0,
        all: (values: readonly unknown[]) => statement.all(...bind(values)),
        run: (values: readonly unknown[]) => statement.run(...bind(values)),
        iterate: (values: readonly unknown[]) => statement.iterate(...bind(values)) as IterableIterator<unknown>,
      };
    },
  };
}

class BooleanColumns implements KyselyPlugin {
  transformQuery(args: PluginTransformQueryArgs): RootOperationNode { return args.node; }
  async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    for (const row of args.result.rows) for (const key of Object.keys(row)) if (BOOLEAN_COLUMNS.has(key) && typeof row[key] === 'number') row[key] = row[key] === 1;
    return args.result;
  }
}

const MIGRATION_CONTEXT: MigrationContext = {
  dialect: 'sqlite',
  booleanType: 'integer',
  serialType: 'integer',
  serialColumn: column => column.primaryKey().autoIncrement(),
};

export function createSqliteAdapter(config: { path: string }): StorageAdapter {
  if (config.path !== ':memory:') mkdirSync(path.dirname(path.resolve(config.path)), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(config.path);
  if (config.path !== ':memory:') chmodSync(config.path, 0o600);
  database.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;');
  const db = new Kysely<Schema>({ dialect: new SqliteDialect({ database: kyselyDatabase(database) as never }), plugins: [new BooleanColumns()] });
  return {
    dialect: 'sqlite',
    db,
    bus: createBus(),
    transaction: fn => db.transaction().execute(fn),
    // One connection behind a mutex: transactions are already serial.
    appendLock: async (_tx: Tx) => {},
    migrate: () => runMigrations(db, MIGRATION_CONTEXT),
    close: () => db.destroy(),
  };
}
