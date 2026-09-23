import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '@agent-team/storage';
import { createContext } from '../context.ts';
import type { NeedsYouItem } from './needsYou.ts';
import { createNotifications } from './notifications.ts';

const item = (id: string, title: string, kind: NeedsYouItem['kind'] = 'blocked'): NeedsYouItem => ({ kind, id, projectId: 'p1', title, detail: `${title}, in detail.`, since: 1, taskKey: null, href: `/p/shop/tasks/${id}` });

test('the owner is told of each new thing once, several at once in one message, reminded a day later, and sent the day in the morning', async () => {
  const storage = await createStorage({ kind: 'sqlite', path: ':memory:' });
  await storage.migrate();
  let clock = new Date(2026, 8, 23, 6, 0).getTime();
  const sent: { title: string; message: string; click?: string }[] = [];
  const request = (async (_url: string | URL, init?: RequestInit) => { sent.push(JSON.parse(String(init!.body))); return new Response('{}'); }) as typeof fetch;
  const context = createContext({ storage, machineToken: 'x'.repeat(24), now: () => clock, fetch: request });
  try {
    let waiting: NeedsYouItem[] = [];
    const notifications = createNotifications(context, { list: async () => waiting });
    await storage.db.insertInto('org').values({ id: 'o1', name: 'Acme', accent: 'amber', currency: 'EUR', settings: JSON.stringify({ notify: { kind: 'ntfy', values: { server: 'https://push.example', topic: 'acme-team' }, appUrl: 'https://app.example', summaryHour: 8 } }), created_at: 1 }).execute();

    waiting = [item('t1', 'T-1 · Checkout fails')];
    assert.deepEqual(await notifications.sweep(), { sent: 1 });
    assert.deepEqual([sent[0]!.title, sent[0]!.click], ['T-1 · Checkout fails', 'https://app.example/p/shop/tasks/t1']);
    assert.deepEqual(await notifications.sweep(), { sent: 0 }, 'told once');

    waiting = [item('t1', 'T-1 · Checkout fails'), ...['t2', 't3', 't4', 't5'].map(id => item(id, `${id} is blocked`))];
    await notifications.sweep();
    assert.equal(sent.at(-1)!.title, '4 things need you', 'several at once are one message');

    // Settled things go; what is still there a day on is said once more, together; the morning brings the day's summary.
    waiting = [item('t1', 'T-1 · Checkout fails')];
    clock += 26 * 3600_000;
    await notifications.sweep();
    assert.deepEqual(sent.slice(-2).map(message => message.title), ['Still waiting for you: 1', 'The team today']);
    assert.match(sent.at(-1)!.message, /Nothing finished\.\nBlocked: 0\. Waiting for you: 1\./);
    assert.deepEqual(await notifications.sweep(), { sent: 0 }, 'reminded once, summarised once a day');
    const resolved = await storage.db.selectFrom('notifications').select('key').where('resolved_at', 'is not', null).where('key', 'not like', 'summary:%').execute();
    assert.equal(resolved.length, 4);
  } finally { await storage.close(); }
});

test('a message that does not get through is said where the owner sets it up, and nothing is lost', async () => {
  const storage = await createStorage({ kind: 'sqlite', path: ':memory:' });
  await storage.migrate();
  let up = false;
  const request = (async () => (up ? new Response('{}') : new Response('no', { status: 502 }))) as typeof fetch;
  const context = createContext({ storage, machineToken: 'x'.repeat(24), now: () => new Date(2026, 8, 23, 6, 0).getTime(), fetch: request });
  try {
    const notifications = createNotifications(context, { list: async () => [item('t1', 'T-1 · Checkout fails')] });
    await storage.db.insertInto('org').values({ id: 'o1', name: 'Acme', accent: 'amber', currency: 'EUR', settings: JSON.stringify({ notify: { kind: 'ntfy', values: { server: 'https://push.example', topic: 'acme-team' }, appUrl: null, summaryHour: 8 } }), created_at: 1 }).execute();
    await notifications.sweep();
    assert.equal((await storage.db.selectFrom('sync_cursors').select('error').where('resource', '=', 'notify').executeTakeFirstOrThrow()).error, 'ntfy answered 502');
    up = true;
    assert.deepEqual(await notifications.sweep(), { sent: 1 }, 'what was not told is told once the channel answers');
  } finally { await storage.close(); }
});
