import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { INTEGRATION_KINDS, connectionIntegration, credentialVariables, integrationAdapter, integrationInstructions, integrationServers, validateIntegrations } from './index.ts';
import { listTools } from './mcp.ts';

test('every kind satisfies the adapter contract', () => {
  for (const kind of INTEGRATION_KINDS) {
    const adapter = integrationAdapter(kind);
    assert.equal(adapter.name, kind);
    assert.ok(adapter.title && adapter.manifestKeys.length > 0);
    assert.ok(adapter.defaultUrl === null || adapter.defaultUrl.startsWith('https://'));
    const config = { kind, name: 'tool', url: 'https://tool.example/mcp' };
    assert.equal(adapter.validate(config), config);
    assert.match(adapter.instructions(config), /\(MCP tools tool_\*\)/);
    assert.equal(adapter.credential({}, config), null);
  }
});

test('integrations validate kinds, names, urls and per-kind keys', () => {
  assert.deepEqual(INTEGRATION_KINDS, ['slack', 'google-drive', 'hubspot', 'mcp']);
  assert.deepEqual(validateIntegrations(undefined), []);
  const list = validateIntegrations([{ kind: 'slack', channels: ['#ops', 'sales'] }, { kind: 'hubspot', objects: ['deals'] }, { kind: 'google-drive', url: 'https://drive-mcp.example/mcp', folders: ['abcdef12345'] }, { kind: 'mcp', name: 'crm', url: 'https://crm.example/mcp', purpose: 'the billing system', roles: ['team-dev'] }]);
  assert.deepEqual(list.map(entry => [entry.name, entry.url]), [['slack', 'https://mcp.slack.com/mcp'], ['hubspot', 'https://mcp.hubspot.com/'], ['google-drive', 'https://drive-mcp.example/mcp'], ['crm', 'https://crm.example/mcp']]);
  assert.deepEqual(list[3]!.roles, ['team-dev']);
  assert.throws(() => validateIntegrations([{ kind: 'google-drive' }]), /requires url/);
  assert.throws(() => validateIntegrations([{ kind: 'jira' }]), /Unknown integration kind/);
  assert.throws(() => validateIntegrations([{ kind: 'slack' }, { kind: 'slack' }]), /duplicate integration name/);
  assert.throws(() => validateIntegrations([{ kind: 'mcp', name: 'tracker', url: 'https://x.example/' }]), /integration name/);
  assert.throws(() => validateIntegrations([{ kind: 'slack', url: 'http://plain.example/' }]), /https/);
  assert.throws(() => validateIntegrations([{ kind: 'slack', url: 'https://user:pw@x.example/' }]), /https/);
  assert.throws(() => validateIntegrations([{ kind: 'slack', folders: [] }]), /unknown key/);
  assert.throws(() => validateIntegrations([{ kind: 'slack', channels: ['bad channel'] }]), /channels/);
  assert.throws(() => validateIntegrations([{ kind: 'hubspot', objects: ['emails'] }]), /objects/);
  assert.throws(() => validateIntegrations([{ kind: 'mcp', name: 'crm', url: 'https://crm.example/', purpose: 'x'.repeat(401) }]), /purpose/);
  assert.throws(() => validateIntegrations([{ kind: 'slack', roles: [] }]), /roles/);
  assert.throws(() => validateIntegrations([{ kind: 'slack', roles: ['Not A Role'] }]), /roles/);
  assert.throws(() => validateIntegrations(new Array(17).fill({ kind: 'slack' })), /at most 16/);
});

