// Integration adapter for HubSpot through its hosted remote MCP server. A private app token is
// sent as the bearer header; engines never see it as a process variable.
export const NAME = 'hubspot';
export const TITLE = 'HubSpot';
export const DEFAULT_URL = 'https://mcp.hubspot.com/';
export const CREDENTIAL_VARIABLES = ['HUBSPOT_MCP_TOKEN', 'HUBSPOT_ACCESS_TOKEN'];
export const MANIFEST_KEYS = ['objects'];

export function validate(config) {
  if (config.objects !== undefined && (!Array.isArray(config.objects) || config.objects.some(name => !['contacts', 'companies', 'deals', 'tickets', 'notes', 'tasks'].includes(name)))) throw new Error('Invalid integration configuration: hubspot.objects must list contacts, companies, deals, tickets, notes or tasks');
  return config;
}

export function instructions(config) {
  const scope = config.objects?.length ? ` Touch only ${config.objects.join(', ')}.` : '';
  return `HubSpot (MCP tools ${config.name}_*): read and update CRM records.${scope} Never delete records or send email campaigns.`;
}

export function credential(env) { return env.HUBSPOT_MCP_TOKEN ?? env.HUBSPOT_ACCESS_TOKEN ?? null; }
