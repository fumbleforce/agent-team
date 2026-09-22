// What a person sees when connecting something in the app: one entry per integration this toolkit supports, with the
// words, fields and checks of that product. The platform renders these generically and never names a provider itself.
import { githubCredential } from '../tracker/githubCredential.ts';
import { hubspot } from './hubspot.ts';
import { listTools } from './mcp.ts';

type Fetch = typeof fetch;
export type Values = Record<string, string>;
// What a field can be picked from once the credential is known, so nobody copies an ID by hand. `also` fills other fields of the same entry.
export interface Choice { value: string; label: string; also?: Values }
export interface SetupField { key: string; label: string; placeholder?: string; help?: string; required?: boolean; pattern?: string; /* Filled in by picking another field from its list; asked for only when that list cannot be had. */ filledBy?: string; choices?(token: string, request: Fetch): Promise<Choice[]> }
export interface SetupEntry {
  kind: string; title: string; category: 'issue-boards' | 'code' | 'comms' | 'storage' | 'business' | 'other';
  summary: string;
  // How to get the credential, as briefly as it can be said. Shown only when asked for.
  steps: string[];
  fields: SetupField[];
  // A credential the coordinator uses is typed into the app and kept sealed; the same variable set on the machine still counts.
  // One that only workers use stays with the sign-in on the worker.
  credential: { variable: string; alternatives?: string[]; label: string; runsOn: 'coordinator' | 'workers'; getAt?: string; placeholder?: string } | null;
  // Where the settings go: a plain connection, or the project's tracker or code host.
  target: 'connection' | 'tracker' | 'scm';
  // Entries of one product (its code host and its issues, say) share what was entered: a value known for one is never asked for by another.
  product?: string;
  // A way to find the credential on this machine besides the variable: an existing login, say. Returns the token or null.
  findCredential?(env: NodeJS.ProcessEnv): { token: string; source: string } | null;
  // The adapter's own kind when it differs from the entry's (one product can serve as code host and as tracker).
  adapterKind?: string;
  mode: string;
  test?(values: Values, token: string, request: Fetch): Promise<string>;
}

const ok = async (response: Response, what: string) => { if (!response.ok) throw new Error(`${what} answered ${response.status}. Check the token and what it may access.`); return response; };
const REPOSITORY: SetupField = { key: 'repository', label: 'Repository', placeholder: 'owner/name', required: true, pattern: '[\\w.\\-]+(/[\\w.\\-]+)+' };
const BASE: SetupField = { key: 'baseBranch', label: 'Main branch', placeholder: 'main' };
// A tool agents use can be kept to some of the team: only seats that hold one of these roles are given it.
const ROLES: SetupField = { key: 'roles', label: 'Only for these roles', placeholder: 'sales, marketing', help: 'Leave empty to let everyone on the team use it.', pattern: '[a-z][a-z0-9\\-]*([\\s,]+[a-z][a-z0-9\\-]*)*' };
const HUBSPOT_OBJECTS = '(contacts|companies|deals|tickets|notes|tasks)';

