import test from 'node:test';
import assert from 'node:assert/strict';
import { newId } from '@agent-team/protocol';
import { createStorage, type StorageAdapter, type StorageConfig } from './index.ts';

const configs: StorageConfig[] = [{ kind: 'sqlite', path: ':memory:' }];
if (process.env.AGENT_TEAM_TEST_PG_URL) configs.push({ kind: 'postgres', url: process.env.AGENT_TEAM_TEST_PG_URL });

async function fresh(config: StorageConfig): Promise<StorageAdapter> {
  const storage = await createStorage(config);
  await storage.migrate();
  return storage;
}

for (const config of configs) {
  test(`${config.kind}: migrations apply once and are repeatable`, async () => {
    const storage = await fresh(config);
    await storage.migrate();
    assert.deepEqual(await storage.db.selectFrom('users').selectAll().execute(), []);
    await storage.close();
  });

  test(`${config.kind}: foreign keys and unique constraints hold`, async () => {
    const storage = await fresh(config);
    await assert.rejects(storage.db.insertInto('sessions').values({ id: newId(), user_id: newId(), token_hash: 'x', created_at: 1, expires_at: 2, last_seen_at: 1, revoked_at: null }).execute());
    const user = { id: newId(), email: 'a@example.com', name: 'A', password_hash: null, org_role: 'owner', status: 'active', created_at: 1, last_login_at: null };
    await storage.db.insertInto('users').values(user).execute();
    await assert.rejects(storage.db.insertInto('users').values({ ...user, id: newId() }).execute());
    await storage.close();
  });

  test(`${config.kind}: booleans and generated sequences round-trip`, async () => {
    const storage = await fresh(config);
    const teamId = newId();
    await storage.db.insertInto('teams').values({ id: teamId, scope: 'org', project_id: null, name: 'T', template_slug: null, template_version: null }).execute();
    await storage.db.insertInto('agents').values({ id: newId(), team_id: teamId, name: 'Maren', initials: 'MA', tint: '1', title: 'PM', persona: '', status: 'active', provider_id: null, model: null, daily_cap_minor: null, is_pm: true, doing: null, sort: 0, created_at: 1 }).execute();
    const agent = await storage.db.selectFrom('agents').select(['is_pm']).executeTakeFirstOrThrow();
    assert.equal(agent.is_pm, true);
    const event = { at: 1, type: 'a.b', category: 'domain', project_id: null, subproject_id: null, agent_id: null, user_id: null, task_id: null, thread_id: null, turn_id: null, actor_kind: 'system', payload: '{}', idempotency_key: null };
    const first = await storage.db.insertInto('events').values({ ...event, id: newId() }).returning('seq').executeTakeFirstOrThrow();
    const second = await storage.db.insertInto('events').values({ ...event, id: newId() }).returning('seq').executeTakeFirstOrThrow();
    assert.ok(Number(second.seq) > Number(first.seq));
    await storage.close();
  });

  test(`${config.kind}: a failed transaction leaves nothing behind`, async () => {
    const storage = await fresh(config);
    await assert.rejects(storage.transaction(async tx => {
      await storage.appendLock(tx);
      await tx.insertInto('setup_tokens').values({ token_hash: 'h', expires_at: 1, used_at: null }).execute();
      throw new Error('abort');
    }));
    assert.equal((await storage.db.selectFrom('setup_tokens').selectAll().execute()).length, 0);
    await storage.close();
  });
}
