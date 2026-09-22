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

// Asks a remote MCP server which tools it offers, the way an engine does when a turn starts: initialize, then tools/list, with the token
// as the bearer header. A server may answer as JSON or as a short event stream; both are read. Throws a sentence a person can act on.
export async function listTools(url: string, token: string, request: typeof fetch = fetch): Promise<{ name: string }[]> {
  let session: string | null = null, id = 0;
  const call = async (method: string, params: Record<string, unknown> = {}, notify = false) => {
    const response = await request(url, { method: 'POST', signal: AbortSignal.timeout(15_000), body: JSON.stringify({ jsonrpc: '2.0', method, params, ...(notify ? {} : { id: ++id }) }),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}) } });
    if (response.status === 401 || response.status === 403) throw new Error('The server refused the token. Check that it is current and may use the tools.');
    if (!response.ok) throw new Error(`The server answered ${response.status}. Check the address.`);
    session = response.headers.get('mcp-session-id') ?? session;
    if (notify) return {};
    const body = await response.text();
    const messages = (response.headers.get('content-type') ?? '').includes('text/event-stream') ? body.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()) : [body];
    const answer = messages.map(text => { try { return JSON.parse(text) as { id?: number; result?: Record<string, unknown>; error?: { message?: string } }; } catch { return null; } }).find(message => message?.id === id);
    if (!answer) throw new Error('The server did not answer like an MCP server. Check the address.');
    if (answer.error) throw new Error(`The server said: ${answer.error.message ?? 'an error'}.`);
    return answer.result ?? {};
  };
  await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agent-team', version: '1' } });
  await call('notifications/initialized', {}, true);
  const tools = (await call('tools/list')).tools;
  return Array.isArray(tools) ? tools as { name: string }[] : [];
}
