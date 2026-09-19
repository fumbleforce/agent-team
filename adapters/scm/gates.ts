import type { Change, Exec, GateContext, ScmGate } from '../../packages/worker/src/deliver/gate.ts';

const SHA = /^[0-9a-f]{40}$/;
const GH_FIELDS = 'url,state,isDraft,baseRefName,headRefName,headRefOid,isCrossRepository,headRepository,headRepositoryOwner,mergeable,mergeStateStatus,mergeCommit';

const gh = (exec: Exec, context: GateContext) => (verb: string, ...args: string[]) => exec('gh', ['pr', verb, context.url, '--repo', context.repository, ...args], { cwd: context.cwd });

export const github: ScmGate = {
  name: 'github', changeNoun: 'PR',
  parseChangeUrl(url) { const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/?$/.exec(url); return match ? { repository: match[1]! } : null; },
  async view(exec, context) {
    const pr = JSON.parse(await gh(exec, context)('view', '--json', GH_FIELDS));
    return { url: pr.url, state: pr.state, isDraft: pr.isDraft, baseRef: pr.baseRefName, headRef: pr.headRefName, headSha: pr.headRefOid,
      sameRepository: pr.isCrossRepository === false && `${pr.headRepositoryOwner?.login}/${pr.headRepository?.name}` === context.repository,
      mergeable: pr.mergeable === 'MERGEABLE' && pr.mergeStateStatus === 'CLEAN', mergeCommit: SHA.test(pr.mergeCommit?.oid ?? '') ? pr.mergeCommit.oid : null };
  },
  // `protected` is null when only configured checks are enforced; an unreadable required-check lookup throws, so the gate fails closed.
  async checks(exec, context, { includeProtected }) {
    const read = async (...flags: string[]) => (JSON.parse(await gh(exec, context)('checks', ...flags, '--json', 'name,bucket,state')) as { name: string; bucket: string }[]).map(check => ({ name: check.name, passed: check.bucket === 'pass' }));
    return { all: await read(), protected: includeProtected ? await read('--required') : null };
  },
  async merge(exec, context, headSha) { await gh(exec, context)('merge', '--squash', '--match-head-commit', headSha); },
};

const glab = (exec: Exec, context: GateContext) => (method: string, route: string, fields: string[] = []) => exec('glab', ['api', '-X', method, route, ...fields.flatMap(field => ['-f', field])], { cwd: context.cwd });
const mergeRequest = (url: string) => /^https:\/\/[^/]+\/(.+?)\/-\/merge_requests\/(\d+)\/?$/.exec(url);
type GitlabChange = Change & { pipelineId: number | null; pipelineStatus: string | null };

async function gitlabView(exec: Exec, context: GateContext): Promise<GitlabChange> {
  const parsed = mergeRequest(context.url);
  if (!parsed) throw new Error('Not a merge request URL');
  const mr = JSON.parse(await glab(exec, context)('GET', `projects/${encodeURIComponent(context.repository)}/merge_requests/${parsed[2]}`));
  const merged = SHA.test(mr.squash_commit_sha ?? '') ? mr.squash_commit_sha : SHA.test(mr.merge_commit_sha ?? '') ? mr.merge_commit_sha : null;
  return { url: mr.web_url, state: mr.state === 'opened' ? 'OPEN' : mr.state === 'merged' ? 'MERGED' : String(mr.state ?? '').toUpperCase(), isDraft: mr.draft === true || mr.work_in_progress === true,
    baseRef: mr.target_branch, headRef: mr.source_branch, headSha: mr.sha, sameRepository: mr.source_project_id === mr.target_project_id && mr.project_id === mr.target_project_id,
    mergeable: mr.detailed_merge_status === 'mergeable', mergeCommit: merged, pipelineId: mr.head_pipeline?.id ?? null, pipelineStatus: mr.head_pipeline?.status ?? null };
}

export const gitlab: ScmGate = {
  name: 'gitlab', changeNoun: 'MR',
  parseChangeUrl(url) { const match = mergeRequest(url); return match ? { repository: match[1]! } : null; },
  view: gitlabView,
  // Required checks are job names of the head pipeline; with "pipelines must succeed" set, the whole pipeline is required too.
  async checks(exec, context, { includeProtected }) {
    const current = await gitlabView(exec, context);
    if (!current.pipelineId) throw new Error('Merge request has no head pipeline');
    const project = `projects/${encodeURIComponent(context.repository)}`;
    const jobs = JSON.parse(await glab(exec, context)('GET', `${project}/pipelines/${current.pipelineId}/jobs?per_page=100&include_retried=false`)) as { name: string; status: string; allow_failure?: boolean }[];
    if (!Array.isArray(jobs)) throw new Error('Unreadable pipeline jobs');
    const all = jobs.map(job => ({ name: job.name, passed: job.status === 'success' || ((job.status === 'skipped' || job.status === 'failed') && job.allow_failure === true) }));
    if (!includeProtected) return { all, protected: null };
    const settings = JSON.parse(await glab(exec, context)('GET', project)) as { only_allow_merge_if_pipeline_succeeds?: unknown };
    if (typeof settings.only_allow_merge_if_pipeline_succeeds !== 'boolean') throw new Error('Unreadable project merge settings');
    return { all, protected: settings.only_allow_merge_if_pipeline_succeeds ? [{ name: 'pipeline', passed: current.pipelineStatus === 'success' }] : [] };
  },
  async merge(exec, context, headSha) {
    const parsed = mergeRequest(context.url);
    await glab(exec, context)('PUT', `projects/${encodeURIComponent(context.repository)}/merge_requests/${parsed![2]}/merge`, [`sha=${headSha}`, 'squash=true', 'should_remove_source_branch=true']);
  },
};

export const SCM_GATES: Record<string, ScmGate> = { github, gitlab };
