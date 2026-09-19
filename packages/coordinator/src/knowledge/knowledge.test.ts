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
