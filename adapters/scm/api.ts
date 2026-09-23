import { inflateRawSync } from 'node:zlib';
import { parseJUnit, type JUnitReport } from '../../packages/coordinator/src/checks/junit.ts';
import type { ScmApi, ScmChangeState, ScmEnvironment, ScmReviewState, ScmTestReport } from '../../packages/coordinator/src/sync/scm.ts';
import { githubCredential } from '../tracker/githubCredential.ts';
import { SCM_GATES } from './gates.ts';

// What the coordinator polls from the host over HTTP: review state, test reports and environments. The token comes from the
// host's usual variable. Response bodies and fetch errors are never surfaced: they may carry the token or private text.
export type { ScmApi, ScmChangeState, ScmEnvironment, ScmReviewState, ScmTestReport } from '../../packages/coordinator/src/sync/scm.ts';
export interface ScmApiOptions { env?: Record<string, string | undefined>; fetch?: typeof fetch }

const MAX_ARCHIVE = 50_000_000, MAX_ENTRY = 20_000_000;
const number = (url: string) => /\/(\d+)\/?$/.exec(url)?.[1] ?? '';
const empty = (): JUnitReport => ({ passed: 0, failed: 0, skipped: 0, total: 0, durationMs: 0, failing: [] });
function merge(into: JUnitReport, part: JUnitReport): JUnitReport {
  into.passed += part.passed; into.failed += part.failed; into.skipped += part.skipped; into.total += part.total; into.durationMs += part.durationMs;
  into.failing.push(...part.failing.slice(0, 200 - into.failing.length));
  return into;
}

// The XML files of a zip archive, read from its central directory: stored or deflated entries, nothing else.
export function xmlEntries(archive: Buffer): string[] {
  let end = -1;
  for (let at = archive.length - 22; at >= Math.max(0, archive.length - 66_000); at--) if (archive.readUInt32LE(at) === 0x06054b50) { end = at; break; }
  if (end < 0) throw new Error('Unreadable report archive');
  const files: string[] = [];
  let at = archive.readUInt32LE(end + 16);
  for (let index = 0, count = archive.readUInt16LE(end + 10); index < count && index < 200; index++) {
    if (at + 46 > archive.length || archive.readUInt32LE(at) !== 0x02014b50) throw new Error('Unreadable report archive');
    const method = archive.readUInt16LE(at + 10), size = archive.readUInt32LE(at + 20), nameLength = archive.readUInt16LE(at + 28), local = archive.readUInt32LE(at + 42);
    const name = archive.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + archive.readUInt16LE(at + 30) + archive.readUInt16LE(at + 32);
    if (!/\.xml$/i.test(name) || size > MAX_ENTRY || local + 30 > archive.length) continue;
    const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28), data = archive.subarray(start, start + size);
    if (method === 0) files.push(data.toString('utf8'));
    else if (method === 8) files.push(inflateRawSync(data, { maxOutputLength: MAX_ENTRY }).toString('utf8'));
  }
  return files;
}

function client(label: string, base: string, headers: Record<string, string>, request: typeof fetch) {
  const call = async (route: string, init: { method?: string; body?: unknown; missing?: boolean } = {}) => {
    const response = await request(route.startsWith('https://') || route.startsWith('http://') ? route : `${base}${route}`, { method: init.method ?? 'GET', headers: init.body === undefined ? headers : { ...headers, 'content-type': 'application/json' }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }), signal: AbortSignal.timeout(30_000) }).catch(() => { throw new Error(`${label} network request failed`); });
    if (init.missing && response.status === 404) return null;
    if (!response.ok) throw new Error(`${label} HTTP request failed (${response.status})`);
    return response;
  };
  const parsed = async <T>(response: Response | null): Promise<T> => { const value = response ? await response.json().catch(() => null) as T | null : null; if (value === null) throw new Error(`Invalid ${label} response`); return value; };
  return {
    async json<T>(route: string): Promise<T> { return parsed<T>(await call(route)); },
    // A read that may find nothing: null for a 404, never for any other failure.
    async optional<T>(route: string): Promise<T | null> { const response = await call(route, { missing: true }); return response ? parsed<T>(response) : null; },
    async optionalText(route: string): Promise<string | null> { const response = await call(route, { missing: true }); return response ? response.text() : null; },
    async send<T>(method: string, route: string, body: unknown): Promise<T> { return parsed<T>(await call(route, { method, body })); },
    async bytes(route: string): Promise<Buffer> { const data = Buffer.from(await (await call(route))!.arrayBuffer().catch(() => { throw new Error(`Invalid ${label} response`); })); if (data.length > MAX_ARCHIVE) throw new Error('Report archive too large'); return data; },
  };
}

