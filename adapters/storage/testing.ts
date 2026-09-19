import type { StorageConfig } from './contract.ts';

// A fresh in-process Postgres on a local socket, so the postgres adapter is exercised by the ordinary test run
// without a server or an account. It serves one connection at a time, hence the pool of one.
// `vector` installs the vector extension when the package that carries it is around; `available.vector` says whether it was.
export async function postgresForTests(options: { vector?: boolean } = {}): Promise<{ config: StorageConfig; available: { vector: boolean }; stop(): Promise<void> }> {
  const { PGlite } = await import('@electric-sql/pglite');
  const { PGLiteSocketServer } = await import('@electric-sql/pglite-socket');
  const carrier = '@electric-sql/pglite-pgvector';
  const extension = options.vector ? await import(carrier).then(module => module.vector as never, () => null) : null;
  const db = await PGlite.create(extension ? { extensions: { vector: extension } } : {});
  if (extension) await db.exec('create extension if not exists vector');
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1' });
  await server.start();
  return { available: { vector: Boolean(extension) }, config: { kind: 'postgres', url: `postgres://postgres@127.0.0.1:${port}/postgres`, poolSize: 1 }, stop: async () => { await server.stop(); await db.close(); } };
}
