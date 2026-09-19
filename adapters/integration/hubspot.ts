import type { IntegrationAdapter } from './contract.ts';

const OBJECTS = ['contacts', 'companies', 'deals', 'tickets', 'notes', 'tasks'];

// Integration adapter for HubSpot through its hosted remote MCP server. A private app token is
// sent as the bearer header; engines never see it as a process variable.
export const hubspot: IntegrationAdapter = {
  name: 'hubspot', title: 'HubSpot', defaultUrl: 'https://mcp.hubspot.com/',
  credentialVariables: ['HUBSPOT_MCP_TOKEN', 'HUBSPOT_ACCESS_TOKEN'], manifestKeys: ['objects'],
  validate(config) {
    const objects: unknown = config.objects;
    if (objects !== undefined && (!Array.isArray(objects) || objects.some(name => !OBJECTS.includes(name)))) throw new Error('Invalid integration configuration: hubspot.objects must list contacts, companies, deals, tickets, notes or tasks');
    return config;
  },
  instructions(config) {
    const scope = config.objects?.length ? ` Touch only ${config.objects.join(', ')}.` : '';
    return `HubSpot (MCP tools ${config.name}_*): read and update CRM records.${scope} Never delete records or send email campaigns.`;
  },
  credential: env => env.HUBSPOT_MCP_TOKEN ?? env.HUBSPOT_ACCESS_TOKEN ?? null,
};
