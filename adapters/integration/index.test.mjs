import test from 'node:test';
import assert from 'node:assert/strict';
import { INTEGRATION_KINDS, credentialVariables, integrationInstructions, integrationServers, validateIntegrations } from './index.mjs';
import { normalizeManifest } from '../../core/manifest.mjs';

const v1 = { version: 1, name: 'Legacy', instructions: [], workspaceId: 'w', workspaceUrl: 'https://tracker.example/w', teamId: 't', projectId: 'p', projectUrl: 'https://tracker.example/w/p', readyLabel: 'agent:ready' };

test('integrations validate kinds, names, urls and per-kind keys', () => {
  assert.deepEqual(INTEGRATION_KINDS, ['slack', 'google-drive', 'hubspot', 'mcp']);
  assert.deepEqual(validateIntegrations(undefined), []);
  const list = validateIntegrations([{ kind: 'slack', channels: ['#ops', 'sales'] }, { kind: 'hubspot', objects: ['deals'] }, { kind: 'google-drive', url: 'https://drive-mcp.example/mcp', folders: ['abcdef12345'] }, { kind: 'mcp', name: 'crm', url: 'https://crm.example/mcp', purpose: 'the billing system', roles: ['team-dev'] }]);
  assert.deepEqual(list.map(entry => [entry.name, entry.url]), [['slack', 'https://mcp.slack.com/mcp'], ['hubspot', 'https://mcp.hubspot.com/'], ['google-drive', 'https://drive-mcp.example/mcp'], ['crm', 'https://crm.example/mcp']]);
  assert.throws(() => validateIntegrations([{ kind: 'google-drive' }]), /requires url/);
  assert.throws(() => validateIntegrations([{ kind: 'jira' }]), /Unknown integration kind/);
  assert.throws(() => validateIntegrations([{ kind: 'slack' }, { kind: 'slack' }]), /duplicate integration name/);
  assert.throws(() => validateIntegrations([{ kind: 'mcp', name: 'tracker', url: 'https://x.example/' }]), /integration name/);
  assert.throws(() => validateIntegrations([{ kind: 'slack', url: 'http://plain.example/' }]), /https/);
  assert.throws(() => validateIntegrations([{ kind: 'slack', url: 'https://user:pw@x.example/' }]), /https/);
  assert.throws(() => validateIntegrations([{ kind: 'slack', folders: [] }]), /unknown key/);
  assert.throws(() => validateIntegrations([{ kind: 'slack', channels: ['bad channel'] }]), /channels/);
  assert.throws(() => validateIntegrations([{ kind: 'hubspot', objects: ['emails'] }]), /objects/);
  assert.throws(() => validateIntegrations([{ kind: 'slack', roles: [] }]), /roles/);
  assert.throws(() => validateIntegrations(new Array(17).fill({ kind: 'slack' })), /at most 16/);
});

test('the manifest carries integrations and checks their roles against the team', () => {
  assert.deepEqual(normalizeManifest(v1).integrations, []);
  const manifest = normalizeManifest({ ...v1, integrations: [{ kind: 'slack', roles: ['team-coordinator', 'team-dev'] }] });
  assert.equal(manifest.integrations[0].name, 'slack');
  assert.equal(normalizeManifest({ ...v1, integrations: [{ kind: 'slack', roles: ['team-nobody'] }] }).integrations[0].roles[0], 'team-nobody', 'roles are checked against the stored team when a run resolves it');
  assert.throws(() => normalizeManifest({ ...v1, integrations: [{ kind: 'slack', roles: ['nobody'] }] }), /unknown role/);
});

test('servers carry a bearer header only when the worker holds the credential, and every credential name is known', () => {
  const list = validateIntegrations([{ kind: 'slack' }, { kind: 'hubspot' }, { kind: 'mcp', name: 'crm', url: 'https://crm.example/mcp' }]);
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
  assert.match(text, /Slack \(MCP tools slack_\*\)/);
  assert.match(text, /crm \(MCP tools crm_\*\): an external tool the owner connected/);
  assert.equal(integrationInstructions([]), '');
});
