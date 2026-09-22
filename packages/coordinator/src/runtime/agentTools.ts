import type { Tx } from '@agent-team/storage';
import { connectionIntegration, integrationInstructions, integrationServers } from '../../../../adapters/integration/index.ts';
import type { Integration } from '../../../../adapters/integration/contract.ts';

type Reader = Pick<Tx, 'selectFrom'>;
// What a worker is handed for one turn: the servers its engine may reach, each with its bearer header when the platform holds the token.
export interface TurnTool { name: string; kind: string; url: string; headers?: { Authorization: string } }
export const AGENT_TOOL = 'agent tool';

// The external tools a seat may use in a turn: the connections of mode "agent tool" of its project, the project's parent and the whole
// organization, the nearest one winning a name, kept to the seats whose roles the connection names when it names any.
export async function agentTools(tx: Reader, agentId: string, projectId: string): Promise<{ integration: Integration; variable: string | null }[]> {
  const project = await tx.selectFrom('projects').select('parent_id').where('id', '=', projectId).executeTakeFirst();
  const scopes = [projectId, ...(project?.parent_id ? [project.parent_id] : [])];
  const rows = await tx.selectFrom('connections').select(['project_id', 'kind', 'config', 'credential_ref', 'created_at']).where('mode', '=', AGENT_TOOL)
    .where(eb => eb.or([eb('project_id', 'in', scopes), eb('project_id', 'is', null)])).orderBy('created_at', 'desc').execute();
  if (rows.length === 0) return [];
  const roles = new Set((await tx.selectFrom('agent_roles').select('role_slug').where('agent_id', '=', agentId).execute()).map(row => row.role_slug));
  const nearness = (scope: string | null) => (scope === null ? scopes.length : scopes.indexOf(scope));
  const found = new Map<string, { integration: Integration; variable: string | null }>();
  for (const row of rows.sort((a, b) => nearness(a.project_id) - nearness(b.project_id))) {
    const tool = connectionIntegration({ kind: row.kind, config: JSON.parse(row.config) as Record<string, unknown>, credentialRef: row.credential_ref });
    if (!tool || found.has(tool.integration.name)) continue;
    if (!tool.integration.roles || tool.integration.roles.some(role => roles.has(role))) found.set(tool.integration.name, tool);
  }
  return [...found.values()];
}

// The servers for the worker, with each token read from where the platform keeps it. Never part of the packet or any stored row.
export function turnTools(tools: { integration: Integration; variable: string | null }[], secret: (name: string) => string | null): TurnTool[] {
  const env = Object.fromEntries(tools.flatMap(tool => { const value = tool.variable ? secret(tool.variable) : null; return value ? [[tool.variable!, value]] : []; }));
  const servers = integrationServers(tools.map(tool => tool.integration), env);
  return tools.map(({ integration }) => ({ name: integration.name, kind: integration.kind, url: integration.url, ...(servers[integration.name]?.headers ? { headers: servers[integration.name]!.headers! } : {}) }));
}

// What the seat is told about its tools, in the packet: which are connected and what each is for. Names and rules only.
export async function toolsPart(tx: Reader, agentId: string, projectId: string): Promise<string> {
  return integrationInstructions((await agentTools(tx, agentId, projectId)).map(tool => tool.integration));
}
