import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './testing.ts';

test('the owner sets up where they hear from the team in the app, tests it with one message, and can turn it off', async () => {
  const sent: string[] = [];
  const request = (async (url: string | URL, init?: RequestInit) => { sent.push(`${String(url)} ${String(init?.body ?? '')}`); return new Response('{}'); }) as typeof fetch;
  const { coordinator, call, owner, person } = await boot({ fetch: request });
  try {
    const cookie = await owner();
    const offered = (await call('/api/settings/notify', { cookie })).json;
    assert.equal(offered.current, null);
    const ntfy = offered.entries.find((entry: { kind: string }) => entry.kind === 'ntfy');
    assert.match(ntfy.fields.find((field: { key: string }) => field.key === 'topic').suggestion, /^agent-team-/, 'a topic nobody can guess is suggested');
    assert.equal((await call('/api/settings/notify', { cookie, body: { kind: 'ntfy', values: { server: 'https://push.example', topic: 'no spaces allowed' } } })).json.error.fields.topic, 'Topic does not look right');
    assert.equal((await call('/api/settings/notify', { cookie, body: { kind: 'ntfy', values: { server: 'https://push.example', topic: 'acme-team' }, token: 'tk_secret123', summaryHour: 7 } })).status, 200);
    const now = (await call('/api/settings/notify', { cookie })).json;
    assert.deepEqual([now.current.values.topic, now.current.summaryHour, now.tokenSaved], ['acme-team', 7, true]);
    assert.equal((await call('/api/settings/notify/test', { cookie, body: {} })).json.ok, true);
    assert.match(sent.at(-1)!, /^https:\/\/push\.example .*"topic":"acme-team".*"title":"The team can reach you"/);
    const member = await person('mia', 'member');
    assert.equal((await call('/api/settings/notify/test', { cookie: member.cookie, body: {} })).status, 403);
    await call('/api/settings/notify/off', { cookie, body: {} });
    assert.equal((await call('/api/settings/notify', { cookie })).json.current, null);
  } finally { await coordinator.close(); }
});
