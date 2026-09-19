import type { IntegrationAdapter } from './contract.ts';

// Integration adapter for Slack through a remote MCP server. Slack's own hosted MCP endpoint
// is used unless the manifest names another one (for example a self-hosted server that speaks
// the same protocol). The bot token stays on the worker: engines receive it only as a bearer
// header on this server, never as a process variable.
export const slack: IntegrationAdapter = {
  name: 'slack', title: 'Slack', defaultUrl: 'https://mcp.slack.com/mcp',
  credentialVariables: ['SLACK_MCP_TOKEN', 'SLACK_BOT_TOKEN'], manifestKeys: ['channels'],
  validate(config) {
    const channels: unknown = config.channels;
    if (channels !== undefined && (!Array.isArray(channels) || channels.some(name => typeof name !== 'string' || !/^#?[a-z0-9_-]{1,80}$/.test(name)))) throw new Error('Invalid integration configuration: slack.channels must be channel names');
    return config;
  },
  instructions(config) {
    const scope = config.channels?.length ? ` Post only in ${config.channels.map(name => name.startsWith('#') ? name : `#${name}`).join(', ')}.` : '';
    return `Slack (MCP tools ${config.name}_*): read and post workspace messages as the team.${scope} Never post credentials, never message people directly unless the task says so.`;
  },
  credential: env => env.SLACK_MCP_TOKEN ?? env.SLACK_BOT_TOKEN ?? null,
};
