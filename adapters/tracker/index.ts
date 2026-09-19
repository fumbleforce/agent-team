// Tracker clients in the neutral shape the coordinator's sync reads. Response bodies and fetch errors are never surfaced:
// they may carry the token or private text.
export interface TrackerIssue { identifier: string; title: string; description?: string | null; url?: string | null; updatedAt?: string | null; state: { name: string; type: string }; labels: { name: string }[] }
export interface TrackerClient { snapshot(manifest: Record<string, unknown>): Promise<{ allIssues: TrackerIssue[] }> }
type Fetch = typeof fetch;
interface Options { env?: NodeJS.ProcessEnv; fetch?: Fetch }

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);
const token = (value: string | undefined | null, name: string): string => { if (!value?.trim() || /\s/.test(value)) throw new Error(`${name} is required`); return value; };

const REPOSITORY = /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9_][\w.-]*$/;
interface GithubIssue { number: number; title?: string; body?: string | null; html_url?: string; updated_at?: string; state?: string; state_reason?: string | null; pull_request?: unknown; labels?: (string | { name?: string })[] }

export function githubTracker(options: Options = {}): TrackerClient {
  const env = options.env ?? process.env, request = options.fetch ?? fetch;
  const key = token(env.GITHUB_ISSUES_TOKEN || env.GH_TOKEN, 'GITHUB_ISSUES_TOKEN (or GH_TOKEN)');
  return {
    async snapshot(manifest) {
      const repository = text(manifest.repository);
      if (!repository || !REPOSITORY.test(repository)) throw new Error('Missing GitHub tracker configuration');
      const raw: GithubIssue[] = [];
      for (let page = 1; ; page++) {
        if (page > 50) throw new Error('GitHub listing too long');
        const response = await request(`https://api.github.com/repos/${repository}/issues?state=all&per_page=100&page=${page}`, { headers: { authorization: `Bearer ${key}`, accept: 'application/vnd.github+json', 'user-agent': 'agent-team', 'x-github-api-version': '2022-11-28' }, signal: AbortSignal.timeout(30_000) }).catch(() => { throw new Error('GitHub network request failed'); });
        if (!response.ok) throw new Error(`GitHub HTTP request failed (${response.status})`);
        const batch = await response.json().catch(() => null) as GithubIssue[] | null;
        if (!Array.isArray(batch)) throw new Error('Invalid GitHub listing');
        raw.push(...batch);
        if (batch.length < 100) break;
      }
      return { allIssues: raw.filter(item => !item.pull_request).map(item => ({
        identifier: `GH-${item.number}`, title: item.title ?? '', description: item.body ?? '', url: item.html_url ?? `https://github.com/${repository}/issues/${item.number}`, updatedAt: item.updated_at ?? null,
        state: item.state === 'closed' ? (item.state_reason === 'not_planned' ? { name: 'Not planned', type: 'canceled' } : { name: 'Done', type: 'completed' }) : { name: 'Open', type: 'unstarted' },
        labels: (item.labels ?? []).map(label => ({ name: typeof label === 'string' ? label : label.name ?? '' })),
      })) };
    },
  };
}

interface LinearIssue { identifier: string; title: string; description?: string | null; url?: string | null; updatedAt?: string | null; state: { name: string; type: string }; labels: { nodes: { name: string }[] } }
interface LinearPage { nodes: LinearIssue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
const LINEAR_QUERY = 'query ProjectIssues($filter: IssueFilter!, $after: String) { issues(filter: $filter, first: 100, after: $after) { nodes { identifier title description url updatedAt state { name type } labels(first: 50) { nodes { name } } } pageInfo { hasNextPage endCursor } } }';

export function linearTracker(options: Options = {}): TrackerClient {
  const env = options.env ?? process.env, request = options.fetch ?? fetch;
  const key = token(env.LINEAR_API_KEY, 'LINEAR_API_KEY');
  return {
    async snapshot(manifest) {
      const projectId = text(manifest.projectId);
      if (!projectId) throw new Error('Missing Linear configuration');
      const allIssues: TrackerIssue[] = [], cursors = new Set<string>();
      for (let after: string | null = null; ;) {
        const response = await request('https://api.linear.app/graphql', { method: 'POST', headers: { authorization: key, 'content-type': 'application/json' }, body: JSON.stringify({ query: LINEAR_QUERY, variables: { filter: { project: { id: { eq: projectId } } }, after } }), signal: AbortSignal.timeout(30_000) }).catch(() => { throw new Error('Linear network request failed'); });
        if (!response.ok) throw new Error('Linear HTTP request failed');
        const payload = await response.json().catch(() => null) as { data?: { issues?: LinearPage }; errors?: unknown[] } | null;
        const page = payload?.data?.issues;
        if (!page || payload?.errors?.length || !Array.isArray(page.nodes)) throw new Error('Linear GraphQL request failed');
        allIssues.push(...page.nodes.map(issue => ({ ...issue, labels: issue.labels.nodes })));
        if (!page.pageInfo.hasNextPage) break;
        after = page.pageInfo.endCursor;
        if (!after || cursors.has(after)) throw new Error('Invalid Linear pagination');
        cursors.add(after);
      }
      return { allIssues };
    },
  };
}

const TRACKERS: Record<string, { present(env: NodeJS.ProcessEnv): boolean; create(options: Options): TrackerClient }> = {
  github: { present: env => Boolean(env.GITHUB_ISSUES_TOKEN || env.GH_TOKEN), create: githubTracker },
  linear: { present: env => Boolean(env.LINEAR_API_KEY), create: linearTracker },
};
export const TRACKER_KINDS = Object.keys(TRACKERS);

// A client for the manifest's tracker, or null when the kind is unknown or its credential is absent.
export function trackerClient(kind: string, options: Options = {}): TrackerClient | null {
  const tracker = Object.hasOwn(TRACKERS, kind) ? TRACKERS[kind]! : null;
  return tracker?.present(options.env ?? process.env) ? tracker.create(options) : null;
}
