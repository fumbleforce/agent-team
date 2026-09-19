import type { IntegrationAdapter } from './contract.ts';

// Integration adapter for Google Drive through a remote MCP server. There is no single public
// endpoint every account can use, so the manifest names the server (a hosted connector or a
// self-hosted one); an OAuth access token or service credential is passed as a bearer header.
export const googleDrive: IntegrationAdapter = {
  name: 'google-drive', title: 'Google Drive', defaultUrl: null,
  credentialVariables: ['GOOGLE_DRIVE_MCP_TOKEN'], manifestKeys: ['folders'],
  validate(config) {
    const folders: unknown = config.folders;
    if (folders !== undefined && (!Array.isArray(folders) || folders.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{5,128}$/.test(id)))) throw new Error('Invalid integration configuration: google-drive.folders must be folder identifiers');
    return config;
  },
  instructions(config) {
    const scope = config.folders?.length ? ` Work inside folder${config.folders.length === 1 ? '' : 's'} ${config.folders.join(', ')} only.` : '';
    return `Google Drive (MCP tools ${config.name}_*): read, create and update documents and spreadsheets.${scope} Never change sharing permissions or delete files.`;
  },
  credential: env => env.GOOGLE_DRIVE_MCP_TOKEN ?? null,
};
