import { validateIdeation, validateProposals } from '../../core/idea-schema.mjs';
export { validateIdeation } from '../../core/idea-schema.mjs';

export const NAME = 'linear';
export const ISSUE_PATTERN = /^[A-Z][A-Z0-9]*-[1-9][0-9]*$/;
export const API_KEY_VARIABLE = 'LINEAR_API_KEY';

// The tracker's MCP server, exposed to engines under the neutral name `tracker`.
export function mcpServers() { return { tracker: { type: 'http', url: 'https://mcp.linear.app/mcp' } }; }

// Manifest fields this tracker needs; core validates presence, the adapter validates meaning.
export const MANIFEST_KEYS = ['workspaceId', 'workspaceUrl', 'teamId', 'projectId', 'projectUrl', 'readyLabel'];

export function validateManifest(tracker) {
  for (const key of MANIFEST_KEYS) if (typeof tracker[key] !== 'string' || !tracker[key].trim()) throw new Error(`Invalid tracker configuration: ${key} is required`);
  for (const key of ['workspaceUrl', 'projectUrl']) if (!/^https:\/\/[^\s]+$/.test(tracker[key])) throw new Error(`Invalid tracker configuration ${key}`);
  return tracker;
}

// Prompt text telling roles how to scope tracker access for this project.
export function scopeInstructions(tracker) {
  return `The issue tracker is Linear, reached through the tracker MCP tools. Work inside workspace ${tracker.workspaceId} (${tracker.workspaceUrl}), team ${tracker.teamId}, project ${tracker.projectId} (${tracker.projectUrl}); verify the connected workspace ID matches before any writes and never guess a different scope. Ready work carries the label ${tracker.readyLabel}.`;
}

const page = 'pageInfo { hasNextPage endCursor }';
const relationFields = `nodes { type issue { id archivedAt state { type } } } ${page}`;
const issueFields = `id identifier title description updatedAt archivedAt state { id name type }
  labels(first: 100) { nodes { id name } ${page} } parent { id } project { id } team { id }
  inverseRelations(first: 100) { ${relationFields} }`;
const terminal = state => ['completed', 'canceled'].includes(state?.type);
const titleKey = title => title.trim().normalize('NFKC').toLowerCase();
// Shared role conventions: either label means a human decision or repair is pending.
const HOLD_LABELS = ['agent:blocked', 'owner:decision'];

export function approvalStatus(manifest, issue) {
  const config = validateIdeation(manifest.ideation);
  if (!issue || issue.archivedAt || issue.parentId || issue.projectId !== manifest.projectId || issue.teamId !== manifest.teamId || !issue.labels.some(label => label.name === config.ideaLabel)) return { allowed: false, reason: 'Not an active root project idea' };
  if (issue.state?.name !== config.approvedState || terminal(issue.state)) return { allowed: false, reason: 'Owner approval required' };
  if (issue.labels.some(label => HOLD_LABELS.includes(label.name))) return { allowed: false, reason: 'Idea is on hold for a decision or repair' };
  if (issue.blocked !== false) return { allowed: false, reason: 'Idea is blocked or blocker status is unknown' };
  return { allowed: true, reason: 'Owner approved' };
}

