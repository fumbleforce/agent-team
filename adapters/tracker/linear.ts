import { MAX_COMMENT, type FullTrackerClient, type TrackerIssue, type TrackerOptions, type TrackerState } from './contract.ts';

// Linear over its GraphQL API. Server bodies, GraphQL messages and fetch errors are never surfaced: they may contain credentials.
const ISSUE = /^[A-Z][A-Z0-9]*-[1-9][0-9]*$/;
interface Named { id: string; name: string }
interface WorkflowState extends Named { type: string; position?: number }
interface RawIssue { identifier: string; title: string; description?: string | null; url?: string | null; updatedAt?: string | null; archivedAt?: string | null; parent?: { id: string } | null; state: { name: string; type: string }; labels: { nodes: { name: string }[] }; inverseRelations?: { nodes: { type: string; issue?: { archivedAt?: string | null; state?: { type: string } | null } | null }[] } }
interface Page { nodes: RawIssue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }

const ISSUES = 'query ProjectIssues($filter: IssueFilter!, $after: String) { issues(filter: $filter, first: 100, after: $after) { nodes { identifier title description url updatedAt archivedAt parent { id } state { name type } labels(first: 50) { nodes { name } } inverseRelations(first: 50) { nodes { type issue { archivedAt state { type } } } } } pageInfo { hasNextPage endCursor } } }';
const ISSUE_SCOPE = 'query IssueScope($id: String!) { issue(id: $id) { id team { id states(first: 100) { nodes { id name type position } } labels(first: 250) { nodes { id name } } } labels(first: 100) { nodes { id name } } } }';
const TEAM_SCOPE = 'query TeamScope($id: String!) { team(id: $id) { id states(first: 100) { nodes { id name type position } } labels(first: 250) { nodes { id name } } } }';
const COMMENTS = 'query IssueComments($id: String!, $filter: CommentFilter, $after: String) { issue(id: $id) { comments(first: 100, filter: $filter, after: $after) { nodes { id body createdAt user { name } } pageInfo { hasNextPage endCursor } } } }';
const PROJECT_TEAMS = 'query ProjectTeams($id: String!) { project(id: $id) { teams(first: 10) { nodes { id } } } }';
// Labels by name across the workspace: a team's own and the workspace-wide ones, which every team may use.
const LABELS = 'query Labels($name: String!) { issueLabels(first: 50, filter: { name: { eq: $name } }) { nodes { id name team { id } } } }';
const CREATE_LABEL = 'mutation CreateLabel($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { success issueLabel { id } } }';
const UPDATE = 'mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }';
const COMMENT = 'mutation Comment($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }';
const CREATE = 'mutation CreateIssue($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier url } } }';

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);
const terminal = (type: string | undefined) => type === 'completed' || type === 'canceled';

