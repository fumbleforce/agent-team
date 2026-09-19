import test from 'node:test';
import assert from 'node:assert/strict';
import { newId } from '@agent-team/protocol';
import { seedDemo } from '../demo/seed.ts';
import { startCoordinator } from '../server.ts';
import { indexMessage } from './indexing.ts';

test('project search covers issues and team messages beside pages, and leaves private threads out', async () => {
  const coordinator = await startCoordinator({ port: 0, storage: { kind: 'sqlite', path: ':memory:' }, machineToken: 'x'.repeat(24), webRoot: null });
  await seedDemo(coordinator.context);
  const { storage } = coordinator.context;
  try {
    // No vector port and no embedder: search is lexical.
    assert.equal(storage.vectors, undefined);
    const login = await fetch(`${coordinator.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'demo@example.com', password: 'demo-password-1234' }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const post = async (path: string, body: unknown) => (await fetch(coordinator.url + path, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) })).json() as Promise<any>;
    const search = async (slug: string, q: string) => ((await (await fetch(`${coordinator.url}/api/projects/${slug}/search?q=${encodeURIComponent(q)}`, { headers: { cookie } })).json()) as { hits: { type: string; title: string; ref: string | null }[] }).hits;

    const issue = await post('/api/projects/checkout-v2/issues', { title: 'Pay button hangs after a network drop', body: 'Stays on Processing for 20 s on the kiosk browser.' });
    await post(`/api/threads/${issue.threadId}/messages`, { body: 'Reproduced on the kiosk with the throttling proxy.' });
    await post('/api/projects/checkout-v2/knowledge', { path: 'frontend/kiosk.md', title: 'Kiosk quirks', body: 'Fetch stays pending after network loss.' });

    assert.deepEqual((await search('checkout-v2', 'kiosk')).map(hit => [hit.type, hit.title, hit.ref]), [
      ['page', 'Kiosk quirks', null],
      ['message', 'Pay button hangs after a network drop', issue.threadId],
      ['issue', `#${issue.number} Pay button hangs after a network drop`, issue.threadId],
    ]);
    assert.deepEqual((await search('checkout-v2', 'thrott proxy')).map(hit => hit.type), ['message']);

    // A private thread is nobody else's to find.
    const project = await storage.db.selectFrom('projects').select('id').where('slug', '=', 'checkout-v2').executeTakeFirstOrThrow();
    const privateThread = newId();
    await storage.transaction(async tx => {
      await tx.insertInto('threads').values({ id: privateThread, project_id: project.id, kind: 'discussion', subject_type: null, subject_id: null, title: 'Notes to self', visibility: 'private', owner_user_id: null, created_at: 1 }).execute();
      await indexMessage(storage, tx, { id: newId(), threadId: privateThread, body: 'Kiosk, privately.' });
    });
    assert.equal((await search('checkout-v2', 'privately')).length, 0);
  } finally { await coordinator.close(); }
});
