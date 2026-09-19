import { createServer, type AddressInfo } from 'node:net';
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
  // A port the system hands out, so test files running side by side never pick the same one.
  const port = await new Promise<number>((resolve, reject) => { const probe = createServer(); probe.on('error', reject); probe.listen(0, '127.0.0.1', () => { const { port: free } = probe.address() as AddressInfo; probe.close(() => resolve(free)); }); });
  const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1' });
  await server.start();
  return { available: { vector: Boolean(extension) }, config: { kind: 'postgres', url: `postgres://postgres@127.0.0.1:${port}/postgres`, poolSize: 1 }, stop: async () => { await server.stop(); await db.close(); } };
}

// The same suite against a real server: every throwaway database is a schema of its own, dropped when the test closes it.
export async function hostedForTests(url: string): Promise<{ config: StorageConfig; stop(): Promise<void> }> {
  const schema = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  return {
    config: { kind: 'postgres', url, schema, poolSize: 4 },
    stop: async () => {
      const name = 'pg', pg = await import(name);
      const client = new (pg.default?.Client ?? pg.Client)({ connectionString: url });
      await client.connect();
      try { await client.query(`drop schema if exists "${schema}" cascade`); } finally { await client.end(); }
    },
  };
}
