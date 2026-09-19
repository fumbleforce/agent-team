import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sql } from 'kysely';
import { newId } from '@agent-team/protocol';
import { createStorage, type StorageAdapter, type StorageConfig } from './index.ts';
import { postgresForTests } from './testing.ts';

// Postgres runs in-process, a fresh database per test; AGENT_TEAM_TEST_PG_URL points the same suite at a real server instead.
const configs: StorageConfig[] = [{ kind: 'sqlite', path: ':memory:' }, { kind: 'postgres', url: process.env.AGENT_TEAM_TEST_PG_URL ?? '' }];

async function fresh(config: StorageConfig, options: { upTo?: string; vector?: boolean } = {}): Promise<StorageAdapter & { url: string | null; hasVector: boolean }> {
  const local = config.kind === 'postgres' && !config.url ? await postgresForTests(options.vector ? { vector: true } : {}) : null;
  const used = local?.config ?? config;
  const storage = await createStorage(used);
  await storage.migrate(options.upTo);
  return { ...storage, url: used.kind === 'postgres' ? used.url : null, hasVector: local?.available.vector ?? false, close: async () => { await storage.close(); await local?.stop(); } };
}
const project = { type: 'project', id: 'p1' }, elsewhere = { type: 'project', id: 'p2' };

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

  test(`${config.kind}: search matches every term from the start of a word, ranks title hits first and stays inside its scopes`, async () => {
    const storage = await fresh(config);
    const ids = [newId(1), newId(2), newId(3), newId(4), newId(5)] as const;
    await storage.search.index({ type: 'page', id: ids[0], scope: project, title: 'Webhooks v2', body: 'Signature verification for the v2 payload.' });
    await storage.search.index({ type: 'memory', id: ids[1], scope: project, title: 'Retries', body: 'The webhook payload is signed again on every retry.' });
    await storage.search.index({ type: 'message', id: ids[2], scope: project, title: '#checkout', body: 'Déjà vu: the PAYLOAD-size limit is 1.5 MB, see user@example.com', ref: 'thread-1' });
    await storage.search.index({ type: 'issue', id: ids[3], scope: project, title: '#7 Pay button hangs', body: 'Stays on Processing.', ref: 'thread-2' });
    await storage.search.index({ type: 'page', id: ids[4], scope: elsewhere, title: 'Webhooks elsewhere', body: 'Not yours: payload.' });
    const found = async (q: string, scopes = [project], limit = 10) => (await storage.search.query(q, scopes, limit)).map(hit => `${hit.type}:${hit.title}`);

    // The title hit leads; among equals the newest document comes first.
    assert.deepEqual(await found('webhook payload'), ['page:Webhooks v2', 'memory:Retries']);
    assert.deepEqual(await found('payload'), ['message:#checkout', 'memory:Retries', 'page:Webhooks v2']);
    assert.deepEqual(await found('payload', [project], 1), ['message:#checkout']);
    // A term is the start of a word, never its middle or end; every term is required.
    assert.deepEqual(await found('hooks'), []);
    assert.deepEqual(await found('webhooks unicorn'), []);
    assert.deepEqual(await found('SIGN'), ['memory:Retries', 'page:Webhooks v2']);
    // Accents fold, punctuation separates, and nothing in a query is syntax.
    assert.deepEqual(await found('deja'), ['message:#checkout']);
    assert.deepEqual(await found('payload-size "example" OR (com) *'), []);
    assert.deepEqual(await found('payload-size "example" (com) *'), ['message:#checkout']);
    assert.deepEqual(await found("v2 ' & | ! :*"), ['page:Webhooks v2']);
    assert.deepEqual(await found('a ! *'), []);
    assert.deepEqual(await found('webhooks', [elsewhere]), ['page:Webhooks elsewhere']);
    assert.deepEqual(await found('webhooks', []), []);
    assert.deepEqual((await storage.search.query('hangs', [project], 5))[0], { type: 'issue', id: ids[3], title: '#7 Pay button hangs', excerpt: 'Stays on Processing.', ref: 'thread-2' });

    // Indexing again replaces; removing forgets; a rolled-back transaction indexes nothing.
    await storage.search.index({ type: 'page', id: ids[0], scope: project, title: 'Callbacks v2', body: 'Renamed.' });
    assert.deepEqual([await found('webhooks'), await found('callb')], [[], ['page:Callbacks v2']]);
    await storage.search.remove({ type: 'page', id: ids[0] });
    assert.deepEqual(await found('callbacks'), []);
    await assert.rejects(storage.transaction(async tx => { await storage.search.index({ type: 'page', id: newId(), scope: project, title: 'Phantom', body: '' }, tx); throw new Error('abort'); }));
    assert.deepEqual(await found('phantom'), []);
    await storage.close();
  });

  test(`${config.kind}: documents indexed before the native index existed are kept and found`, async () => {
    const storage = await fresh(config, { upTo: '0021_sync' });
    await sql`insert into search_docs (doc_type, doc_id, scope_type, scope_id, title, body) values ('page', 'old-1', 'project', 'p1', 'Idempotency in checkout', 'Key on mount.')`.execute(storage.db);
    await storage.migrate();
    assert.deepEqual((await storage.search.query('idem mount', [project], 5)).map(hit => hit.id), ['old-1']);
    await storage.search.remove({ type: 'page', id: 'old-1' });
    assert.deepEqual(await storage.search.query('idempotency', [project], 5), []);
    await storage.close();
  });

  test(`${config.kind}: the vector port is optional, and search works without it`, async () => {
    const storage = await fresh(config);
    assert.equal(storage.vectors, undefined);
    await storage.search.index({ type: 'page', id: newId(), scope: project, title: 'Release steps', body: 'Cut the version and deploy it.' });
    assert.deepEqual((await storage.search.query('release', [project], 5)).map(hit => hit.title), ['Release steps']);
    await storage.close();
  });

  test(`${config.kind}: concurrent claims never hand out the same item`, async () => {
    const storage = await fresh(config);
    const items = Array.from({ length: 5 }, (_, index) => `item-${index}`);
    await storage.db.insertInto('setup_tokens').values(items.map(item => ({ token_hash: item, expires_at: 1, used_at: null }))).execute();
    const claim = (claimant: number) => storage.transaction(async tx => {
      await storage.claimLock(tx);
      const next = await tx.selectFrom('setup_tokens').select('token_hash').where('used_at', 'is', null).orderBy('token_hash').executeTakeFirst();
      await new Promise(resolve => setImmediate(resolve));
      if (next) await tx.updateTable('setup_tokens').set({ used_at: claimant }).where('token_hash', '=', next.token_hash).execute();
      return next?.token_hash ?? null;
    });
    const claimed = await Promise.all(Array.from({ length: 8 }, (_, index) => claim(index + 1)));
    assert.deepEqual(claimed.filter(Boolean).sort(), items);
    assert.equal(claimed.filter(item => item === null).length, 3);
    await storage.close();
  });
}

