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

export interface StorageAdapter {
  dialect: 'sqlite' | 'postgres';
  db: Db;
  bus: EventBusPort;
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  // Held to the end of the transaction; makes event seq order equal commit order.
  appendLock(tx: Tx): Promise<void>;
  migrate(): Promise<void>;
  close(): Promise<void>;
}

export type StorageConfig = { kind: 'sqlite'; path: string } | { kind: 'postgres'; url: string; poolSize?: number };
