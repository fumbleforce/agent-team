// What a person sees when connecting something in the app: one entry per integration this toolkit supports, with the
// words, fields and checks of that product. The platform renders these generically and never names a provider itself.
type Fetch = typeof fetch;
export type Values = Record<string, string>;
export interface SetupField { key: string; label: string; placeholder?: string; help?: string; required?: boolean; pattern?: string }
export interface SetupEntry {
  kind: string; title: string; category: 'issue-boards' | 'code' | 'comms' | 'storage' | 'business' | 'other';
  summary: string;
  // What the team does with it once connected, in a sentence a non-developer understands.
  does: string[];
  // How to get the credential, in order. Shown as a numbered list.
  steps: string[];
  fields: SetupField[];
  // The secret never enters the app: the person sets this variable where `runsOn` says, and the app only checks that it is there.
  credential: { variable: string; alternatives?: string[]; label: string; runsOn: 'coordinator' | 'workers' } | null;
  // Where the settings go: a plain connection, or the project's tracker or code host.
  target: 'connection' | 'tracker' | 'scm';
  // The adapter's own kind when it differs from the entry's (one product can serve as code host and as tracker).
  adapterKind?: string;
  mode: string;
  test?(values: Values, token: string, request: Fetch): Promise<string>;
}

const ok = async (response: Response, what: string) => { if (!response.ok) throw new Error(`${what} answered ${response.status}. Check the token and what it may access.`); return response; };
const REPOSITORY: SetupField = { key: 'repository', label: 'Repository', placeholder: 'owner/name', help: 'As it appears in the address bar, without the site name.', required: true, pattern: '[\\w.\\-]+(/[\\w.\\-]+)+' };
const BASE: SetupField = { key: 'baseBranch', label: 'Main branch', placeholder: 'main', help: 'Where finished work is merged. Leave empty for "main".' };

