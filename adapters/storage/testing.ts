import type { StorageConfig } from './contract.ts';

// A fresh in-process Postgres on a local socket, so the postgres adapter is exercised by the ordinary test run
// without a server or an account. It serves one connection at a time, hence the pool of one.
export async function postgresForTests(): Promise<{ config: StorageConfig; stop(): Promise<void> }> {
  const { PGlite } = await import('@electric-sql/pglite');
  const { PGLiteSocketServer } = await import('@electric-sql/pglite-socket');
  const db = await PGlite.create();
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1' });
  await server.start();
  return { config: { kind: 'postgres', url: `postgres://postgres@127.0.0.1:${port}/postgres`, poolSize: 1 }, stop: async () => { await server.stop(); await db.close(); } };
}