// A path in a URL, each segment encoded and the slashes kept.
const encodePath = (value: string) => value.split('/').map(encodeURIComponent).join('/');

const REPORT_ARTIFACT = /junit|test[-_ ]?(report|result)s?/i;
interface GithubRun { id: number; head_sha: string; head_branch?: string }

function githubApi(options: ScmApiOptions): ScmApi | null {
  // GH_TOKEN when it is set, else the GitHub command-line login of this machine, as the tracker does.
  const token = githubCredential(options.env ?? process.env, { names: ['GH_TOKEN'] })?.token;
  if (!token) return null;
  const http = client('GitHub', 'https://api.github.com', { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'agent-team', 'x-github-api-version': '2022-11-28' }, options.fetch ?? fetch);
  const repo = (repository: string) => { if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Invalid repository'); return `/repos/${repository}`; };
  const change = (repository: string, url: string) => { if (SCM_GATES.github!.parseChangeUrl(url)?.repository !== repository) throw new Error('Not a change of this repository'); return `${repo(repository)}/pulls/${number(url)}`; };

  return {
    // The latest review of each person decides; a dismissed one counts for nothing.
    async reviewState(repository, url): Promise<ScmReviewState> {
      const reviews = await http.json<{ user?: { login?: string } | null; state?: string }[]>(`${change(repository, url)}/reviews?per_page=100`);
      const latest = new Map<string, 'approved' | 'changes_requested' | 'commented'>();
      for (const review of Array.isArray(reviews) ? reviews : []) {
        const name = review.user?.login ?? 'unknown';
        if (review.state === 'APPROVED') latest.set(name, 'approved');
        else if (review.state === 'CHANGES_REQUESTED') latest.set(name, 'changes_requested');
        else if (review.state === 'DISMISSED') latest.delete(name);
        else if (review.state === 'COMMENTED' && !latest.has(name)) latest.set(name, 'commented');
      }
      const reviewers = [...latest].map(([name, state]) => ({ name, state })), approvals = reviewers.filter(item => item.state === 'approved').length;
      return { state: reviewers.some(item => item.state === 'changes_requested') ? 'changes_requested' : approvals > 0 ? 'approved' : 'pending', approvals, reviewers };
    },

    // `mergeable` is null while GitHub still computes it; false means the change conflicts with its base.
    async changeState(repository, url): Promise<ScmChangeState> {
      const pull = await http.json<{ state?: string; merged?: boolean; mergeable?: boolean | null; head?: { sha?: string } }>(change(repository, url));
      return { open: pull.state === 'open', merged: pull.merged === true, headSha: pull.head?.sha ?? null, conflicting: typeof pull.mergeable === 'boolean' ? !pull.mergeable : null };
    },

    // The JUnit artifacts of the finished workflow runs of the branch's newest commit, one suite per artifact.
    async testReports(repository, ref): Promise<ScmTestReport[]> {
      const head = 'change' in ref ? await http.json<{ head?: { ref?: string; sha?: string } }>(change(repository, ref.change)) : null;
      const branch = 'change' in ref ? head?.head?.ref : ref.branch;
      if (!branch) throw new Error('Unreadable change');
      const listed = (await http.json<{ workflow_runs?: GithubRun[] }>(`${repo(repository)}/actions/runs?branch=${encodeURIComponent(branch)}&status=completed&per_page=20`)).workflow_runs ?? [];
      const sha = head?.head?.sha ?? listed[0]?.head_sha;
      const reports: ScmTestReport[] = [];
      for (const run of listed.filter(item => item.head_sha === sha).slice(0, 5)) {
        const artifacts = (await http.json<{ artifacts?: { id: number; name: string; expired?: boolean; archive_download_url?: string }[] }>(`${repo(repository)}/actions/runs/${run.id}/artifacts?per_page=100`)).artifacts ?? [];
        for (const artifact of artifacts.filter(item => !item.expired && REPORT_ARTIFACT.test(item.name)).slice(0, 10)) {
          const files = xmlEntries(await http.bytes(`${repo(repository)}/actions/artifacts/${artifact.id}/zip`));
          const report = empty();
          for (const xml of files) { try { merge(report, parseJUnit(xml)); } catch { /* an XML file that is not a test report */ } }
          if (files.length) reports.push({ suite: artifact.name, branch, sha: run.head_sha, report });
        }
      }
      return reports;
    },

    // Deployments, newest first: each environment once, with the URL of its latest successful status.
    async environments(repository): Promise<ScmEnvironment[]> {
      const deployments = await http.json<{ id: number; environment?: string; ref?: string; sha?: string }[]>(`${repo(repository)}/deployments?per_page=50`);
      const found: ScmEnvironment[] = [], seen = new Set<string>();
      for (const deployment of Array.isArray(deployments) ? deployments : []) {
        if (!deployment.environment || seen.has(deployment.environment) || seen.size >= 10) continue;
        seen.add(deployment.environment);
        const statuses = await http.json<{ state?: string; environment_url?: string }[]>(`${repo(repository)}/deployments/${deployment.id}/statuses?per_page=10`);
        const live = (Array.isArray(statuses) ? statuses : []).find(status => status.state === 'success' && status.environment_url);
        if (live?.environment_url) found.push({ name: deployment.environment, url: live.environment_url, branch: deployment.ref && deployment.ref !== deployment.sha ? deployment.ref : null });
      }
      return found;
    },

    async readFile(repository, file, ref) {
      const found = await http.optional<{ content?: string; encoding?: string }>(`${repo(repository)}/contents/${encodePath(file)}?ref=${encodeURIComponent(ref)}`);
      return found?.content && found.encoding === 'base64' ? Buffer.from(found.content, 'base64').toString('utf8') : null;
    },

    // A branch from the base's head, the file written on it in one commit, and a pull request back into the base.
    async proposeFile(repository, input) {
      const head = await http.json<{ object?: { sha?: string } }>(`${repo(repository)}/git/ref/heads/${encodePath(input.base)}`);
      if (!head.object?.sha) throw new Error('The base branch has no head');
      await http.send('POST', `${repo(repository)}/git/refs`, { ref: `refs/heads/${input.branch}`, sha: head.object.sha });
      const existing = await http.optional<{ sha?: string }>(`${repo(repository)}/contents/${encodePath(input.path)}?ref=${encodeURIComponent(input.base)}`);
      await http.send('PUT', `${repo(repository)}/contents/${encodePath(input.path)}`, { message: input.title, content: Buffer.from(input.content).toString('base64'), branch: input.branch, ...(existing?.sha ? { sha: existing.sha } : {}) });
      const pull = await http.send<{ html_url?: string }>('POST', `${repo(repository)}/pulls`, { title: input.title, body: input.body, head: input.branch, base: input.base });
      if (!pull.html_url) throw new Error('GitHub opened no pull request');
      return pull.html_url;
    },

    // What the merge gate matches required checks against: the check runs and the commit statuses of the branch's head.
    async checkNames(repository, ref) {
      const runs = await http.json<{ check_runs?: { name?: string }[] }>(`${repo(repository)}/commits/${encodePath(ref)}/check-runs?per_page=100`);
      const status = await http.json<{ statuses?: { context?: string }[] }>(`${repo(repository)}/commits/${encodePath(ref)}/status`);
      return [...new Set([...(runs.check_runs ?? []).map(run => run.name), ...(status.statuses ?? []).map(item => item.context)].filter((name): name is string => Boolean(name)))].sort();
    },
  };
}

interface GitlabCase { status?: string; name?: string; classname?: string; system_output?: string | null }
interface GitlabSuite { name?: string; total_time?: number; total_count?: number; success_count?: number; failed_count?: number; skipped_count?: number; error_count?: number; test_cases?: GitlabCase[] }

function gitlabApi(options: ScmApiOptions): ScmApi | null {
  const env = options.env ?? process.env, token = env.GITLAB_TOKEN;
  if (!token) return null;
  const host = env.GITLAB_HOST ? `https://${env.GITLAB_HOST.replace(/^https?:\/\//, '')}` : 'https://gitlab.com';
  const http = client('GitLab', `${host}/api/v4`, { 'private-token': token, 'user-agent': 'agent-team' }, options.fetch ?? fetch);
  const project = (repository: string) => { if (!/^[A-Za-z0-9][\w.-]*(?:\/[A-Za-z0-9][\w.-]*)+$/.test(repository)) throw new Error('Invalid repository'); return `/projects/${encodeURIComponent(repository)}`; };
  const change = (repository: string, url: string) => { if (SCM_GATES.gitlab!.parseChangeUrl(url)?.repository !== repository) throw new Error('Not a change of this repository'); return `${project(repository)}/merge_requests/${number(url)}`; };

  return {
    // Approval is all there is to read here: a merge request is approved once somebody did and no approval is left to give.
    async reviewState(repository, url): Promise<ScmReviewState> {
      const approvals = await http.json<{ approvals_left?: number; approved_by?: { user?: { username?: string } }[] }>(`${change(repository, url)}/approvals`);
      const reviewers = (approvals.approved_by ?? []).map(item => ({ name: item.user?.username ?? 'unknown', state: 'approved' as const }));
      return { state: reviewers.length > 0 && (approvals.approvals_left ?? 0) === 0 ? 'approved' : 'pending', approvals: reviewers.length, reviewers };
    },

    // GitLab checks mergeability in the background; until it has, `has_conflicts` says nothing.
    async changeState(repository, url): Promise<ScmChangeState> {
      const found = await http.json<{ state?: string; sha?: string; has_conflicts?: boolean; detailed_merge_status?: string }>(change(repository, url));
      const checking = ['unchecked', 'checking', 'preparing', 'approvals_syncing'].includes(found.detailed_merge_status ?? '');
      return { open: found.state === 'opened', merged: found.state === 'merged', headSha: found.sha ?? null, conflicting: checking || typeof found.has_conflicts !== 'boolean' ? null : found.has_conflicts };
    },

    // The pipeline test report is already parsed by the host: one suite per job that uploaded a JUnit report.
    async testReports(repository, ref): Promise<ScmTestReport[]> {
      let branch: string | undefined, sha: string | null = null, pipeline: number | undefined;
      if ('change' in ref) {
        const found = await http.json<{ source_branch?: string; sha?: string; head_pipeline?: { id?: number } | null }>(change(repository, ref.change));
        branch = found.source_branch; sha = found.sha ?? null; pipeline = found.head_pipeline?.id;
      } else {
        const finished = (await http.json<{ id: number; sha?: string; status?: string }[]>(`${project(repository)}/pipelines?ref=${encodeURIComponent(ref.branch)}&per_page=20`)).find(item => item.status === 'success' || item.status === 'failed');
        branch = ref.branch; sha = finished?.sha ?? null; pipeline = finished?.id;
      }
      if (!branch) throw new Error('Unreadable change');
      if (!pipeline) return [];
      const report = await http.json<{ test_suites?: GitlabSuite[] }>(`${project(repository)}/pipelines/${pipeline}/test_report`);
      return (report.test_suites ?? []).filter(suite => (suite.total_count ?? 0) > 0).map(suite => {
        const failed = (suite.failed_count ?? 0) + (suite.error_count ?? 0);
        const failing = (suite.test_cases ?? []).filter(item => item.status === 'failed' || item.status === 'error').slice(0, 200).map(item => ({ name: [item.classname, item.name].filter(Boolean).join(' › ') || '(unnamed)', status: 'failed' as const, message: item.system_output?.slice(0, 1000) || null }));
        return { suite: suite.name ?? 'tests', branch: branch!, sha, report: { passed: suite.success_count ?? 0, failed, skipped: suite.skipped_count ?? 0, total: suite.total_count ?? 0, durationMs: Math.round((suite.total_time ?? 0) * 1000), failing } };
      });
    },

    // Available environments with an address; a review app's name carries its branch slug, which is not the branch, so none is claimed.
    async environments(repository): Promise<ScmEnvironment[]> {
      const listed = await http.json<{ name?: string; external_url?: string | null; state?: string }[]>(`${project(repository)}/environments?states=available&per_page=100`);
      return (Array.isArray(listed) ? listed : []).filter(item => item.name && item.external_url).map(item => ({ name: item.name!, url: item.external_url!, branch: null }));
    },

    async readFile(repository, file, ref) {
      return http.optionalText(`${project(repository)}/repository/files/${encodeURIComponent(file)}/raw?ref=${encodeURIComponent(ref)}`);
    },

    // One commit on a new branch from the base, and a merge request back into it.
    async proposeFile(repository, input) {
      const existing = await http.optionalText(`${project(repository)}/repository/files/${encodeURIComponent(input.path)}/raw?ref=${encodeURIComponent(input.base)}`);
      await http.send('POST', `${project(repository)}/repository/commits`, { branch: input.branch, start_branch: input.base, commit_message: input.title, actions: [{ action: existing === null ? 'create' : 'update', file_path: input.path, content: input.content }] });
      const request = await http.send<{ web_url?: string }>('POST', `${project(repository)}/merge_requests`, { source_branch: input.branch, target_branch: input.base, title: input.title, description: input.body, remove_source_branch: true });
      if (!request.web_url) throw new Error('GitLab opened no merge request');
      return request.web_url;
    },

    // What the merge gate matches required checks against: the job names of the branch's latest pipeline.
    async checkNames(repository, ref) {
      const [latest] = await http.json<{ id: number }[]>(`${project(repository)}/pipelines?ref=${encodeURIComponent(ref)}&per_page=1`);
      if (!latest) return [];
      const jobs = await http.json<{ name?: string }[]>(`${project(repository)}/pipelines/${latest.id}/jobs?per_page=100`);
      return [...new Set((Array.isArray(jobs) ? jobs : []).map(job => job.name).filter((name): name is string => Boolean(name)))].sort();
    },
  };
}

export const SCM_APIS: Record<string, (options: ScmApiOptions) => ScmApi | null> = { github: githubApi, gitlab: gitlabApi };