// Two or more processes on one database file, each claiming until nothing is left. With a deferred BEGIN the second writer fails on its
// stale read; beginning immediate makes it wait its turn instead.
test('sqlite: claims from separate processes are serialized by the database', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-team-claim-')), file = path.join(dir, 'claims.sqlite');
  const storage = await createStorage({ kind: 'sqlite', path: file });
  await storage.migrate();
  const items = Array.from({ length: 40 }, (_, index) => `item-${String(index).padStart(2, '0')}`);
  await storage.db.insertInto('setup_tokens').values(items.map(item => ({ token_hash: item, expires_at: 1, used_at: null }))).execute();
  const script = `
    const { createStorage } = await import(${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, 'index.ts')).href)});
    const storage = await createStorage({ kind: 'sqlite', path: ${JSON.stringify(file)} }), mine = [];
    for (;;) {
      const item = await storage.transaction(async tx => {
        await storage.claimLock(tx);
        const next = await tx.selectFrom('setup_tokens').select('token_hash').where('used_at', 'is', null).orderBy('token_hash').executeTakeFirst();
        await new Promise(resolve => setTimeout(resolve, 1));
        if (next) await tx.updateTable('setup_tokens').set({ used_at: process.pid }).where('token_hash', '=', next.token_hash).execute();
        return next?.token_hash ?? null;
      });
      if (!item) break;
      mine.push(item);
    }
    await storage.close();
    console.log(JSON.stringify(mine));`;
  const run = () => new Promise<string[]>((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('close', code => (code === 0 ? resolve(JSON.parse(out) as string[]) : reject(new Error(err))));
  });
  const claimed = await Promise.all([run(), run(), run()]);
  assert.deepEqual(claimed.flat().sort(), items);
  await storage.close();
  rmSync(dir, { recursive: true, force: true });
});