export function createClient({ apiKey = process.env.LINEAR_API_KEY, fetchImpl = fetch } = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim() || /\s/.test(apiKey)) throw new Error('LINEAR_API_KEY is required');
  async function request(query, variables = {}) {
    // Never surface server bodies, GraphQL messages, or fetch errors: they may contain credentials.
    let response;
    try { response = await fetchImpl('https://api.linear.app/graphql', { method: 'POST', headers: { authorization: apiKey, 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(30_000) }); }
    catch { throw new Error('Linear network request failed'); }
    if (!response.ok) throw new Error('Linear HTTP request failed');
    let payload;
    try { payload = await response.json(); } catch { throw new Error('Invalid Linear response'); }
    if (payload.errors?.length || !payload.data) throw new Error('Linear GraphQL request failed');
    return payload.data;
  }
  // The workspace, its teams and their projects: what guided setup offers to choose from.
  async function scopes() {
    const data = await request('query Scopes { organization { id urlKey } teams(first: 50) { nodes { id name key projects(first: 100) { nodes { id name url } } } } }');
    return { workspaceId: data.organization.id, workspaceUrl: `https://linear.app/${data.organization.urlKey}`,
      teams: data.teams.nodes.map(team => ({ id: team.id, name: team.name, key: team.key, projects: team.projects.nodes.map(project => ({ id: project.id, name: project.name, url: project.url })) })) };
  }
  async function collect(first, more) {
    const nodes = []; const cursors = new Set(); let connection = first;
    while (true) {
      if (!connection || !Array.isArray(connection.nodes) || !connection.pageInfo) throw new Error('Incomplete Linear connection');
      nodes.push(...connection.nodes);
      if (!connection.pageInfo.hasNextPage) return nodes;
      const cursor = connection.pageInfo.endCursor;
      if (!cursor || cursors.has(cursor)) throw new Error('Invalid Linear pagination');
      cursors.add(cursor); connection = await more(cursor);
    }
  }
  async function context(manifest) {
    const config = validateIdeation(manifest.ideation);
    for (const key of ['workspaceId', 'projectId', 'teamId', 'readyLabel']) if (typeof manifest[key] !== 'string' || !manifest[key].trim()) throw new Error('Missing Linear configuration');
    const org = await request('query Organization { organization { id } }');
    if (org.organization?.id !== manifest.workspaceId) throw new Error('Linear workspace mismatch');
    const data = await request(`query Context($projectId: String!, $teamId: String!) {
      project(id: $projectId) { id teams(first: 100) { nodes { id } ${page} } }
      team(id: $teamId) { id states(first: 100) { nodes { id name type } ${page} } labels(first: 100) { nodes { id name } ${page} } }
    }`, { projectId: manifest.projectId, teamId: manifest.teamId });
    if (data.project?.id !== manifest.projectId || data.team?.id !== manifest.teamId) throw new Error('Linear project/team mismatch');
    const teams = await collect(data.project.teams, async after => (await request(`query ProjectTeams($id: String!, $after: String!) { project(id: $id) { teams(first: 100, after: $after) { nodes { id } ${page} } } }`, { id: manifest.projectId, after })).project.teams);
    if (!teams.some(team => team.id === manifest.teamId)) throw new Error('Linear project team membership mismatch');
    const connections = {};
    for (const field of ['states', 'labels']) connections[field] = await collect(data.team[field], async after => (await request(`query TeamConnection($id: String!, $after: String!) { team(id: $id) { ${field}(first: 100, after: $after) { nodes { id name ${field === 'states' ? 'type' : ''} } ${page} } } }`, { id: manifest.teamId, after })).team[field]);
    // Names come from the manifest, not from Linear responses, so they are safe to report.
    const resolve = (items, name, kind) => { const matches = items.filter(item => item.name === name); if (matches.length !== 1) throw new Error(`Required Linear ${kind} "${name}" is ${matches.length ? 'ambiguous' : 'missing'} in the configured team`); return matches[0]; };
    const states = Object.fromEntries(['proposedState', 'approvedState', 'rejectedState'].map(key => [key, resolve(connections.states, config[key], 'workflow state')]));
    if (states.proposedState.type !== 'backlog' || states.approvedState.type !== 'unstarted' || states.rejectedState.type !== 'canceled') throw new Error('Unsafe Linear approval workflow state types');
    const ideaLabel = resolve(connections.labels, config.ideaLabel, 'label'); const readyLabel = resolve(connections.labels, manifest.readyLabel, 'label');
    if (ideaLabel.id === readyLabel.id) throw new Error('Idea and ready labels must differ');
    return { workspaceId: org.organization.id, projectId: data.project.id, teamId: data.team.id, config, states, ideaLabel, readyLabel };
  }
  async function snapshot(manifest) {
    const ctx = await context(manifest);
    const load = async after => (await request(`query ProjectIssues($filter: IssueFilter!, $after: String) { issues(filter: $filter, first: 100, after: $after, includeArchived: true) { nodes { ${issueFields} } ${page} } }`, { filter: { project: { id: { eq: manifest.projectId } } }, after })).issues;
    const raw = await collect(await load(null), load);
    const allIssues = [];
    for (const issue of raw) {
      const labels = await collect(issue.labels, async after => (await request(`query IssueLabels($id: String!, $after: String!) { issue(id: $id) { labels(first: 100, after: $after) { nodes { id name } ${page} } } }`, { id: issue.id, after })).issue.labels);
      const relations = await collect(issue.inverseRelations, async after => (await request(`query IssueBlockers($id: String!, $after: String!) { issue(id: $id) { inverseRelations(first: 100, after: $after) { ${relationFields} } } }`, { id: issue.id, after })).issue.inverseRelations);
      allIssues.push({ ...issue, labels, parentId: issue.parent?.id ?? null, projectId: issue.project?.id, teamId: issue.team?.id,
        blocked: relations.some(relation => relation.type === 'blocks' && !relation.issue?.archivedAt && !terminal(relation.issue?.state)) });
    }
    const ideas = allIssues.filter(issue => !issue.parentId && issue.labels.some(label => label.id === ctx.ideaLabel.id));
    const unfinished = ideas.filter(issue => !issue.archivedAt && !terminal(issue.state)).length;
    return { context: ctx, ideas, remaining: Math.max(0, ctx.config.backlogCap - unfinished), existing: allIssues.map(issue => issue.title), allIssues };
  }
  async function publishProposals(manifest, proposals, { jobId, limit } = {}) {
    if (typeof jobId !== 'string' || !/^[\w.-]{1,128}$/.test(jobId)) throw new Error('Invalid ideation job ID');
    const config = validateIdeation(manifest.ideation);
    const validated = validateProposals(proposals, limit ?? config.batchSize);
    await context(manifest);
    const created = []; let skipped = 0;
    for (const [index, proposal] of validated.entries()) {
      // A single intake/serialized project job owns this loop. Linear has no
      // atomic cap transaction; external writers may race this final recheck.
      const current = await snapshot(manifest);
      const marker = `Agent-Team idea: ${jobId}:${index + 1}`;
      if (current.allIssues.some(issue => (issue.description ?? '').split('\n').includes(marker)) || current.existing.some(title => titleKey(title) === titleKey(proposal.title))) { skipped++; continue; }
      if (!current.remaining) { skipped += validated.length - index; break; }
      const description = [['Problem', proposal.problem], ['Benefit', proposal.benefit], ['Scope', proposal.scope], ['Success criteria', proposal.successCriteria.map(text => `- ${text}`).join('\n')], ['Size', `${proposal.effort} (relative scope, not a time estimate)`], ['Evidence', proposal.evidence.map(text => `- ${text}`).join('\n')], ['Why now', proposal.whyNow]].map(([heading, body]) => `## ${heading}\n${body}`).join('\n\n') + `\n\n${marker}`;
      const data = await request('mutation CreateIdea($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }', { input: { teamId: manifest.teamId, projectId: manifest.projectId, title: proposal.title, description, stateId: current.context.states.proposedState.id, labelIds: [current.context.ideaLabel.id] } });
      if (!data.issueCreate?.success || !data.issueCreate.issue) throw new Error('Linear idea creation failed');
      created.push(data.issueCreate.issue);
    }
    return { created, skipped };
  }
  async function issueByIdentifier(manifest, identifier) {
    if (typeof identifier !== 'string' || !/^[A-Z][A-Z0-9]*-[1-9][0-9]*$/.test(identifier)) return null;
    const data = await request(`query IssueThread($id: String!) { issue(id: $id) { id identifier title team { id } comments(first: 100) { nodes { id createdAt body user { name } } ${page} } } }`, { id: identifier });
    if (!data.issue || data.issue.team?.id !== manifest.teamId) return null;
    return data.issue;
  }
  // Comments on a team issue, oldest first; the owner inbox is product direction for ideation.
  async function issueComments(manifest, identifier, { limit = 30 } = {}) {
    const issue = await issueByIdentifier(manifest, identifier);
    if (!issue) return [];
    const nodes = await collect(issue.comments, async after => (await request(`query IssueThreadMore($id: String!, $after: String!) { issue(id: $id) { comments(first: 100, after: $after) { nodes { id createdAt body user { name } } ${page} } } }`, { id: identifier, after })).issue.comments);
    return nodes.filter(node => typeof node.body === 'string' && node.body.trim()).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).slice(-limit)
      .map(node => ({ id: node.id, createdAt: node.createdAt, author: node.user?.name ?? 'unknown', body: node.body.slice(0, 1500) }));
  }
  const inboxComments = (manifest, options) => issueComments(manifest, manifest.ownerInboxIssue, options);
  async function postComment(manifest, identifier, body) {
    if (typeof body !== 'string' || !body.trim() || body.length > 6000) throw new Error('Invalid comment body');
    const issue = await issueByIdentifier(manifest, identifier);
    if (!issue) throw new Error('Issue is not in the configured team');
    const data = await request('mutation TeamComment($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }', { input: { issueId: issue.id, body } });
    if (!data.commentCreate?.success || !data.commentCreate.comment?.id) throw new Error('Linear comment creation failed');
    return { id: data.commentCreate.comment.id, issue: issue.identifier, title: issue.title };
  }
  async function checkApproved(manifest, identifier) {
    const current = await snapshot(manifest);
    return approvalStatus(manifest, current.ideas.find(issue => issue.identifier === identifier || issue.id === identifier));
  }
  async function prepareApproved(manifest, identifier) {
    const current = await snapshot(manifest);
    const issue = current.ideas.find(issue => issue.identifier === identifier || issue.id === identifier);
    const approval = approvalStatus(manifest, issue);
    if (!approval.allowed) throw new Error(approval.reason);
    const ready = current.context.readyLabel;
    if (!issue.labels.some(label => label.id === ready.id)) {
      const data = await request('mutation ReadyIdea($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }', { id: issue.id, input: { labelIds: [...new Set([...issue.labels.map(label => label.id), ready.id])] } });
      if (!data.issueUpdate?.success) throw new Error('Linear ready label update failed');
      issue.labels.push(ready);
    }
    return issue;
  }
  // Choices for the dashboard settings form: teams in the workspace, plus projects, labels and
  // workflow states of one team. Returns only identifiers and names.
  async function lookup({ teamId = null } = {}) {
    const workspace = await request('query { organization { id name urlKey } teams(first: 100) { nodes { id key name } pageInfo { hasNextPage endCursor } } }');
    const teams = (workspace.teams?.nodes ?? []).map(team => ({ id: team.id, key: team.key, name: team.name }));
    const result = { workspace: { id: workspace.organization?.id ?? null, name: workspace.organization?.name ?? null, url: workspace.organization?.urlKey ? `https://linear.app/${workspace.organization.urlKey}` : null }, teams, projects: [], labels: [], states: [] };
    const team = teamId ?? teams[0]?.id ?? null;
    if (!team) return result;
    const detail = await request(`query($id: String!) { team(id: $id) {
      projects(first: 100) { nodes { id name url } pageInfo { hasNextPage endCursor } }
      labels(first: 100) { nodes { id name } pageInfo { hasNextPage endCursor } }
      states(first: 100) { nodes { id name type } pageInfo { hasNextPage endCursor } } } }`, { id: team });
    const nodes = key => detail.team?.[key]?.nodes ?? [];
    return { ...result, teamId: team, projects: nodes('projects').map(node => ({ id: node.id, name: node.name, url: node.url })), labels: nodes('labels').map(node => ({ id: node.id, name: node.name })), states: nodes('states').map(node => ({ id: node.id, name: node.name, type: node.type })) };
  }
  return { scopes, context, snapshot, publishProposals, prepareApproved, checkApproved, inboxComments, issueComments, postComment, approvalStatus, lookup };
}

