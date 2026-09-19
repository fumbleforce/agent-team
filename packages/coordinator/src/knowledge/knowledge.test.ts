import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '@agent-team/storage';
import { createContext } from '../context.ts';
import { createKnowledge, type Scope } from './knowledge.ts';

async function boot() {
  const storage = await createStorage({ kind: 'sqlite', path: ':memory:' });
  await storage.migrate();
  return { storage, knowledge: createKnowledge(createContext({ storage, machineToken: 'x'.repeat(24) })) };
}
const project: Scope = { type: 'project', id: 'p1' };
const ada = { kind: 'agent' as const, id: 'ada' };

test('pages keep append-only revisions, refuse stale edits and count readers', async () => {
  const { storage, knowledge } = await boot();
  const first = await knowledge.write(ada, { scope: project, path: 'payments/idempotency.md', title: 'Idempotency in checkout', body: 'Key on mount.' });
  const second = await knowledge.write(ada, { scope: project, path: 'payments/idempotency.md', title: 'Idempotency in checkout', body: 'Key on mount. 409 means the order exists.', expectedRev: 1 });
  assert.deepEqual([first.rev, second.rev, second.id], [1, 2, first.id]);
  await assert.rejects(knowledge.write(ada, { scope: project, path: 'payments/idempotency.md', title: 'x', body: 'y', expectedRev: 1 }), /revision 2/);
  await assert.rejects(knowledge.write(ada, { scope: project, path: '../escape.md', title: 'x', body: 'y' }), /path/);
  await knowledge.read(first.id, { agentId: 'bram', turnId: null });
  await knowledge.read(first.id, { agentId: 'bram', turnId: null });
  const page = await knowledge.read(first.id, { agentId: 'cleo', turnId: null });
  assert.deepEqual([page.rev, page.readByToday], [2, 2]);
  assert.equal((await knowledge.history(first.id)).length, 2);
  assert.deepEqual((await knowledge.tree(project)).map(item => item.path), ['payments/idempotency.md']);
  await storage.close();
});

test('search is scoped and needs every term; memories are promoted and assembled under a cap', async () => {
  const { storage, knowledge } = await boot();
  await knowledge.write(ada, { scope: project, path: 'payments/webhooks.md', title: 'Webhooks v2', body: 'Signature verification for the v2 payload.' });
  await knowledge.write(ada, { scope: { type: 'project', id: 'other' }, path: 'secret.md', title: 'Webhooks elsewhere', body: 'Not yours.' });
  const memory = await knowledge.fileMemory({ scope: project, agentId: 'bram', type: 'gotcha', title: 'Safari keeps fetch pending', body: 'Pair fetch with AbortController after network loss.' });
  assert.deepEqual((await knowledge.search([project], 'webhooks payload')).map(hit => hit.title), ['Webhooks v2']);
  assert.equal((await knowledge.search([project], 'webhooks unicorn')).length, 0);
  assert.equal((await knowledge.search([project], 'safari'))[0]?.type, 'memory');

  assert.equal((await knowledge.assemble([project], 1000)).memoryIds.length, 0);
  await knowledge.setMemoryStatus(memory, 'confirmed');
  assert.equal((await knowledge.assemble([project], 5)).memoryIds.length, 0);
  const assembled = await knowledge.assemble([project], 1000);
  assert.deepEqual(assembled.memoryIds, [memory]);
  assert.match(assembled.text, /AbortController/);

  const page = await knowledge.promote(ada, memory, 'frontend/safari-fetch.md');
  assert.equal(page.rev, 1);
  assert.equal((await knowledge.memories(project)).length, 0);
  await storage.close();
});

test('history names who wrote what, a diff is computed between revisions, and restoring writes a new revision', async () => {
  const { storage, knowledge } = await boot();
  try {
    await storage.db.insertInto('users').values({ id: 'u1', email: 'jo@example.com', name: 'Jo', password_hash: null, org_role: 'owner', status: 'active', created_at: 1, last_login_at: null }).execute();
    const jo = { kind: 'user' as const, id: 'u1' };
    const page = await knowledge.write(ada, { scope: project, path: 'ops/deploy.md', title: 'Deploy', body: ['Cut the branch.', 'Run the checks.', 'Deploy at four.'].join('\n') });
    await knowledge.write(jo, { scope: project, path: 'ops/deploy.md', title: 'Deploy', body: ['Cut the branch.', 'Run the checks twice.', 'Deploy at four.', 'Tell support.'].join('\n'), note: 'Support asked to be told', expectedRev: 1 });

    const diff = await knowledge.diff(page.id, 1);
    assert.deepEqual([diff.from, diff.to, diff.added, diff.removed], [1, 2, 2, 1]);
    assert.match(diff.text, /^diff --git a\/ops\/deploy\.md b\/ops\/deploy\.md/);
    assert.match(diff.text, /@@ -1,3 \+1,4 @@/);
    assert.ok(diff.text.includes('-Run the checks.') && diff.text.includes('+Run the checks twice.') && diff.text.includes('+Tell support.'));
    assert.equal((await knowledge.diff(page.id, 2)).text, '');

    const restored = await knowledge.restore(jo, page.id, 1);
    assert.equal(restored.rev, 3);
    assert.equal((await knowledge.read(page.id)).body, 'Cut the branch.\nRun the checks.\nDeploy at four.');
    assert.deepEqual((await knowledge.historyView(page.id)).map(item => [item.rev, item.author, item.note, item.current]), [[3, 'Jo', 'Restored version 1', true], [2, 'Jo', 'Support asked to be told', false], [1, 'An agent', null, false]]);
    await assert.rejects(knowledge.revision(page.id, 9), /not found/i);
  } finally { await storage.close(); }
});

