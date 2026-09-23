import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { CompiledQuery, type DatabaseConnection, type Driver, Kysely, SqliteDialect, SqliteDriver, sql, type KyselyPlugin, type PluginTransformQueryArgs, type PluginTransformResultArgs, type QueryResult, type RootOperationNode, type UnknownRow } from 'kysely';
import type { Db, MigrationContext, StorageAdapter, Tx, VectorPort } from '../contract.ts';
import { BOOLEAN_COLUMNS, type Schema } from '../schema.ts';
import { createBus } from '../shared/bus.ts';
import { runMigrations } from '../shared/migrate.ts';
import { inLoadOrder } from '../shared/copy.ts';
import { createSearch, storeVector } from '../shared/search.ts';

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

// Every transaction takes the write lock when it begins, not at its first write: a second process waits at BEGIN
// (up to busy_timeout) instead of failing halfway through with a stale read. This is what serializes claims and appends.
class ImmediateDriver extends SqliteDriver {
  override async beginTransaction(connection: DatabaseConnection): Promise<void> { await connection.executeQuery(CompiledQuery.raw('begin immediate')); }
}
class ImmediateDialect extends SqliteDialect {
  readonly #config: ConstructorParameters<typeof SqliteDialect>[0];
  constructor(config: ConstructorParameters<typeof SqliteDialect>[0]) { super(config); this.#config = config; }
  override createDriver(): Driver { return new ImmediateDriver(this.#config); }
}

// Every term as a prefix, all required. The terms are plain words, so quoting them is all the escaping FTS5 needs.
const ftsQuery = (terms: string[]) => terms.map(term => `"${term}"*`).join(' AND ');

// With a loadable vector extension the distance is computed in the database; the vectors stay where the portable path keeps them.
function nativeVectors(db: Db): VectorPort {
  return {
    store: storeVector(db),
    async nearest(vector, model, scopes, limit, floor) {
      if (scopes.length === 0 || vector.length === 0 || limit <= 0) return [];
      const similarity = sql<number>`1 - vec_distance_cosine(embeddings.vector, ${JSON.stringify(vector)})`;
      const rows = await db.selectFrom('search_docs').innerJoin('embeddings', join => join.onRef('embeddings.doc_type', '=', 'search_docs.doc_type').onRef('embeddings.doc_id', '=', 'search_docs.doc_id'))
        .select(['search_docs.doc_type', 'search_docs.doc_id', 'search_docs.title', 'search_docs.body', 'search_docs.ref', similarity.as('similarity')]).where('embeddings.model', '=', model)
        .where(sql<boolean>`vec_length(embeddings.vector) = ${vector.length}`).where(eb => eb.or(scopes.map(scope => eb.and([eb('search_docs.scope_type', '=', scope.type), eb('search_docs.scope_id', '=', scope.id)]))))
        .where(similarity, '>=', floor).orderBy('similarity', 'desc').limit(limit).execute();
      return rows.map(row => ({ type: row.doc_type, id: row.doc_id, title: row.title, excerpt: row.body.slice(0, 240), ref: row.ref, similarity: Number(row.similarity) }));
    },
  };
}

export function createSqliteAdapter(config: { path: string; vectorExtension?: string }): StorageAdapter {
  if (config.path !== ':memory:') mkdirSync(path.dirname(path.resolve(config.path)), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(config.path, { allowExtension: Boolean(config.vectorExtension) });
  if (config.path !== ':memory:') chmodSync(config.path, 0o600);
  database.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;');
  // Optional in every sense: an extension that is missing or does not load leaves vectors on the portable path.
  let native = false;
  if (config.vectorExtension) { try { database.loadExtension(config.vectorExtension); native = true; } catch { native = false; } database.enableLoadExtension(false); }
  const db = new Kysely<Schema>({ dialect: new ImmediateDialect({ database: kyselyDatabase(database) as never }), plugins: [new BooleanColumns()] });
  return {
    dialect: 'sqlite',
    db,
    bus: createBus(),
    search: createSearch(db, terms => sql<boolean>`search_docs.seq in (select rowid from search_fts where search_fts match ${ftsQuery(terms)})`),
    ...(native ? { vectors: nativeVectors(db) } : {}),
    transaction: fn => db.transaction().execute(fn),
    // One connection behind a mutex, and every transaction begins immediate: transactions are serial within this process and across processes.
    appendLock: async (_tx: Tx) => {},
    claimLock: async (_tx: Tx) => {},
    migrate: upTo => runMigrations(db, MIGRATION_CONTEXT, upTo),
    // The online backup API copies pages under the database's own locks, so the copy is consistent and keeps its row ids.
    backup: async target => { mkdirSync(path.dirname(path.resolve(target)), { recursive: true }); await backup(database, target); chmodSync(target, 0o600); },
    async copyPlan() {
      const tables = (await sql<{ name: string; sql: string | null }>`select name, sql from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like 'kysely_%'`.execute(db)).rows;
      // A virtual table (full text, vectors) and its shadow tables are kept by SQLite itself from the rows of the tables they index.
      const virtual = tables.filter(table => /^create virtual table/i.test(table.sql ?? '')).map(table => table.name);
      const plain = tables.map(table => table.name).filter(name => !virtual.includes(name) && !virtual.some(prefix => name.startsWith(`${prefix}_`)));
      const refs = new Map<string, string[]>();
      for (const name of plain) refs.set(name, (await sql<{ table: string }>`select "table" from pragma_foreign_key_list(${name})`.execute(db)).rows.map(row => row.table));
      return inLoadOrder(plain, refs).map(name => ({ name, skip: [] }));
    },
    close: () => db.destroy(),
  };
}
