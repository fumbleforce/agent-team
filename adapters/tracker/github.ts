import { MAX_COMMENT, PROGRESS_LABELS, type FullTrackerClient, type TrackerIssue, type TrackerOptions, type TrackerState } from './contract.ts';

// GitHub Issues as the board: issues are addressed as GH-<number>. There are only open and closed, so progress is carried by
// labels, and the ideation states of the manifest name labels too. Response bodies and fetch errors are never surfaced:
// they may carry the token or private text.
const API = 'https://api.github.com';
const REPOSITORY = /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9_][\w.-]*$/;
const ISSUE = /^GH-([1-9][0-9]*)$/;
interface RawIssue { number: number; title?: string; body?: string | null; html_url?: string; updated_at?: string; state?: string; state_reason?: string | null; pull_request?: unknown; labels?: (string | { name?: string })[] }
interface RawComment { id: number; body?: string | null; created_at?: string; user?: { login?: string } | null }

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);
const labelNames = (raw: RawIssue) => (raw.labels ?? []).map(label => (typeof label === 'string' ? label : label.name ?? '')).filter(Boolean);

export function githubTracker(options: TrackerOptions = {}): FullTrackerClient {
  const env = options.env ?? process.env, request = options.fetch ?? fetch;
  const key = env.GITHUB_ISSUES_TOKEN || env.GH_TOKEN;
  if (!key?.trim() || /\s/.test(key)) throw new Error('GITHUB_ISSUES_TOKEN (or GH_TOKEN) is required');

  async function call<T>(method: string, route: string, body?: unknown): Promise<T> {
    const response = await request(`${API}${route}`, { method, headers: { authorization: `Bearer ${key}`, accept: 'application/vnd.github+json', 'user-agent': 'agent-team', 'x-github-api-version': '2022-11-28', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) }).catch(() => { throw new Error('GitHub network request failed'); });
    if (!response.ok) throw new Error(`GitHub HTTP request failed (${response.status})`);
    const parsed = await response.json().catch(() => null) as T | null;
    if (parsed === null) throw new Error('Invalid GitHub response');
    return parsed;
  }
  async function paged<T>(route: string): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; page <= 50; page++) {
      const batch = await call<T[]>('GET', `${route}${route.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      if (!Array.isArray(batch)) throw new Error('Invalid GitHub listing');
      items.push(...batch);
      if (batch.length < 100) return items;
    }
    throw new Error('GitHub listing too long');
  }
  const repo = (manifest: Record<string, unknown>) => { const repository = text(manifest.repository); if (!repository || !REPOSITORY.test(repository)) throw new Error('Missing GitHub tracker configuration'); return repository; };
  const route = (manifest: Record<string, unknown>, issue: string) => { const number = ISSUE.exec(issue)?.[1]; if (!number) throw new Error('Not an issue of this tracker'); return `/repos/${repo(manifest)}/issues/${number}`; };

  return {
    async snapshot(manifest) {
      const repository = repo(manifest);
      // With an ideation section, the labels named there are the workflow states of an open issue.
      const ideation = (manifest.ideation ?? {}) as { proposedState?: string; approvedState?: string };
      const raw = (await paged<RawIssue>(`/repos/${repository}/issues?state=all`)).filter(item => !item.pull_request);
      return { allIssues: raw.map((item): TrackerIssue => {
        const labels = labelNames(item);
        const state = item.state === 'closed' ? (item.state_reason === 'not_planned' ? { name: 'Not planned', type: 'canceled' } : { name: 'Done', type: 'completed' })
          : ideation.approvedState && labels.includes(ideation.approvedState) ? { name: ideation.approvedState, type: 'unstarted' }
            : ideation.proposedState && labels.includes(ideation.proposedState) ? { name: ideation.proposedState, type: 'backlog' } : { name: 'Open', type: 'unstarted' };
        return { identifier: `GH-${item.number}`, title: item.title ?? '', description: item.body ?? '', url: item.html_url ?? `https://github.com/${repository}/issues/${item.number}`, updatedAt: item.updated_at ?? null, state, labels: labels.map(name => ({ name })), archived: false, child: false, blocked: false };
      }) };
    },

    // Progress is a label, done and canceled are the two ways of closing; every other label is left as it is.
    async setState(manifest, issue, state: TrackerState) {
      const current = await call<RawIssue>('GET', route(manifest, issue));
      const progress: string[] = Object.values(PROGRESS_LABELS);
      const labels = labelNames(current).filter(name => !progress.includes(name));
      if (state === 'started') labels.push(PROGRESS_LABELS.inProgress);
      if (state === 'in_review') labels.push(PROGRESS_LABELS.inReview);
      const closed = state === 'completed' || state === 'canceled';
      await call('PATCH', route(manifest, issue), { labels, state: closed ? 'closed' : 'open', ...(closed ? { state_reason: state === 'canceled' ? 'not_planned' : 'completed' } : {}) });
    },

    async comment(manifest, issue, body) {
      if (!body.trim() || body.length > MAX_COMMENT) throw new Error('Invalid comment body');
      const created = await call<{ id?: number }>('POST', `${route(manifest, issue)}/comments`, { body });
      if (!created.id) throw new Error('GitHub comment creation failed');
      return { id: String(created.id) };
    },

    async comments(manifest, issue, since) {
      const raw = await paged<RawComment>(`${route(manifest, issue)}/comments${since ? `?since=${encodeURIComponent(since)}` : ''}`);
      return raw.filter(item => typeof item.body === 'string' && item.body.trim()).map(item => ({ id: String(item.id), body: item.body!, author: item.user?.login ?? 'unknown', createdAt: item.created_at ?? '' }));
    },

    async addLabel(manifest, issue, label) {
      const result = await call<unknown>('POST', `${route(manifest, issue)}/labels`, { labels: [label] });
      if (!Array.isArray(result)) throw new Error('GitHub label update failed');
    },

    // The state of a new issue is a label here, beside the labels asked for.
    async createIssue(manifest, input) {
      const created = await call<RawIssue>('POST', `/repos/${repo(manifest)}/issues`, { title: input.title, body: input.body, labels: [...new Set([...input.labels, input.state])] });
      if (!created.number) throw new Error('GitHub issue creation failed');
      return { identifier: `GH-${created.number}`, url: created.html_url ?? null };
    },
  };
}
