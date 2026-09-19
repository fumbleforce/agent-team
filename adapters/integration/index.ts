import type { Env, Integration, IntegrationAdapter, McpServer } from './contract.ts';
import { slack } from './slack.ts';
import { googleDrive } from './google-drive.ts';
import { hubspot } from './hubspot.ts';
import { credentialVariable, mcp } from './mcp.ts';

const ADAPTERS: Record<string, IntegrationAdapter> = { slack, 'google-drive': googleDrive, hubspot, mcp };
export const INTEGRATION_KINDS = Object.keys(ADAPTERS);
const NAME = /^[a-z][a-z0-9-]{0,31}$/;
// Names already used for MCP servers or that engines treat specially.
const RESERVED = new Set(['tracker', 'memory', 'team']);

export function integrationAdapter(kind: unknown): IntegrationAdapter {
  const adapter = typeof kind === 'string' && Object.hasOwn(ADAPTERS, kind) ? ADAPTERS[kind] : undefined;
  if (!adapter) throw new Error(`Unknown integration kind: ${String(kind)}. Use ${INTEGRATION_KINDS.join(', ')}`);
  return adapter;
}

// Every credential variable any integration reads; the worker strips all of them from the
// model process, whichever integrations a project grants.
export function credentialVariables(integrations: readonly Integration[] = []): string[] {
  const names = new Set(Object.values(ADAPTERS).flatMap(adapter => adapter.credentialVariables));
  for (const integration of integrations) if (integration.kind === 'mcp') names.add(credentialVariable(integration.name));
  return [...names];
}

// Normalizes the manifest's integrations section: each entry names a known kind, has a unique
// MCP name and a valid https URL, and passes the adapter's own checks.
export function validateIntegrations(list: unknown): Integration[] {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.length > 16) throw new Error('Invalid .agent-team.json: integrations must be an array of at most 16 entries');
  const seen = new Set<string>();
  return list.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid .agent-team.json: each integration is an object');
    const raw = entry as Record<string, unknown>;
    const adapter = integrationAdapter(raw.kind);
    const name = raw.name ?? raw.kind;
    if (typeof name !== 'string' || !NAME.test(name) || RESERVED.has(name)) throw new Error(`Invalid .agent-team.json: integration name ${JSON.stringify(name)}`);
    if (seen.has(name)) throw new Error(`Invalid .agent-team.json: duplicate integration name ${name}`);
    seen.add(name);
    const url = raw.url ?? adapter.defaultUrl;
    if (typeof url !== 'string') throw new Error(`Invalid .agent-team.json: integration ${name} (${adapter.name}) requires url`);
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error(`Invalid .agent-team.json: integration ${name} url`); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) throw new Error(`Invalid .agent-team.json: integration ${name} url must be https without credentials`);
    for (const key of Object.keys(raw)) if (!['kind', 'name', 'url', 'roles', ...adapter.manifestKeys].includes(key)) throw new Error(`Invalid .agent-team.json: integration ${name} has unknown key ${key}`);
    const roles = raw.roles;
    if (roles !== undefined && (!Array.isArray(roles) || !roles.length || roles.some(role => typeof role !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(role)))) throw new Error(`Invalid .agent-team.json: integration ${name} roles`);
    // The adapter checks its own keys, so the cast is confirmed before the entry is returned.
    return adapter.validate({ ...raw, kind: adapter.name, name, url: parsed.toString() } as Integration);
  });
}

// The engine's MCP server map for the granted integrations. A credential present on the worker
// travels as a bearer header for that server only; a missing credential still registers the
// server so OAuth-capable engines can use their own login.
export function integrationServers(integrations: readonly Integration[], env: Env = process.env): Record<string, McpServer> {
  const servers: Record<string, McpServer> = {};
  for (const integration of integrations) {
    const token = integrationAdapter(integration.kind).credential(env, integration);
    servers[integration.name] = { type: 'http', url: integration.url, ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}) };
  }
  return servers;
}

// Prompt notes: what each tool is for and the limits the manifest sets.
export function integrationInstructions(integrations: readonly Integration[]): string {
  if (!integrations.length) return '';
  return `External tools connected to this project:\n${integrations.map(integration => `- ${integrationAdapter(integration.kind).instructions(integration)}${integration.roles ? ` Only ${integration.roles.join(', ')} may use it.` : ''}`).join('\n')}\nUse them for the task at hand only; every external write is visible to the owner in the run evidence.`;
}
