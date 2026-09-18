// Integration adapter for Google Drive through a remote MCP server. There is no single public
// endpoint every account can use, so the manifest names the server (a hosted connector or a
// self-hosted one); an OAuth access token or service credential is passed as a bearer header.
export const NAME = 'google-drive';
export const TITLE = 'Google Drive';
export const DEFAULT_URL = null;
export const CREDENTIAL_VARIABLES = ['GOOGLE_DRIVE_MCP_TOKEN'];
export const MANIFEST_KEYS = ['folders'];

export function validate(config) {
  if (config.folders !== undefined && (!Array.isArray(config.folders) || config.folders.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{5,128}$/.test(id)))) throw new Error('Invalid integration configuration: google-drive.folders must be folder identifiers');
  return config;
}

export function instructions(config) {
  const scope = config.folders?.length ? ` Work inside folder${config.folders.length === 1 ? '' : 's'} ${config.folders.join(', ')} only.` : '';
  return `Google Drive (MCP tools ${config.name}_*): read, create and update documents and spreadsheets.${scope} Never change sharing permissions or delete files.`;
}

export function credential(env) { return env.GOOGLE_DRIVE_MCP_TOKEN ?? null; }