test('sqlite: a backup taken while the database is open is a complete database, search index included', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-team-backup-')), copy = path.join(dir, 'nested', 'copy.sqlite');
  const storage = await createStorage({ kind: 'sqlite', path: path.join(dir, 'live.sqlite') });
  await storage.migrate();
  await storage.search.index({ type: 'page', id: 'page-1', scope: project, title: 'Runbook', body: 'Restore from the nightly copy.' });
  await storage.backup!(copy);
  await storage.search.index({ type: 'page', id: 'page-2', scope: project, title: 'Later', body: 'Written after the copy: nightly.' });
  assert.ok(existsSync(copy));
  const restored = await createStorage({ kind: 'sqlite', path: copy });
  await restored.migrate();
  assert.deepEqual((await restored.search.query('nightly', [project], 5)).map(hit => hit.id), ['page-1']);
  assert.deepEqual((await storage.search.query('nightly', [project], 5)).map(hit => hit.id), ['page-2', 'page-1']);
  await restored.close();
  await storage.close();
  rmSync(dir, { recursive: true, force: true });
});

test('sqlite: a vector extension that does not load leaves everything as it was', async () => {
  const storage = await createStorage({ kind: 'sqlite', path: ':memory:', vectorExtension: path.join(tmpdir(), 'no-such-extension') });
  await storage.migrate();
  assert.equal(storage.vectors, undefined);
  await storage.search.index({ type: 'page', id: 'page-1', scope: project, title: 'Runbook', body: '' });
  assert.equal((await storage.search.query('run', [project], 5)).length, 1);
  await storage.close();
});

test('postgres: with the vector extension installed the adapter compares vectors in the database', async t => {
  const storage = await fresh({ kind: 'postgres', url: '' }, { vector: true });
  if (!storage.hasVector || !storage.vectors) { await storage.close(); t.skip('the in-process database has no vector extension here'); return; }
  await storage.search.index({ type: 'page', id: 'pay', scope: project, title: 'Checkout flow', body: '' });
  await storage.search.index({ type: 'page', id: 'ship', scope: project, title: 'Release steps', body: '' });
  await storage.search.index({ type: 'page', id: 'theirs', scope: elsewhere, title: 'Their checkout', body: '' });
  await storage.vectors.store({ type: 'page', id: 'pay' }, 'toy', [1, 0]);
  await storage.vectors.store({ type: 'page', id: 'ship' }, 'toy', [1, 0]);
  await storage.vectors.store({ type: 'page', id: 'theirs' }, 'toy', [1, 0]);
  await storage.vectors.store({ type: 'page', id: 'ship' }, 'toy', [0.1, 1]);
  const near = await storage.vectors.nearest([1, 0.1], 'toy', [project], 5, 0.6);
  assert.deepEqual(near.map(hit => hit.id), ['pay']);
  assert.ok(near[0]!.similarity > 0.9);
  assert.deepEqual(await storage.vectors.nearest([1, 0.1], 'other-model', [project], 5, 0.6), []);
  assert.deepEqual(await storage.vectors.nearest([1, 0, 0], 'toy', [project], 5, 0.6), []);
  await storage.close();
});

test('postgres: with listen, a second process hears what the first one appended', async t => {
  const first = await fresh({ kind: 'postgres', url: process.env.AGENT_TEAM_TEST_PG_URL ?? '' });
  // The in-process database serves one connection, and a listener needs its own.
  const { default: pg } = await import('pg');
  const probe = new pg.Client({ connectionString: first.url! });
  probe.on('error', () => {});
  const second = await probe.connect().then(() => true, () => false);
  await probe.end().catch(() => {});
  if (!second) { await first.close(); t.skip('this database serves one connection at a time'); return; }
  const [a, b] = await Promise.all([createStorage({ kind: 'postgres', url: first.url!, listen: true }), createStorage({ kind: 'postgres', url: first.url!, listen: true })]);
  const heard: number[] = [], own: number[] = [];
  b.bus.subscribe(seq => heard.push(seq));
  a.bus.subscribe(seq => own.push(seq));
  await new Promise(resolve => setTimeout(resolve, 500));
  a.bus.notify(41);
  for (let waited = 0; heard.length === 0 && waited < 5000; waited += 50) await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual([heard, own], [[41], [41]]);
  await a.close();
  await b.close();
  await first.close();
});
