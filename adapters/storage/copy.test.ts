import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createContext } from '../../packages/coordinator/src/context.ts';
import { seedDemo } from '../../packages/coordinator/src/demo/seed.ts';
import { createSqliteAdapter } from './sqlite/adapter.ts';
import { copyDatabase, createStorage, type StorageAdapter } from './index.ts';
import { postgresForTests } from './testing.ts';

// A coordinator moves to another database, of the same dialect or the other: every row comes along, booleans and numbers as the target
// keeps them, counters continue past what was copied, and search works on the copy because the target rebuilt its own index.
test('the whole of a coordinator\'s database is copied into an empty one of either dialect', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-team-copy-'));
  const source = createSqliteAdapter({ path: path.join(dir, 'source.sqlite') });
  await source.migrate();
  await seedDemo(createContext({ storage: source, machineToken: 'x'.repeat(24), dataDir: dir }));
  const count = async (storage: StorageAdapter, table: string) => Number((await (storage.db as never as { selectFrom(t: string): { select(f: unknown): { executeTakeFirstOrThrow(): Promise<{ n: number }> } } }).selectFrom(table).select((eb: { fn: { countAll(): { as(n: string): unknown } } }) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n);
  const pg = await postgresForTests();
  try {
    for (const target of [createSqliteAdapter({ path: path.join(dir, 'target.sqlite') }), await createStorage(pg.config)]) {
      await target.migrate();
      const copied = await copyDatabase(source, target);
      assert.ok(copied > 100, `${target.dialect}: a demo organization is more than a hundred rows`);
      for (const table of ['projects', 'agents', 'tasks', 'events', 'messages', 'memories', 'search_docs', 'cost_entries']) assert.equal(await count(target, table), await count(source, table), `${target.dialect}: ${table}`);
      const pm = await target.db.selectFrom('agents').select('is_pm').where('name', '=', 'Maren').executeTakeFirstOrThrow();
      assert.equal(Boolean(pm.is_pm), true);
      // A new event continues the numbering after the copied ones.
      const last = await target.db.selectFrom('events').select(eb => eb.fn.max('seq').as('seq')).executeTakeFirstOrThrow();
      await target.db.insertInto('events').values({ id: `after-${target.dialect}`, at: 1, type: 'test.after', category: 'test', project_id: null, subproject_id: null, agent_id: null, user_id: null, task_id: null, thread_id: null, turn_id: null, actor_kind: 'system', payload: '{}' } as never).execute();
      const added = await target.db.selectFrom('events').select('seq').where('id', '=', `after-${target.dialect}`).executeTakeFirstOrThrow();
      assert.ok(Number(added.seq) > Number(last.seq));
      const project = await target.db.selectFrom('projects').select('id').where('slug', '=', 'checkout-v2').executeTakeFirstOrThrow();
      assert.ok((await target.search.query('safari', [{ type: 'subproject', id: project.id }], 5)).length > 0, `${target.dialect}: search works on the copy`);
      await assert.rejects(copyDatabase(source, target), /not empty/, 'a database with rows is never copied into');
      await target.close();
    }
  } finally { await source.close(); await pg.stop(); }
});