test('servers carry a bearer header only when the worker holds the credential, and every credential name is known', () => {
  const list = validateIntegrations([{ kind: 'slack', channels: ['ops'], roles: ['team-dev'] }, { kind: 'hubspot' }, { kind: 'mcp', name: 'crm', url: 'https://crm.example/mcp' }]);
  const servers = integrationServers(list, { SLACK_BOT_TOKEN: 'xoxb-1', CRM_MCP_TOKEN: 'c' });
  assert.deepEqual(servers, {
    slack: { type: 'http', url: 'https://mcp.slack.com/mcp', headers: { Authorization: 'Bearer xoxb-1' } },
    hubspot: { type: 'http', url: 'https://mcp.hubspot.com/' },
    crm: { type: 'http', url: 'https://crm.example/mcp', headers: { Authorization: 'Bearer c' } },
  });
  const names = credentialVariables(list);
  for (const name of ['SLACK_MCP_TOKEN', 'SLACK_BOT_TOKEN', 'GOOGLE_DRIVE_MCP_TOKEN', 'HUBSPOT_MCP_TOKEN', 'HUBSPOT_ACCESS_TOKEN', 'CRM_MCP_TOKEN']) assert.ok(names.includes(name), name);
  const text = integrationInstructions(list);
  assert.match(text, /^External tools connected to this project:/);
  assert.match(text, /Slack \(MCP tools slack_\*\).* Post only in #ops\..* Only team-dev may use it\./);
  assert.match(text, /crm \(MCP tools crm_\*\): an external tool the owner connected/);
  assert.equal(integrationInstructions([]), '');
});

test('a connection set up in the app becomes an integration, and may only be handed a credential its own adapter reads', () => {
  const crm = connectionIntegration({ kind: 'mcp', config: { name: 'crm', url: 'https://crm.example/mcp', purpose: 'the customer list', roles: 'sales, marketing', target: 'connection' }, credentialRef: 'CRM_MCP_TOKEN' });
  assert.deepEqual(crm, { integration: { kind: 'mcp', name: 'crm', url: 'https://crm.example/mcp', roles: ['sales', 'marketing'], purpose: 'the customer list' }, variable: 'CRM_MCP_TOKEN' });
  assert.equal(connectionIntegration({ kind: 'mcp', config: { name: 'crm', url: 'https://crm.example/mcp' }, credentialRef: 'LINEAR_API_KEY' })!.variable, null, 'another product\'s key is never sent along');
  assert.deepEqual(connectionIntegration({ kind: 'hubspot', config: { objects: 'Contacts, deals' }, credentialRef: 'HUBSPOT_MCP_TOKEN' }), { integration: { kind: 'hubspot', name: 'hubspot', url: 'https://mcp.hubspot.com/', objects: ['contacts', 'deals'] }, variable: 'HUBSPOT_MCP_TOKEN' });
  assert.equal(connectionIntegration({ kind: 'hubspot', config: { objects: 'emails' }, credentialRef: null }), null, 'a scope that cannot be kept drops the tool rather than widening it');
  assert.equal(connectionIntegration({ kind: 'mcp', config: { name: 'crm', url: 'http://crm.example/mcp' }, credentialRef: null }), null, 'plain http only to this machine');
  assert.ok(connectionIntegration({ kind: 'mcp', config: { name: 'crm', url: 'http://127.0.0.1:9/mcp' }, credentialRef: null }));
  assert.equal(connectionIntegration({ kind: 'mcp', config: { name: 'platform', url: 'https://x.example/' }, credentialRef: null }), null);
  assert.equal(connectionIntegration({ kind: 'github', config: {}, credentialRef: null }), null);
});

test('the tools a server offers are listed the way an engine asks for them, with the token as bearer', async () => {
  const seen: { session: string | undefined; method: string }[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const message = JSON.parse(body) as { id?: number; method: string };
      seen.push({ session: request.headers['mcp-session-id'] as string | undefined, method: message.method });
      if (request.headers.authorization !== 'Bearer good-token') { response.writeHead(401).end(); return; }
      if (message.id === undefined) { response.writeHead(202).end(); return; }
      const result = message.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } : { tools: [{ name: 'search_contacts' }, { name: 'update_deal' }] };
      // The answer to tools/list comes as an event stream, as many hosted servers send it.
      if (message.method === 'tools/list') response.writeHead(200, { 'content-type': 'text/event-stream' }).end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n`);
      else response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'session-1' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    assert.deepEqual((await listTools(url, 'good-token')).map(tool => tool.name), ['search_contacts', 'update_deal']);
    assert.deepEqual(seen.map(item => [item.method, item.session ?? null]), [['initialize', null], ['notifications/initialized', 'session-1'], ['tools/list', 'session-1']]);
    await assert.rejects(listTools(url, 'wrong-token'), /refused the token/);
  } finally { server.close(); }
});
