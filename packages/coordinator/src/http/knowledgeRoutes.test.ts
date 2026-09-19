import test from 'node:test';
import assert from 'node:assert/strict';
import { seedDemo } from '../demo/seed.ts';
import { createKnowledge } from '../knowledge/knowledge.ts';
import { startCoordinator } from '../server.ts';

async function boot() {
  const coordinator = await startCoordinator({ port: 0, storage: { kind: 'sqlite', path: ':memory:' }, machineToken: 'x'.repeat(24), webRoot: null, trackers: null });
  await seedDemo(coordinator.context);
  const login = await fetch(`${coordinator.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'demo@example.com', password: 'demo-password-1234' }) });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const call = async (path: string, body?: unknown) => {
    const response = await fetch(coordinator.url + path, body === undefined ? { headers: { cookie } } : { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, json: await response.json() as any };
  };
  return { coordinator, call };
}

test('a page is written, edited with a stale edit refused, read back through its history and restored', async () => {
  const { coordinator, call } = await boot();
  try {
    const base = '/api/projects/checkout-v2/knowledge';
    const created = (await call(base, { path: 'ops/deploy-window.md', title: 'Deploy window', body: 'Deploys open at 16:00.' })).json;
    const edited = await call(base, { path: 'ops/deploy-window.md', title: 'Deploy window', body: 'Deploys open at 16:00.\nTell support first.', note: 'Support asked', expectedRev: 1 });
    assert.equal(edited.json.rev, 2);
    const stale = await call(base, { path: 'ops/deploy-window.md', title: 'Deploy window', body: 'Overwrites.', expectedRev: 1 });
    assert.deepEqual([stale.status, stale.json.error.code], [409, 'stale']);

    const history = (await call(`${base}/pages/${created.id}/history`)).json.revisions;
    assert.deepEqual(history.map((item: any) => [item.rev, item.author, item.note, item.current]), [[2, 'Jorgen F', 'Support asked', true], [1, 'Jorgen F', null, false]]);
    const old = (await call(`${base}/pages/${created.id}/revisions/1`)).json;
    assert.equal(old.revision.body, 'Deploys open at 16:00.');
    assert.deepEqual([old.diff.added, old.diff.removed], [1, 0]);
    assert.equal((await call(`${base}/pages/${created.id}/revisions/7`)).status, 404);

    assert.equal((await call(`${base}/pages/${created.id}/restore`, { rev: 1 })).json.rev, 3);
    const page = (await call(`${base}/pages/${created.id}`)).json;
    assert.deepEqual([page.page.body, page.page.rev, page.scope, page.canWrite], ['Deploys open at 16:00.', 3, 'subproject', true]);

    // A version that came in from the document folder waits beside the page until someone chooses.
    await createKnowledge(coordinator.context).writeSibling({ kind: 'system', id: 'folder-sync' }, created.id, { body: 'Deploys open at 15:00.' });
    const waiting = (await call(`${base}/pages/${created.id}/history`)).json.revisions.filter((item: any) => item.waiting);
    assert.deepEqual(waiting.map((item: any) => [item.rev, item.author]), [[4, 'The document folder']]);
    assert.equal((await call(`${base}/pages/${created.id}/conflict`, { rev: 4, choice: 'theirs' })).json.rev, 5);
    assert.equal((await call(`${base}/pages/${created.id}`)).json.page.body, 'Deploys open at 15:00.');
  } finally { await coordinator.close(); }
});

test('knowledge is kept per level, and a page of another project cannot be reached through this one', async () => {
  const { coordinator, call } = await boot();
  try {
    const own = (await call('/api/projects/checkout-v2/knowledge')).json;
    assert.deepEqual(own.scopes.map((item: any) => [item.key, item.label]), [['subproject', 'Checkout v2'], ['project', 'Web shop'], ['team', 'Product team'], ['org', 'Acme']]);
    assert.deepEqual([own.scope, own.pages.length], ['subproject', 3]);
    // A top-level project has no sub-project level.
    assert.deepEqual((await call('/api/projects/nordlys-studio/knowledge')).json.scopes.map((item: any) => item.key), ['project', 'team', 'org']);
    assert.equal((await call('/api/projects/nordlys-studio/knowledge?scope=subproject')).status, 400);

    await call('/api/projects/checkout-v2/knowledge?scope=org', { path: 'handbook/holidays.md', title: 'Holidays', body: 'The office closes between the years.' });
    assert.equal((await call('/api/projects/checkout-v2/knowledge')).json.pages.length, 3);
    const org = (await call('/api/projects/nordlys-studio/knowledge?scope=org')).json;
    assert.deepEqual(org.pages.map((item: any) => item.title), ['Holidays']);
    // Search covers every level the project belongs to, and says where each hit leads.
    const hit = (await call('/api/projects/nordlys-studio/search?q=holiday')).json.hits[0];
    assert.deepEqual([hit.title, hit.target], ['Holidays', { kind: 'page', pageId: org.pages[0].id }]);

    const voice = (await call('/api/projects/nordlys-studio/knowledge')).json.pages[0];
    assert.equal((await call(`/api/projects/nordlys-studio/knowledge/pages/${voice.id}`)).status, 200);
    assert.equal((await call(`/api/projects/checkout-v2/knowledge/pages/${voice.id}`)).status, 404);
    assert.equal((await call(`/api/projects/checkout-v2/knowledge/pages/${voice.id}/restore`, { rev: 1 })).status, 404);
  } finally { await coordinator.close(); }
});

test('search hits lead to pages, memories, issues and the discussion; a decision is read by reference', async () => {
  const { coordinator, call } = await boot();
  try {
    const issue = (await call('/api/projects/checkout-v2/issues', { title: 'Kiosk browser hangs', body: 'The kiosk stays on Processing.' })).json;
    const hits = (await call('/api/projects/checkout-v2/search?q=kiosk&limit=20')).json.hits;
    assert.deepEqual(hits.find((item: any) => item.type === 'issue').target, { kind: 'issue', slug: 'checkout-v2', number: issue.number });
    const discussion = (await call('/api/projects/checkout-v2')).json.discussionThreadId;
    await call(`/api/threads/${discussion}/messages`, { body: 'Can the deploy window move to Friday?' });
    assert.deepEqual((await call('/api/projects/checkout-v2/search?q=deploy+window')).json.hits.find((item: any) => item.type === 'message').target, { kind: 'discussion', slug: 'checkout-v2' });
    const memory = (await call('/api/projects/checkout-v2/search?q=safari+pending')).json.hits.find((item: any) => item.type === 'memory');
    assert.deepEqual([memory.target.kind, memory.target.scope], ['memory', 'subproject']);
    // A person's search is not a use of the memory.
    assert.equal((await call('/api/projects/checkout-v2/knowledge')).json.memories.find((item: any) => item.id === memory.id).hits, 0);

    const decisions = (await call('/api/projects/web-shop/decisions')).json.decisions;
    assert.equal(decisions.length, 1);
    const decision = (await call(`/api/projects/checkout-v2/decisions/${decisions[0].id}`)).json.decision;
    assert.deepEqual([decision.waitingForPerson, decision.projectSlug, decision.issueNumber], [true, 'checkout-v2', null]);
    assert.match(decision.summary, /Thursday/);
    assert.equal((await call(`/api/projects/nordlys-studio/decisions/${decisions[0].id}`)).status, 404);
  } finally { await coordinator.close(); }
});
