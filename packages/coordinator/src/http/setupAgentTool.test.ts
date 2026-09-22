import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './testing.ts';

const PASTED = 'pat-na1-0123456789abcdef';

// A tool for agents (a CRM, here) is set up by pasting its token in the app: the check asks the product's MCP server for its tools with
// that token and says in plain words what it found, and the token is kept sealed on the platform, never with the connection.
test('an agent tool takes a pasted token, checks it against the MCP server and keeps it sealed', async () => {
  const asked: { url: string; auth: string | null; method: string }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const message = JSON.parse(String(init?.body)) as { id?: number; method: string };
    const auth = new Headers(init?.headers).get('authorization');
    asked.push({ url: String(input), auth, method: message.method });
    if (auth !== `Bearer ${PASTED}`) return new Response('', { status: 401 });
    if (message.id === undefined) return new Response(null, { status: 202 });
    const result = message.method === 'tools/list' ? { tools: [{ name: 'search_crm_objects' }, { name: 'get_crm_objects' }, { name: 'manage_crm_objects' }] } : { protocolVersion: '2025-06-18', capabilities: {} };
    return Response.json({ jsonrpc: '2.0', id: message.id, result });
  }) as typeof globalThis.fetch;
  const { coordinator, db, call, owner } = await boot({ fetch, env: {} });
  try {
    const cookie = await owner();
    await call('/api/projects', { cookie, body: { name: 'Sales' } });
    const entry = ((await call('/api/projects/sales/integrations/catalog', { cookie })).json.entries as { kind: string; testable: boolean; credential: { runsOn: string } }[]).find(item => item.kind === 'hubspot')!;
    assert.deepEqual([entry.testable, entry.credential.runsOn], [true, 'coordinator'], 'the token is pasted in the app and can be checked from there');

    const refused = await call('/api/projects/sales/integrations/test', { cookie, body: { kind: 'hubspot', token: 'pat-na1-wrong-token', values: {} } });
    assert.deepEqual([refused.json.ok, /refused the token/.test(refused.json.message)], [false, true]);
    const checked = await call('/api/projects/sales/integrations/test', { cookie, body: { kind: 'hubspot', token: PASTED, values: { objects: 'contacts, deals' } } });
    assert.deepEqual(checked.json, { ok: true, message: 'Signed in to HubSpot. The team can use 3 of its tools.' });
    assert.deepEqual(asked.slice(-3).map(item => [item.url, item.method]), [['https://mcp.hubspot.com/', 'initialize'], ['https://mcp.hubspot.com/', 'notifications/initialized'], ['https://mcp.hubspot.com/', 'tools/list']]);
    assert.match((await call('/api/projects/sales/integrations/setup', { cookie, body: { kind: 'hubspot', values: { objects: 'emails' } } })).json.error.fields.objects, /Record types does not look right/);

    assert.equal((await call('/api/projects/sales/integrations/setup', { cookie, body: { kind: 'hubspot', token: PASTED, values: { objects: 'contacts, deals', roles: 'sales' } } })).status, 200);
    const connection = await db.selectFrom('connections').selectAll().where('kind', '=', 'hubspot').executeTakeFirstOrThrow();
    assert.deepEqual([connection.mode, connection.credential_ref, connection.status], ['agent tool', 'HUBSPOT_MCP_TOKEN', 'connected']);
    assert.ok(!connection.config.includes(PASTED));
    const sealed = await db.selectFrom('secrets').select('sealed').where('name', '=', 'HUBSPOT_MCP_TOKEN').executeTakeFirstOrThrow();
    assert.ok(!sealed.sealed.includes(PASTED), 'stored sealed');
    assert.equal(coordinator.context.secrets.get('HUBSPOT_MCP_TOKEN'), PASTED);

    // Setting it up again without naming who may use it, as when the token is pasted after a plan connected it, keeps who may.
    assert.equal((await call('/api/projects/sales/integrations/setup', { cookie, body: { kind: 'hubspot', token: PASTED, values: {} } })).status, 200);
    const again = await db.selectFrom('connections').select('config').where('kind', '=', 'hubspot').execute();
    assert.deepEqual(again.map(row => JSON.parse(row.config).roles), ['sales']);
  } finally { await coordinator.close(); }
});