test('a version kept beside the current one waits until someone keeps theirs or takes it', async () => {
  const { storage, knowledge } = await boot();
  try {
    const sync = { kind: 'system' as const, id: 'folder-sync' };
    const page = await knowledge.write(ada, { scope: project, path: 'style/voice.md', title: 'Voice', body: 'Plain words.' });
    await knowledge.writeSibling(sync, page.id, { body: 'Plain words, short sentences.' });
    const waiting = (await knowledge.historyView(page.id)).filter(item => item.waiting);
    assert.deepEqual(waiting.map(item => [item.rev, item.author]), [[2, 'The document folder']]);
    assert.equal((await knowledge.read(page.id)).body, 'Plain words.');

    const taken = await knowledge.resolveSibling(ada, page.id, 2, 'theirs');
    assert.equal(taken.rev, 3);
    assert.equal((await knowledge.read(page.id)).body, 'Plain words, short sentences.');
    assert.equal((await knowledge.historyView(page.id)).filter(item => item.waiting).length, 0);
    await assert.rejects(knowledge.resolveSibling(ada, page.id, 2, 'mine'), /already/);

    await knowledge.writeSibling(sync, page.id, { body: 'Shouting.' });
    await knowledge.resolveSibling(ada, page.id, 4, 'mine');
    assert.equal((await knowledge.read(page.id)).body, 'Plain words, short sentences.');
    assert.equal((await knowledge.history(page.id)).length, 5);
  } finally { await storage.close(); }
});

test('a memory nobody used for sixty days goes stale, stops being injected, and a person can say it still holds', async () => {
  const storage = await createStorage({ kind: 'sqlite', path: ':memory:' });
  try {
    await storage.migrate();
    const DAY = 24 * 3600_000;
    let clock = 1_000 * DAY;
    const knowledge = createKnowledge(createContext({ storage, machineToken: 'x'.repeat(24), now: () => clock }));
    const used = await knowledge.fileMemory({ scope: project, agentId: 'bram', type: 'gotcha', title: 'Safari keeps fetch pending', body: 'Pair fetch with AbortController.' });
    const unused = await knowledge.fileMemory({ scope: project, agentId: 'cleo', type: 'observation', title: 'Staging is slow on Mondays', body: 'The nightly import runs long.' });
    await knowledge.setMemoryStatus(used, 'confirmed');
    await knowledge.setMemoryStatus(unused, 'confirmed');

    clock += 40 * DAY;
    // An agent's search counts as a use; a person's does not.
    await knowledge.search([project], 'safari', 10, { countHits: true });
    await knowledge.search([project], 'staging');
    assert.deepEqual((await knowledge.memories(project)).map(item => [item.title, item.hits]).sort(), [['Safari keeps fetch pending', 1], ['Staging is slow on Mondays', 0]]);

    clock += 30 * DAY;
    assert.equal(await knowledge.sweepStale(), 1);
    assert.equal(await knowledge.sweepStale(), 0);
    assert.deepEqual((await knowledge.memories(project)).map(item => [item.title, item.status, item.stale]).sort(), [['Safari keeps fetch pending', 'confirmed', false], ['Staging is slow on Mondays', 'stale', true]]);
    assert.deepEqual((await knowledge.assemble([project], 1000)).memoryIds, [used]);

    await knowledge.setMemoryStatus(unused, 'confirmed');
    assert.equal((await knowledge.memories(project)).find(item => item.id === unused)?.stale, false);
    clock += 61 * DAY;
    assert.equal(await knowledge.sweepStale(), 2);
  } finally { await storage.close(); }
});

test('with an embedder, search also finds what shares meaning but no words; without one it stays lexical', async () => {
  // A toy embedding: one axis per topic, so "cannot pay" lands next to the checkout page and far from the release notes.
  const topics: [RegExp, number[]][] = [[/pay|checkout|order|card/i, [1, 0]], [/release|deploy|version/i, [0, 1]]];
  const embedder = { model: 'toy', embed: async (text: string) => topics.reduce((sum, [pattern, axis]) => (pattern.test(text) ? [sum[0]! + axis[0]!, sum[1]! + axis[1]!] : sum), [0, 0]) };
  const storage = await createStorage({ kind: 'sqlite', path: ':memory:' });
  await storage.migrate();
  const context = createContext({ storage, machineToken: 'x'.repeat(24) });
  const semantic = createKnowledge(context, embedder);
  await semantic.write(ada, { scope: project, path: 'flows/checkout.md', title: 'Checkout flow', body: 'How an order is placed and the card is charged.' });
  await semantic.write(ada, { scope: project, path: 'ops/release.md', title: 'Release steps', body: 'Cut the version and deploy it.' });

  assert.deepEqual((await semantic.search([project], 'customers cannot pay')).map(item => item.title), ['Checkout flow']);
  assert.deepEqual((await createKnowledge(context).search([project], 'customers cannot pay')).map(item => item.title), []);
  // A failing model degrades to lexical search instead of failing the query.
  const broken = createKnowledge(context, { model: 'down', embed: async () => { throw new Error('offline'); } });
  assert.deepEqual((await broken.search([project], 'release')).map(item => item.title), ['Release steps']);
  await storage.close();
});
