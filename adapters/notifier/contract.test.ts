import test from 'node:test';
import assert from 'node:assert/strict';
import { NOTIFIERS } from './index.ts';

// Every notifier: its setup fields are well formed, a message is sent with what it carries, and a failure never carries the token.
for (const entry of NOTIFIERS) {
  test(`${entry.kind}: sends a message with its title, text and link, and fails without the credential in its reason`, async () => {
    for (const field of entry.fields) if (field.pattern) assert.doesNotThrow(() => new RegExp(field.pattern!), field.key);
    const values = Object.fromEntries(entry.fields.map(field => [field.key, field.suggest?.() ?? field.placeholder ?? '']));
    const sent: { url: string; init: RequestInit }[] = [];
    const ok = (async (url: string | URL, init?: RequestInit) => { sent.push({ url: String(url), init: init! }); return new Response('{}'); }) as typeof fetch;
    await entry.create({ ...values, server: 'https://push.example' }, 'secret-token', ok).send({ title: 'The team needs your call', body: 'Keep the Thursday deploy?', url: 'https://app.example/needs-you', urgent: true });
    assert.equal(sent.length, 1);
    const body = String(sent[0]!.init.body);
    assert.ok(body.includes('The team needs your call') && body.includes('Keep the Thursday deploy?') && body.includes('https://app.example/needs-you'));
    const refused = (async () => new Response('secret-token is wrong', { status: 403 })) as typeof fetch;
    await assert.rejects(entry.create({ ...values, server: 'https://push.example' }, 'secret-token', refused).send({ title: 't', body: 'b' }), error => !/secret-token/.test((error as Error).message) && /403/.test((error as Error).message));
  });
}
