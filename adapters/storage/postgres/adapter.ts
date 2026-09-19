import { Kysely, PostgresDialect, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import type { Db, MigrationContext, StorageAdapter, VectorPort } from '../contract.ts';
import type { Schema } from '../schema.ts';
import { createBus } from '../shared/bus.ts';
import { runMigrations } from '../shared/migrate.ts';
import { createSearch } from '../shared/search.ts';
import { CHANNEL, createSharedBus, type ListenerClient } from './bus.ts';

const MIGRATION_CONTEXT: MigrationContext = {
  dialect: 'postgres',
  booleanType: 'boolean',
  serialType: 'bigserial',
  serialColumn: column => column.primaryKey(),
};
const APPEND_LOCK = 4310, CLAIM_LOCK = 4311;

// Every term as a prefix, all required. The terms are plain words, and the cast reads them as they are, without the text-search parser.
const tsQuery = (terms: string[]) => terms.map(term => `'${term}':*`).join(' & ');

// Used when the database already has the vector extension installed (`create extension vector` is the owner's call); never required. Vectors of any length share one column, so the scan is exact
// rather than indexed, which is the same work the portable path does, done in the database. What the portable path stored is carried over.
async function nativeVectors(db: Db): Promise<VectorPort | undefined> {
  try {
    const installed = await sql`select 1 from pg_extension where extname = 'vector'`.execute(db);
    if (installed.rows.length === 0) return undefined;
    await sql`create table if not exists embedding_vectors (doc_type text not null, doc_id text not null, model text not null, vec vector not null, primary key (doc_type, doc_id))`.execute(db);
  } catch { return undefined; }
  let carried = false;
  const carry = async () => {
    if (carried) return;
    // The portable table appears with the migrations, which may run after this adapter was created.
    await sql`insert into embedding_vectors (doc_type, doc_id, model, vec) select doc_type, doc_id, model, vector::vector from embeddings on conflict do nothing`.execute(db).then(() => { carried = true; }, () => {});
  };
  return {
    async store(doc, model, vector) {
      await carry();
      await sql`insert into embedding_vectors (doc_type, doc_id, model, vec) values (${doc.type}, ${doc.id}, ${model}, ${JSON.stringify(vector)}::vector) on conflict (doc_type, doc_id) do update set model = excluded.model, vec = excluded.vec`.execute(db);
    },
    async nearest(vector, model, scopes, limit, floor) {
      if (scopes.length === 0 || vector.length === 0 || limit <= 0) return [];
      await carry();
      const target = JSON.stringify(vector), inScope = sql.join(scopes.map(scope => sql`(d.scope_type = ${scope.type} and d.scope_id = ${scope.id})`), sql` or `);
      const found = await sql<{ doc_type: string; doc_id: string; title: string; body: string; ref: string | null; similarity: number }>`
        select * from (select d.doc_type, d.doc_id, d.title, d.body, d.ref, 1 - (v.vec <=> ${target}::vector) as similarity
          from embedding_vectors v join search_docs d on d.doc_type = v.doc_type and d.doc_id = v.doc_id
          where v.model = ${model} and vector_dims(v.vec) = ${vector.length} and (${inScope})) nearest
        where similarity >= ${floor} order by similarity desc limit ${limit}`.execute(db);
      return found.rows.map(row => ({ type: row.doc_type, id: row.doc_id, title: row.title, excerpt: row.body.slice(0, 240), ref: row.ref, similarity: Number(row.similarity) }));
    },
  };
}

export async function createPostgresAdapter(config: { url: string; poolSize?: number; listen?: boolean }): Promise<StorageAdapter> {
  const name = 'pg';
  const pg = await import(name).catch(() => { throw new Error('The postgres storage adapter needs the "pg" package: npm install pg'); });
  const Pool = pg.default?.Pool ?? pg.Pool, Client = pg.default?.Client ?? pg.Client;
  // bigint columns are millisecond timestamps and sequence numbers, all within the safe integer range.
  (pg.default?.types ?? pg.types).setTypeParser(20, (value: string) => Number(value));
  const db = new Kysely<Schema>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: config.url, ...(config.poolSize ? { max: config.poolSize } : {}) }) }) });
  // Without `listen` this process is the only one appending, and in-process fan-out is the whole bus.
  const shared = config.listen ? createSharedBus({
    origin: randomUUID(),
    connect: async () => { const client = new Client({ connectionString: config.url, connectionTimeoutMillis: 10_000 }); client.on('error', () => {}); await client.connect(); return client as ListenerClient; },
    send: async payload => { await sql`select pg_notify(${CHANNEL}, ${payload})`.execute(db); },
  }) : null;
  const vectors = await nativeVectors(db);
  return {
    dialect: 'postgres',
    db,
    bus: shared ?? createBus(),
    search: createSearch(db, terms => sql<boolean>`search_docs.tsv @@ ${tsQuery(terms)}::tsquery`),
    ...(vectors ? { vectors } : {}),
    transaction: fn => db.transaction().execute(fn),
    appendLock: async tx => { await sql`select pg_advisory_xact_lock(${APPEND_LOCK})`.execute(tx); },
    // Taken before the queue is read, and always before the append lock, so the two never wait on each other.
    claimLock: async tx => { await sql`select pg_advisory_xact_lock(${CLAIM_LOCK})`.execute(tx); },
    migrate: upTo => runMigrations(db, MIGRATION_CONTEXT, upTo),
    close: async () => { await shared?.stop(); await db.destroy(); },
  };
}
