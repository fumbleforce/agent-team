// Generic integration: any remote MCP server the owner operates or subscribes to. The manifest
// names it and its URL; the credential variable is derived from the name so several generic
// servers can coexist (name "crm" reads CRM_MCP_TOKEN).
export const NAME = 'mcp';
export const TITLE = 'MCP server';
export const DEFAULT_URL = null;
export const CREDENTIAL_VARIABLES = [];
export const MANIFEST_KEYS = ['purpose'];

export function credentialVariable(name) { return `${String(name).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_MCP_TOKEN`; }

export function validate(config) {
  if (config.purpose !== undefined && (typeof config.purpose !== 'string' || config.purpose.length > 400)) throw new Error('Invalid integration configuration: mcp.purpose must be a short sentence');
  return config;
}

export function instructions(config) {
  return `${config.name} (MCP tools ${config.name}_*): ${config.purpose ?? 'an external tool the owner connected'}.`;
}

export function credential(env, config) { return env[credentialVariable(config.name)] ?? null; }
