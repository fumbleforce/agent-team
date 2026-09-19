import type { ColumnDataType, ColumnDefinitionBuilder, Kysely, Transaction } from 'kysely';
import type { Schema } from './schema.ts';

export type Db = Kysely<Schema>;
export type Tx = Transaction<Schema>;

// What a migration needs to know about the dialect it runs on.
export interface MigrationContext {
  dialect: 'sqlite' | 'postgres';
  booleanType: ColumnDataType;
  serialType: ColumnDataType;
  serialColumn(column: ColumnDefinitionBuilder): ColumnDefinitionBuilder;
}

export interface EventBusPort {
  notify(seq: number): void;
  subscribe(listener: (seq: number) => void): () => void;
}

// What search holds about one document. `ref` is where a hit leads when it is not a thing of its own: the thread of a message or an issue.
export interface SearchScope { type: string; id: string }
export interface SearchDoc { type: string; id: string; scope: SearchScope; title: string; body: string; ref?: string | null }
export interface SearchHit { type: string; id: string; title: string; excerpt: string; ref: string | null }

// Lexical search, the same on every dialect: a query is cut into terms, every term must start a word of the title or body,
// and hits are ordered by how many terms the title holds, then newest first. Only the index that finds the candidates is native.
export interface SearchPort {
  // Inside a transaction pass its handle: the document is indexed with the change that made it.
  index(doc: SearchDoc, via?: Db): Promise<void>;
  remove(doc: { type: string; id: string }, via?: Db): Promise<void>;
  query(q: string, scopes: SearchScope[], limit: number): Promise<SearchHit[]>;
}

// Semantic search over the same documents. A dialect sets `vectors` on its adapter when it has a native index;
// without one, `portableVectors` keeps vectors in a plain table and compares them in the process.
export interface VectorPort {
  store(doc: { type: string; id: string }, model: string, vector: number[]): Promise<void>;
  // Nearest first, of the same model and scopes, at or above the similarity floor (cosine, 0 to 1).
  nearest(vector: number[], model: string, scopes: SearchScope[], limit: number, floor: number): Promise<(SearchHit & { similarity: number })[]>;
}

export interface StorageAdapter {
  dialect: 'sqlite' | 'postgres';
  db: Db;
  bus: EventBusPort;
  search: SearchPort;
  vectors?: VectorPort;
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  // Held to the end of the transaction; makes event seq order equal commit order.
  appendLock(tx: Tx): Promise<void>;
  // Held to the end of the transaction; two claims never read the same queue at once.
  claimLock(tx: Tx): Promise<void>;
  // Up to date by default. Naming a migration stops there, for tests of what a later one does to existing rows.
  migrate(upTo?: string): Promise<void>;
  // A consistent copy of the whole database in one file, taken while it is in use. Only where the database is a file.
  backup?(path: string): Promise<void>;
  close(): Promise<void>;
}

export type StorageConfig =
  // `vectorExtension` is the path of a loadable vector extension; when it does not load, vectors stay portable.
  | { kind: 'sqlite'; path: string; vectorExtension?: string }
  // `listen` opens one more, direct connection that hears the events other coordinator processes append (and tells them of ours).
  | { kind: 'postgres'; url: string; poolSize?: number; schema?: string; listen?: boolean };