export const CATALOG: SetupEntry[] = [
  {
    kind: 'github', title: 'GitHub', category: 'code', target: 'scm', mode: 'read and write',
    summary: 'Where the code lives. The team opens draft pull requests here and merges them when checks and reviews pass.',
    does: ['Pushes each task\'s branch and opens a draft pull request', 'Reads check results and reviews before merging', 'Never force-pushes; merging needs your authorization in the repository\'s .agent-team.json'],
    steps: ['On GitHub open Settings → Developer settings → Fine-grained tokens and create a token for this repository.', 'Give it Contents: read and write, Pull requests: read and write, Checks: read.', 'On every worker machine set GH_TOKEN to that token (or run "gh auth login" there), then restart the worker.'],
    fields: [REPOSITORY, BASE], credential: { variable: 'GH_TOKEN', label: 'GitHub token', runsOn: 'workers' },
  },
  {
    kind: 'gitlab', title: 'GitLab', category: 'code', target: 'scm', mode: 'read and write',
    summary: 'Where the code lives. The team opens draft merge requests here and merges them when pipelines and approvals pass.',
    does: ['Pushes each task\'s branch and opens a draft merge request', 'Reads pipeline results and approvals before merging', 'Never force-pushes; merging needs your authorization in the repository\'s .agent-team.json'],
    steps: ['In GitLab open the project → Settings → Access tokens and create a token with the Developer role.', 'Give it the scopes api and write_repository.', 'On every worker machine set GITLAB_TOKEN to that token (and GITLAB_HOST if you self-host), then restart the worker.'],
    fields: [{ ...REPOSITORY, label: 'Project path', placeholder: 'group/project' }, BASE], credential: { variable: 'GITLAB_TOKEN', label: 'GitLab token', runsOn: 'workers' },
  },
  {
    kind: 'github-issues', adapterKind: 'github', title: 'GitHub Issues', category: 'issue-boards', target: 'tracker', mode: 'two-way',
    summary: 'Use a repository\'s issues as the task board. Issues appear as tasks within a minute.',
    does: ['Every issue becomes a task; closed issues move to Done', 'Labels "agent:in-progress" and "agent:in-review" move a card between columns'],
    steps: ['Create a fine-grained token with Issues: read and write for the repository.', 'On the coordinator machine set GITHUB_ISSUES_TOKEN to that token and restart the coordinator. If GH_TOKEN is already set there it is used instead.'],
    fields: [REPOSITORY], credential: { variable: 'GITHUB_ISSUES_TOKEN', alternatives: ['GH_TOKEN'], label: 'GitHub token', runsOn: 'coordinator' },
    async test(values, token, request) {
      const response = await ok(await request(`https://api.github.com/repos/${values.repository}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'agent-team' } }), 'GitHub');
      const repository = await response.json() as { full_name?: string; open_issues_count?: number; has_issues?: boolean };
      if (repository.has_issues === false) throw new Error('Issues are turned off for this repository. Turn them on under Settings → General → Features.');
      return `Reached ${repository.full_name}: ${repository.open_issues_count ?? 0} open issues and pull requests.`;
    },
  },
  {
    kind: 'linear', title: 'Linear', category: 'issue-boards', target: 'tracker', mode: 'two-way',
    summary: 'Use a Linear project as the task board. Its issues appear as tasks within a minute.',
    does: ['Every issue in the project becomes a task, in the column its Linear state maps to', 'Titles, labels and states follow Linear; who on the team owns a task stays here'],
    steps: ['In Linear open Settings → Security & access → Personal API keys and create a key.', 'On the coordinator machine set LINEAR_API_KEY to that key and restart the coordinator.', 'Open the project in Linear, press Ctrl/Cmd+K, choose "Copy model UUID" and paste it below.'],
    fields: [{ key: 'projectId', label: 'Linear project ID', placeholder: '9d6c1c2e-…', help: 'The UUID copied in step 3, not the project\'s name.', required: true, pattern: '[0-9a-fA-F\\-]{36}' }],
    credential: { variable: 'LINEAR_API_KEY', label: 'Linear API key', runsOn: 'coordinator' },
    async test(values, token, request) {
      const response = await ok(await request('https://api.linear.app/graphql', { method: 'POST', headers: { authorization: token, 'content-type': 'application/json' }, body: JSON.stringify({ query: 'query Project($id: String!) { project(id: $id) { name } }', variables: { id: values.projectId } }) }), 'Linear');
      const name = (await response.json() as { data?: { project?: { name?: string } } }).data?.project?.name;
      if (!name) throw new Error('Linear accepted the key but has no project with that ID. Copy the project\'s UUID, not its name.');
      return `Reached the Linear project "${name}".`;
    },
  },
  {
    kind: 'slack', title: 'Slack', category: 'comms', target: 'connection', mode: 'two-way mirror',
    summary: 'Mirror the team\'s discussion into a Slack channel, and bring replies written there back in.',
    does: ['Every message and decision in the project\'s discussion is posted to the channel', 'What people write in the channel appears in the discussion (needs the optional app-level token)'],
    steps: ['At api.slack.com/apps create an app for your workspace and add the bot scopes chat:write and channels:history.', 'Install it to the workspace and copy the "Bot User OAuth Token" (starts with xoxb-).', 'Invite the app to the channel: type /invite @your-app in that channel.', 'On the coordinator machine set SLACK_BOT_TOKEN to the token and restart the coordinator.', 'Optional, for replies coming back: enable Socket Mode, create an app-level token with connections:write and set AGENT_TEAM_SLACK_APP_TOKEN to it.'],
    fields: [
      { key: 'channel', label: 'Channel', placeholder: '#checkout-team', help: 'The channel the app was invited to.', required: true, pattern: '#?[a-z0-9_\\-]{1,80}' },
      { key: 'channelId', label: 'Channel ID', placeholder: 'C0123456789', help: 'Only needed for replies coming back. Right-click the channel → View channel details; the ID is at the bottom.', pattern: '[A-Z0-9]{8,14}' },
    ],
    credential: { variable: 'SLACK_BOT_TOKEN', label: 'Slack bot token', runsOn: 'coordinator' },
    async test(_values, token, request) {
      const response = await ok(await request('https://slack.com/api/auth.test', { method: 'POST', headers: { authorization: `Bearer ${token}` } }), 'Slack');
      const body = await response.json() as { ok?: boolean; team?: string; user?: string; error?: string };
      if (!body.ok) throw new Error(`Slack refused the token (${body.error ?? 'unknown reason'}).`);
      return `Signed in to the ${body.team} workspace as ${body.user}.`;
    },
  },
  {
    kind: 'google-drive', title: 'Google Drive', category: 'storage', target: 'connection', mode: 'two-way sync',
    summary: 'Keep the project\'s knowledge pages as documents in a Drive folder, in both directions.',
    does: ['Each knowledge page becomes a file in the folder and is updated when the page changes', 'An edit made in Drive becomes a new revision of the page; if both sides changed, both versions are kept'],
    steps: ['In Google Cloud create a service account, enable the Drive API and create an access token for it (or use an OAuth token with the drive.file scope).', 'Share the Drive folder with the service account\'s email address as Editor.', 'On the coordinator machine set GOOGLE_DRIVE_TOKEN to the token and restart the coordinator.', 'Open the folder in Drive; the folder ID is the last part of the address.'],
    fields: [{ key: 'folder', label: 'Folder ID', placeholder: '1AbCdEfGhIjKlMnOpQrStUvWxYz', help: 'The last part of the folder\'s address in Drive.', required: true, pattern: '[\\w\\-]{10,80}' }],
    credential: { variable: 'GOOGLE_DRIVE_TOKEN', label: 'Drive access token', runsOn: 'coordinator' },
    async test(values, token, request) {
      const response = await ok(await request(`https://www.googleapis.com/drive/v3/files/${values.folder}?fields=name,mimeType`, { headers: { authorization: `Bearer ${token}` } }), 'Google Drive');
      const file = await response.json() as { name?: string; mimeType?: string };
      if (file.mimeType !== 'application/vnd.google-apps.folder') throw new Error('That ID is a file, not a folder.');
      return `Reached the folder "${file.name}".`;
    },
  },
  {
    kind: 'hubspot', title: 'HubSpot', category: 'business', target: 'connection', mode: 'agent tool',
    summary: 'Let agents look up and update contacts, companies and deals while they work.',
    does: ['Agents get HubSpot as a tool during their turns', 'Only the record types you list are in reach'],
    steps: ['In HubSpot open Settings → Integrations → Private apps and create an app with the CRM scopes you want the team to have.', 'On every worker machine set HUBSPOT_MCP_TOKEN to the app\'s access token and restart the worker.'],
    fields: [{ key: 'objects', label: 'Record types', placeholder: 'contacts, companies, deals', help: 'Comma-separated. Leave empty for everything the token allows.' }],
    credential: { variable: 'HUBSPOT_MCP_TOKEN', label: 'HubSpot private app token', runsOn: 'workers' },
  },
  {
    kind: 'mcp', title: 'Any other tool (MCP server)', category: 'other', target: 'connection', mode: 'agent tool',
    summary: 'Connect any product that offers an MCP server, so agents can use it as a tool.',
    does: ['Agents get the server\'s tools during their turns', 'The token, if the server needs one, is sent only to that server'],
    steps: ['Find the product\'s MCP server address (it starts with https://).', 'If it needs a token: on every worker machine set the variable shown below to that token and restart the worker.'],
    fields: [
      { key: 'name', label: 'Short name', placeholder: 'figma', help: 'Lowercase, no spaces. Agents see the tools under this name.', required: true, pattern: '[a-z][a-z0-9\\-]{0,31}' },
      { key: 'url', label: 'Server address', placeholder: 'https://mcp.example.com/mcp', required: true, pattern: 'https://.+' },
      { key: 'purpose', label: 'What the team should use it for', placeholder: 'Read design files linked from a task' },
    ],
    credential: null,
  },
];

export const setupEntry = (kind: string): SetupEntry | null => CATALOG.find(entry => entry.kind === kind) ?? null;
// The variable an "any other tool" connection reads its token from, derived from its short name.
export const customCredentialVariable = (name: string) => `${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_MCP_TOKEN`;