export const CATALOG: SetupEntry[] = [
  {
    kind: 'github', product: 'github', title: 'GitHub', category: 'code', target: 'scm', mode: 'read and write',
    summary: 'Where the code lives. The team opens pull requests here.',
    steps: ['Workers push with the GitHub sign-in already on their machine. If a worker has none, run "gh auth login" there.'],
    fields: [REPOSITORY, BASE], credential: { variable: 'GH_TOKEN', label: 'GitHub token', runsOn: 'workers' },
  },
  {
    kind: 'gitlab', product: 'gitlab', title: 'GitLab', category: 'code', target: 'scm', mode: 'read and write',
    summary: 'Where the code lives. The team opens merge requests here.',
    steps: ['Workers push with the GitLab sign-in on their machine. If a worker has none, run "glab auth login" there.'],
    fields: [{ ...REPOSITORY, label: 'Project path', placeholder: 'group/project' }, BASE], credential: { variable: 'GITLAB_TOKEN', label: 'GitLab token', runsOn: 'workers' },
  },
  {
    kind: 'github-issues', adapterKind: 'github', product: 'github', title: 'GitHub Issues', category: 'issue-boards', target: 'tracker', mode: 'two-way',
    findCredential: env => { const found = githubCredential(env); return found ? { token: found.token, source: found.source === 'cli' ? 'the GitHub command-line login on this machine' : 'a variable on this machine' } : null; },
    summary: 'Use a repository\'s issues as the task board.',
    steps: ['On GitHub: Settings → Developer settings → Fine-grained tokens → Generate new token.', 'Select the repository and allow Issues: read and write.'],
    fields: [{ ...REPOSITORY, async choices(token, request) {
      const response = await ok(await request('https://api.github.com/user/repos?per_page=100&sort=pushed', { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'agent-team' } }), 'GitHub');
      return ((await response.json()) as { full_name: string }[]).map(repository => ({ value: repository.full_name, label: repository.full_name }));
    } }], credential: { variable: 'GITHUB_ISSUES_TOKEN', alternatives: ['GH_TOKEN'], label: 'GitHub token', runsOn: 'coordinator', getAt: 'https://github.com/settings/personal-access-tokens/new', placeholder: 'github_pat_…' },
    async test(values, token, request) {
      const response = await ok(await request(`https://api.github.com/repos/${values.repository}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'agent-team' } }), 'GitHub');
      const repository = await response.json() as { full_name?: string; open_issues_count?: number; has_issues?: boolean };
      if (repository.has_issues === false) throw new Error('Issues are turned off for this repository. Turn them on under Settings → General → Features.');
      return `Reached ${repository.full_name}: ${repository.open_issues_count ?? 0} open issues and pull requests.`;
    },
  },
  {
    kind: 'linear', title: 'Linear', category: 'issue-boards', target: 'tracker', mode: 'two-way',
    summary: 'Use a Linear project as the task board.',
    steps: ['In Linear: Settings → Security & access → Personal API keys → New key.'],
    fields: [{ key: 'projectId', label: 'Project', placeholder: '9d6c1c2e-…', required: true, pattern: '[0-9a-fA-F\\-]{36}', async choices(token, request) {
      const response = await ok(await request('https://api.linear.app/graphql', { method: 'POST', headers: { authorization: token, 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ projects(first: 100) { nodes { id name } } }' }) }), 'Linear');
      return ((await response.json()) as { data?: { projects?: { nodes?: { id: string; name: string }[] } } }).data?.projects?.nodes?.map(project => ({ value: project.id, label: project.name })) ?? [];
    } }],
    credential: { variable: 'LINEAR_API_KEY', label: 'Linear API key', runsOn: 'coordinator', getAt: 'https://linear.app/settings/account/security', placeholder: 'lin_api_…' },
    async test(values, token, request) {
      const response = await ok(await request('https://api.linear.app/graphql', { method: 'POST', headers: { authorization: token, 'content-type': 'application/json' }, body: JSON.stringify({ query: 'query Project($id: String!) { project(id: $id) { name } }', variables: { id: values.projectId } }) }), 'Linear');
      const name = (await response.json() as { data?: { project?: { name?: string } } }).data?.project?.name;
      if (!name) throw new Error('Linear accepted the key but has no project with that ID. Copy the project\'s UUID, not its name.');
      return `Reached the Linear project "${name}".`;
    },
  },
  {
    kind: 'slack', title: 'Slack', category: 'comms', target: 'connection', mode: 'two-way mirror',
    summary: 'Mirror the team\'s discussion into a channel.',
    steps: ['At api.slack.com/apps create an app with the bot scopes chat:write and channels:history, and install it.', 'Copy the bot token (xoxb-…) and invite the app to the channel.'],
    fields: [
      { key: 'channel', label: 'Channel', placeholder: '#checkout-team', required: true, pattern: '#?[a-z0-9_\\-]{1,80}', async choices(token, request) {
        const response = await ok(await request('https://slack.com/api/conversations.list?types=public_channel&exclude_archived=true&limit=200', { headers: { authorization: `Bearer ${token}` } }), 'Slack');
        return ((await response.json()) as { channels?: { id: string; name: string }[] }).channels?.map(channel => ({ value: `#${channel.name}`, label: `#${channel.name}`, also: { channelId: channel.id } })) ?? [];
      } },
      { key: 'channelId', filledBy: 'channel', label: 'Channel ID', placeholder: 'C0123456789', help: 'Only for replies coming back.', pattern: '[A-Z0-9]{8,14}' },
    ],
    credential: { variable: 'SLACK_BOT_TOKEN', label: 'Slack bot token', runsOn: 'coordinator', getAt: 'https://api.slack.com/apps', placeholder: 'xoxb-…' },
    async test(_values, token, request) {
      const response = await ok(await request('https://slack.com/api/auth.test', { method: 'POST', headers: { authorization: `Bearer ${token}` } }), 'Slack');
      const body = await response.json() as { ok?: boolean; team?: string; user?: string; error?: string };
      if (!body.ok) throw new Error(`Slack refused the token (${body.error ?? 'unknown reason'}).`);
      return `Signed in to the ${body.team} workspace as ${body.user}.`;
    },
  },
  {
    kind: 'google-drive', title: 'Google Drive', category: 'storage', target: 'connection', mode: 'two-way sync',
    summary: 'Keep knowledge pages as documents in a Drive folder.',
    steps: ['Share the folder with a service account as Editor.', 'Paste an access token for it with the Drive scope. Google\'s tokens expire after an hour.'],
    fields: [{ key: 'folder', label: 'Folder ID', placeholder: '1AbCdEfGhIjKlMnOpQrStUvWxYz', help: 'The last part of the folder\'s address.', required: true, pattern: '[\\w\\-]{10,80}' }],
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
    summary: 'Agents look up and update contacts, companies and deals.',
    steps: ['In HubSpot: Settings → Integrations → Private Apps → Create a private app.', 'Under Scopes, allow reading and writing the CRM records the team should reach, then create the app.', 'Copy its access token and paste it here.'],
    fields: [{ key: 'objects', label: 'Record types', placeholder: 'contacts, companies, deals', help: 'Leave empty to allow all of them.', pattern: `${HUBSPOT_OBJECTS}([\\s,]+${HUBSPOT_OBJECTS})*` }, ROLES],
    credential: { variable: 'HUBSPOT_MCP_TOKEN', alternatives: ['HUBSPOT_ACCESS_TOKEN'], label: 'HubSpot private app token', runsOn: 'coordinator', placeholder: 'pat-…' },
    async test(_values, token, request) {
      const tools = await listTools(hubspot.defaultUrl!, token, request);
      return tools.length ? `Signed in to HubSpot. The team can use ${tools.length} of its tools.` : 'Signed in to HubSpot, but it offers no tools to this token. Check the app\'s scopes.';
    },
  },
  {
    kind: 'mcp', title: 'Any other tool (MCP server)', category: 'other', target: 'connection', mode: 'agent tool',
    summary: 'Any product with an MCP server, as a tool for agents.',
    steps: ['Paste the server\'s address. If it needs a token, set the variable named after it on each worker.'],
    fields: [
      { key: 'name', label: 'Short name', placeholder: 'figma', required: true, pattern: '[a-z][a-z0-9\\-]{0,31}' },
      { key: 'url', label: 'Server address', placeholder: 'https://mcp.example.com/mcp', required: true, pattern: 'https://.+' },
      { key: 'purpose', label: 'What the team should use it for', placeholder: 'Read design files linked from a task' },
      ROLES,
    ],
    credential: null,
  },
];

export const setupEntry = (kind: string): SetupEntry | null => CATALOG.find(entry => entry.kind === kind) ?? null;
// The variable an "any other tool" connection reads its token from, derived from its short name.
export const customCredentialVariable = (name: string) => `${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_MCP_TOKEN`;
