import type { IntegrationAdapter } from './contract.ts';

// The credential variable is derived from the name so several generic servers can coexist
// (name "crm" reads CRM_MCP_TOKEN).
export function credentialVariable(name: string): string { return `${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_MCP_TOKEN`; }

// Generic integration: any remote MCP server the owner operates or subscribes to. The manifest
// names it and its URL.
export const mcp: IntegrationAdapter = {
  name: 'mcp', title: 'MCP server', defaultUrl: null,
  credentialVariables: [], manifestKeys: ['purpose'],
  validate(config) {
    const purpose: unknown = config.purpose;
    if (purpose !== undefined && (typeof purpose !== 'string' || purpose.length > 400)) throw new Error('Invalid integration configuration: mcp.purpose must be a short sentence');
    return config;
  },
  instructions: config => `${config.name} (MCP tools ${config.name}_*): ${config.purpose ?? 'an external tool the owner connected'}.`,
  credential: (env, config) => env[credentialVariable(config.name)] ?? null,
};