export const createLinearClient = createClient;

const IDEATION = { enabled: false, backlogCap: 10, batchSize: 3, minimumIntervalHours: 24, ideaLabel: 'Idea', proposedState: 'Backlog', approvedState: 'Todo', rejectedState: 'Canceled' };
// Guided setup: with an API key the workspace, team and project are chosen from a list; without
// one each identifier is typed. The key typed here is the tracker credential, so it is returned.
export async function setup({ ask, choose, log = () => {}, env = process.env, client = createClient }) {
  const typed = env[API_KEY_VARIABLE] ? '' : String(await ask('Linear API key, to list your teams and projects (empty to type the identifiers instead)', { secret: true })).trim();
  const key = env[API_KEY_VARIABLE] || typed;
  const secrets = typed ? { [API_KEY_VARIABLE]: typed } : {};
  if (key) {
    try {
      const found = await client({ apiKey: key }).scopes();
      const teams = found.teams.filter(team => team.projects.length);
      if (!teams.length) throw new Error('no team has a project yet; create one in Linear first');
      const teamId = await choose('Which Linear team?', teams.map(team => ({ value: team.id, label: team.name, hint: team.key })), { fallback: teams[0].id });
      const team = teams.find(item => item.id === teamId);
      const projectId = await choose('Which Linear project is the backlog?', team.projects.map(project => ({ value: project.id, label: project.name })), { fallback: team.projects[0].id });
      const project = team.projects.find(item => item.id === projectId);
      const readyLabel = await ask('Label that marks an issue ready for the team', { fallback: 'agent:ready' });
      return { tracker: { workspaceId: found.workspaceId, workspaceUrl: found.workspaceUrl, teamId, projectId, projectUrl: project.url, readyLabel }, ideation: IDEATION, secrets };
    } catch (error) { log(`Could not list Linear scopes (${error.message}); enter the identifiers instead`); }
  }
  const tracker = {};
  for (const field of MANIFEST_KEYS) tracker[field] = String(await ask(`Linear ${field}`, field === 'readyLabel' ? { fallback: 'agent:ready' } : {})).trim();
  return { tracker, ideation: IDEATION, secrets };
}
