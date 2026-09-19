import test from 'node:test';
import assert from 'node:assert/strict';
import { INTEGRATION_KINDS, credentialVariables, integrationAdapter, integrationInstructions, integrationServers, validateIntegrations } from './index.ts';

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
