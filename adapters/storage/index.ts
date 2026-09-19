import type { StorageAdapter, StorageConfig } from './contract.ts';
import { createSqliteAdapter } from './sqlite/adapter.ts';

export type { Db, Tx, StorageAdapter, StorageConfig, EventBusPort } from './contract.ts';
export type { Schema } from './schema.ts';

export const STORAGE_KINDS = ['sqlite', 'postgres'] as const;

export async function createStorage(config: StorageConfig): Promise<StorageAdapter> {
  if (config.kind === 'sqlite') return createSqliteAdapter(config);
  // Loaded only when configured, so its driver stays an optional dependency.
  const { createPostgresAdapter } = await import('./postgres/adapter.ts');
  return createPostgresAdapter(config);
}
