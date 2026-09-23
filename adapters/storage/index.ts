import type { StorageAdapter, StorageConfig } from './contract.ts';
import { createSqliteAdapter } from './sqlite/adapter.ts';

export type { Db, Tx, StorageAdapter, StorageConfig, EventBusPort, SearchDoc, SearchHit, SearchPort, SearchScope, VectorPort } from './contract.ts';
export { portableVectors } from './shared/search.ts';
export { copyDatabase } from './shared/copy.ts';
export type { Schema } from './schema.ts';

export const STORAGE_KINDS = ['sqlite', 'postgres'] as const;

export async function createStorage(config: StorageConfig): Promise<StorageAdapter> {
  // `npm run test:postgres` reruns the whole suite on the other adapter: every throwaway in-memory database becomes a throwaway Postgres.
  if (config.kind === 'sqlite' && config.path === ':memory:' && process.env.AGENT_TEAM_TEST_STORAGE === 'postgres') {
    const { postgresForTests, hostedForTests } = await import('./testing.ts');
    // With AGENT_TEAM_TEST_PG_URL the throwaway database is a schema of its own on that real server instead.
    const local = process.env.AGENT_TEAM_TEST_PG_URL ? await hostedForTests(process.env.AGENT_TEAM_TEST_PG_URL) : await postgresForTests(), storage = await createStorage(local.config);
    return { ...storage, close: async () => { await storage.close(); await local.stop(); } };
  }
  if (config.kind === 'sqlite') return createSqliteAdapter(config);
  // Loaded only when configured, so its driver stays an optional dependency.
  const { createPostgresAdapter } = await import('./postgres/adapter.ts');
  return createPostgresAdapter(config);
}
