// An integration is an external tool the team may use during a run, reached through a remote
// MCP server. The manifest lists them; the worker turns the list into the engine's MCP map and
// prompt notes, and strips every integration credential the manifest did not grant.
export interface Integration { kind: string; name: string; url: string; roles?: string[]; channels?: string[]; folders?: string[]; objects?: string[]; purpose?: string }
export type Env = Record<string, string | undefined>;
export interface McpServer { type: 'http'; url: string; headers?: { Authorization: string } }

export interface IntegrationAdapter {
  name: string; title: string;
  defaultUrl: string | null;
  // Every variable the adapter may read; all are stripped from the model process.
  credentialVariables: readonly string[];
  // Manifest keys this kind accepts besides kind, name, url and roles.
  manifestKeys: readonly string[];
  // Checks the kind's own keys; throws on an invalid value.
  validate(config: Integration): Integration;
  instructions(config: Integration): string;
  credential(env: Env, config: Integration): string | null;
}