export function linearTracker(options: TrackerOptions = {}): FullTrackerClient {
  const env = options.env ?? process.env, request = options.fetch ?? fetch;
  const key = env.LINEAR_API_KEY;
  if (!key?.trim() || /\s/.test(key)) throw new Error('LINEAR_API_KEY is required');

  async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await request('https://api.linear.app/graphql', { method: 'POST', headers: { authorization: key!, 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(30_000) }).catch(() => { throw new Error('Linear network request failed'); });
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? `Linear did not accept the API key (${response.status})` : response.status === 429 ? 'Linear is rate-limiting requests (429)' : `Linear HTTP request failed (${response.status})`);
    const payload = await response.json().catch(() => null) as { data?: T; errors?: unknown[] } | null;
    if (!payload?.data || payload.errors?.length) throw new Error('Linear GraphQL request failed');
    return payload.data;
  }

  interface Scope { id: string; team: { id: string; states: { nodes: WorkflowState[] }; labels: { nodes: Named[] } }; labels: { nodes: Named[] } }
  // The issue with its team's states and labels. An issue of another team than the manifest's is not this project's.
  async function scope(manifest: Record<string, unknown>, issue: string): Promise<Scope> {
    if (!ISSUE.test(issue)) throw new Error('Not an issue of this tracker');
    const found = (await gql<{ issue?: Scope | null }>(ISSUE_SCOPE, { id: issue })).issue;
    if (!found?.id || !found.team?.id || (text(manifest.teamId) && found.team.id !== manifest.teamId)) throw new Error('Issue is not in the configured team');
    return found;
  }
  // The team a project's issues are made in: the manifest's, else the project's own when it belongs to exactly one.
  async function teamOf(manifest: Record<string, unknown>): Promise<string> {
    const named = text(manifest.teamId), projectId = text(manifest.projectId);
    if (named) return named;
    if (!projectId) throw new Error('Missing Linear configuration');
    const teams = (await gql<{ project?: { teams?: { nodes?: { id: string }[] } } | null }>(PROJECT_TEAMS, { id: projectId })).project?.teams?.nodes ?? [];
    if (teams.length !== 1) throw new Error(teams.length ? 'The Linear project belongs to several teams; name one as teamId' : 'The Linear project belongs to no team');
    return teams[0]!.id;
  }
  // A label the team may use, made in the team when there is none yet, as GitHub makes a missing label on first use.
  async function labelFor(teamId: string, name: string): Promise<string> {
    const found = ((await gql<{ issueLabels?: { nodes?: (Named & { team?: { id: string } | null })[] } }>(LABELS, { name })).issueLabels?.nodes ?? []).filter(label => label.name === name);
    const own = found.filter(label => label.team?.id === teamId), shared = found.filter(label => !label.team);
    const usable = own.length ? own : shared;
    if (usable.length > 1) throw new Error('The label is ambiguous in the configured team');
    if (usable.length === 1) return usable[0]!.id;
    const created = (await gql<{ issueLabelCreate?: { success?: boolean; issueLabel?: { id?: string } } }>(CREATE_LABEL, { input: { name, teamId } })).issueLabelCreate;
    if (!created?.success || !created.issueLabel?.id) throw new Error('Linear label creation failed');
    return created.issueLabel.id;
  }
  const update = async (id: string, input: Record<string, unknown>) => { if (!(await gql<{ issueUpdate?: { success?: boolean } }>(UPDATE, { id, input })).issueUpdate?.success) throw new Error('Linear issue update failed'); };
  // The first state of the type by position; review is a started state named so, else the last started one.
  function stateFor(states: WorkflowState[], wanted: TrackerState): WorkflowState {
    const ofType = (type: string) => states.filter(state => state.type === type).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    const started = ofType('started'), review = started.find(state => /in.?review/i.test(state.name));
    const state = wanted === 'in_review' ? review ?? started.at(-1) : wanted === 'started' ? started.find(item => item !== review) ?? started[0] : ofType(wanted)[0];
    if (!state) throw new Error('The team has no workflow state of that type');
    return state;
  }

  return {
    async snapshot(manifest) {
      const projectId = text(manifest.projectId);
      if (!projectId) throw new Error('Missing Linear configuration');
      const allIssues: TrackerIssue[] = [], cursors = new Set<string>();
      for (let after: string | null = null; ;) {
        const page: Page | undefined = (await gql<{ issues?: Page }>(ISSUES, { filter: { project: { id: { eq: projectId } } }, after })).issues;
        if (!page || !Array.isArray(page.nodes)) throw new Error('Linear GraphQL request failed');
        allIssues.push(...page.nodes.map((issue): TrackerIssue => ({ identifier: issue.identifier, title: issue.title, description: issue.description ?? '', url: issue.url ?? null, updatedAt: issue.updatedAt ?? null, state: { name: issue.state.name, type: issue.state.type }, labels: issue.labels.nodes.map(label => ({ name: label.name })),
          archived: Boolean(issue.archivedAt), child: Boolean(issue.parent?.id), blocked: (issue.inverseRelations?.nodes ?? []).some(relation => relation.type === 'blocks' && !relation.issue?.archivedAt && !terminal(relation.issue?.state?.type)) })));
        if (!page.pageInfo.hasNextPage) break;
        after = page.pageInfo.endCursor;
        if (!after || cursors.has(after)) throw new Error('Invalid Linear pagination');
        cursors.add(after);
      }
      return { allIssues };
    },

    async setState(manifest, issue, state) {
      const found = await scope(manifest, issue);
      await update(found.id, { stateId: stateFor(found.team.states.nodes, state).id });
    },

    async comment(manifest, issue, body) {
      if (!body.trim() || body.length > MAX_COMMENT) throw new Error('Invalid comment body');
      const found = await scope(manifest, issue);
      const created = (await gql<{ commentCreate?: { success?: boolean; comment?: { id?: string } } }>(COMMENT, { input: { issueId: found.id, body } })).commentCreate;
      if (!created?.success || !created.comment?.id) throw new Error('Linear comment creation failed');
      return { id: created.comment.id };
    },

    async comments(_manifest, issue, since) {
      if (!ISSUE.test(issue)) throw new Error('Not an issue of this tracker');
      type Node = { id: string; body?: string | null; createdAt?: string; user?: { name?: string } | null };
      const nodes: Node[] = [], cursors = new Set<string>();
      for (let after: string | null = null; ;) {
        const page: { nodes?: Node[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } | undefined = (await gql<{ issue?: { comments?: { nodes?: Node[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } } | null }>(COMMENTS, { id: issue, filter: since ? { createdAt: { gt: since } } : null, after })).issue?.comments;
        nodes.push(...(page?.nodes ?? []));
        if (!page?.pageInfo?.hasNextPage) break;
        after = page.pageInfo.endCursor ?? null;
        if (!after || cursors.has(after) || cursors.size >= 50) throw new Error('Invalid Linear pagination');
        cursors.add(after);
      }
      return nodes.filter(node => typeof node.body === 'string' && node.body.trim()).map(node => ({ id: node.id, body: node.body!, author: node.user?.name ?? 'unknown', createdAt: node.createdAt ?? '' })).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    async addLabel(manifest, issue, label) {
      const found = await scope(manifest, issue);
      if (found.labels.nodes.some(item => item.name === label)) return;
      await update(found.id, { labelIds: [...new Set([...found.labels.nodes.map(item => item.id), await labelFor(found.team.id, label)])] });
    },

    // The state is named by the manifest and resolved in the team, never guessed; a missing label is made, as `addLabel` does.
    async createIssue(manifest, input) {
      const projectId = text(manifest.projectId);
      if (!projectId) throw new Error('Missing Linear configuration');
      const teamId = await teamOf(manifest);
      const team = (await gql<{ team?: Scope['team'] | null }>(TEAM_SCOPE, { id: teamId })).team;
      const state = team?.states.nodes.filter(item => item.name === input.state) ?? [];
      if (state.length !== 1) throw new Error(`The team has ${state.length ? 'several workflow states' : 'no workflow state'} named "${input.state.slice(0, 80)}"`);
      const labelIds = [];
      for (const name of input.labels) labelIds.push(await labelFor(teamId, name));
      const created = (await gql<{ issueCreate?: { success?: boolean; issue?: { identifier?: string; url?: string } } }>(CREATE, { input: { teamId, projectId, title: input.title, description: input.body, stateId: state[0]!.id, labelIds } })).issueCreate;
      if (!created?.success || !created.issue?.identifier) throw new Error('Linear issue creation failed');
      return { identifier: created.issue.identifier, url: created.issue.url ?? null };
    },
  };
}
