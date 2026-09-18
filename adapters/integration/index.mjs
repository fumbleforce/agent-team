import * as slack from './slack.mjs';
import * as googleDrive from './google-drive.mjs';
import * as hubspot from './hubspot.mjs';
import * as mcp from './mcp.mjs';

// An integration is an external tool the team may use during a run, reached through a remote
// MCP server. The manifest lists them; the runner turns the list into the engine's MCP map and
// prompt notes, and strips every integration credential the manifest did not grant.
const ADAPTERS = { slack, 'google-drive': googleDrive, hubspot, mcp };
export const INTEGRATION_KINDS = Object.keys(ADAPTERS);
const NAME = /^[a-z][a-z0-9-]{0,31}$/;
// Names the runner already uses for MCP servers or that engines treat specially.
const RESERVED = new Set(['tracker', 'memory', 'team']);

export function integrationAdapter(kind) {
  if (!Object.hasOwn(ADAPTERS, kind)) throw new Error(`Unknown integration kind: ${kind}. Use ${INTEGRATION_KINDS.join(', ')}`);
  return ADAPTERS[kind];
}

// Every credential variable any integration reads; the runner strips all of them from the
// model process, whichever integrations a project grants.
export function credentialVariables(integrations = []) {
  const names = new Set(INTEGRATION_KINDS.flatMap(kind => ADAPTERS[kind].CREDENTIAL_VARIABLES));
  for (const integration of integrations) if (integration.kind === 'mcp') names.add(mcp.credentialVariable(integration.name));
  return [...names];
}

// Normalizes the manifest's integrations section: each entry names a known kind, has a unique
// MCP name and a valid https URL, and passes the adapter's own checks.
export function validateIntegrations(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.length > 16) throw new Error('Invalid .agent-team.json: integrations must be an array of at most 16 entries');
  const seen = new Set();
  return list.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid .agent-team.json: each integration is an object');
    const adapter = integrationAdapter(entry.kind);
    const name = entry.name ?? entry.kind;
    if (typeof name !== 'string' || !NAME.test(name) || RESERVED.has(name)) throw new Error(`Invalid .agent-team.json: integration name ${JSON.stringify(name)}`);
    if (seen.has(name)) throw new Error(`Invalid .agent-team.json: duplicate integration name ${name}`);
    seen.add(name);
    const url = entry.url ?? adapter.DEFAULT_URL;
    if (typeof url !== 'string') throw new Error(`Invalid .agent-team.json: integration ${name} (${entry.kind}) requires url`);
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error(`Invalid .agent-team.json: integration ${name} url`); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) throw new Error(`Invalid .agent-team.json: integration ${name} url must be https without credentials`);
    for (const key of Object.keys(entry)) if (!['kind', 'name', 'url', 'roles', ...adapter.MANIFEST_KEYS].includes(key)) throw new Error(`Invalid .agent-team.json: integration ${name} has unknown key ${key}`);
    if (entry.roles !== undefined && (!Array.isArray(entry.roles) || !entry.roles.length || entry.roles.some(role => typeof role !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(role)))) throw new Error(`Invalid .agent-team.json: integration ${name} roles`);
    return adapter.validate({ ...entry, name, url: parsed.toString() });
  });
}

// The engine's MCP server map for the granted integrations. A credential present on the worker
// travels as a bearer header for that server only; a missing credential still registers the
// server so OAuth-capable engines can use their own login.
export function integrationServers(integrations, env = process.env) {
  const servers = {};
  for (const integration of integrations) {
    const adapter = integrationAdapter(integration.kind);
    const token = adapter.credential(env, integration);
    servers[integration.name] = { type: 'http', url: integration.url, ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}) };
  }
  return servers;
}

// Prompt notes: what each tool is for and the limits the manifest sets.
export function integrationInstructions(integrations) {
  if (!integrations.length) return '';
  return `External tools connected to this project:\n${integrations.map(integration => `- ${integrationAdapter(integration.kind).instructions(integration)}${integration.roles ? ` Only ${integration.roles.join(', ')} may use it.` : ''}`).join('\n')}\nUse them for the task at hand only; every external write is visible to the owner in the run evidence.`;
}
