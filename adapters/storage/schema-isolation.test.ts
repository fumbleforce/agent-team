import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { createStorage } from './index.ts';
import { postgresForTests } from './testing.ts';

test('postgres: a named schema holds the whole deployment and leaves the rest of the database alone', async () => {
  const local = await postgresForTests();
  try {
    assert.equal(local.config.kind, 'postgres');
    const storage = await createStorage({ ...local.config, schema: 'team_a' } as typeof local.config);
    await storage.migrate();
    await storage.db.insertInto('setup_tokens').values({ token_hash: 'h', expires_at: 1, used_at: null }).execute();
    const where = await sql<{ table_schema: string }>`select table_schema from information_schema.tables where table_name = 'setup_tokens'`.execute(storage.db);
    assert.deepEqual(where.rows.map(row => row.table_schema), ['team_a']);
    await storage.close();
    await assert.rejects(createStorage({ ...local.config, schema: 'Bad-Name"; drop' } as typeof local.config), /schema name/);
  } finally { await local.stop(); }
});
