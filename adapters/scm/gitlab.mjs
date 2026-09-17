// SCM adapter for GitLab through the `glab` CLI, using its REST passthrough (`glab api`) so the
// same fields are available on gitlab.com and self-managed instances. Merges pass the expected
// head `sha`, which GitLab rejects when the source branch moved.
export const NAME = 'gitlab';
export const CLI = 'glab';
export const TOKEN_VARIABLE = 'GITLAB_TOKEN';
export const CHANGE_NOUN = 'merge request';
export const CHANGE_ABBREVIATION = 'MR';
export const HOST = process.env.GITLAB_HOST ? `https://${process.env.GITLAB_HOST.replace(/^https?:\/\//, '')}` : 'https://gitlab.com';

const SHA = /^[0-9a-f]{40}$/;

// Nested groups are allowed: group/subgroup/project.
export function validateRepository(repository) {
  return typeof repository === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*)+$/.test(repository) && !repository.split('/').some(part => ['.', '..'].includes(part));
}

export function parseChangeUrl(url) {
  const match = /^https:\/\/[^/]+\/(.+?)\/-\/merge_requests\/([1-9][0-9]*)$/.exec(String(url ?? ''));
  return match ? { repository: match[1], number: Number(match[2]) } : null;
}

export function isChangeUrl(url) { return parseChangeUrl(url) !== null; }

export function linkText(url) {
  const parsed = parseChangeUrl(url);
  return parsed ? `!${parsed.number}` : String(url).replace(/^https:\/\/[^/]+\//, '');
}

export function commitUrl(repository, sha) { return `${HOST}/${repository}/-/commit/${sha}`; }

export const MERGE_DENIALS = ['glab mr merge', 'glab mr approve'];

export function publishInstructions({ repository, baseBranch, branch }) {
  return `Source control is GitLab (${repository}); use the glab CLI. Push the assigned branch ${branch} and open an inspectable draft merge request against ${baseBranch} early with \`glab mr create --draft --target-branch ${baseBranch} --fill\`, clearly stating unrun or failed checks. Remove the draft marker with \`glab mr update --ready\` only after all gates accept. Never run glab mr merge or glab mr approve.`;
}

export function auth({ command, cwd, env }) { return command(CLI, ['auth', 'status'], cwd, env); }

const encode = repository => encodeURIComponent(repository);

function api(exec, { cwd, env, signal }) {
  return (method, route, fields = []) => exec(CLI, ['api', '-X', method, route, ...fields.flatMap(field => ['-f', field])], { cwd, env, signal });
}

export async function view(exec, context) {
  const parsed = parseChangeUrl(context.url);
  if (!parsed) throw new Error('Not a merge request URL');
  const mr = JSON.parse(await api(exec, context)('GET', `projects/${encode(context.repository)}/merge_requests/${parsed.number}`));
  const merged = SHA.test(mr.squash_commit_sha ?? '') ? mr.squash_commit_sha : SHA.test(mr.merge_commit_sha ?? '') ? mr.merge_commit_sha : null;
  return { url: mr.web_url, state: mr.state === 'opened' ? 'OPEN' : mr.state === 'merged' ? 'MERGED' : String(mr.state ?? '').toUpperCase(), isDraft: mr.draft === true || mr.work_in_progress === true,
    baseRef: mr.target_branch, headRef: mr.source_branch, headSha: mr.sha, sameRepository: mr.source_project_id === mr.target_project_id && mr.project_id === mr.target_project_id,
    mergeable: mr.detailed_merge_status === 'mergeable', mergeCommit: merged, pipelineId: mr.head_pipeline?.id ?? null, pipelineStatus: mr.head_pipeline?.status ?? null };
}

// Configured requiredChecks are pipeline job names of the head pipeline. With includeProtected the
// project setting "pipelines must succeed" is read; when set, the whole pipeline is a required check.
export async function checks(exec, context, { includeProtected }) {
  const call = api(exec, context);
  const current = await view(exec, context);
  if (!current.pipelineId) throw new Error('Merge request has no head pipeline');
  const jobs = JSON.parse(await call('GET', `projects/${encode(context.repository)}/pipelines/${current.pipelineId}/jobs?per_page=100&include_retried=false`));
  if (!Array.isArray(jobs)) throw new Error('Unreadable pipeline jobs');
  const all = jobs.map(job => ({ name: job.name, passed: job.status === 'success' || (job.status === 'skipped' && job.allow_failure === true) || (job.status === 'failed' && job.allow_failure === true) }));
  let protectedChecks = null;
  if (includeProtected) {
    const project = JSON.parse(await call('GET', `projects/${encode(context.repository)}`));
    if (typeof project.only_allow_merge_if_pipeline_succeeds !== 'boolean') throw new Error('Unreadable project merge settings');
    protectedChecks = project.only_allow_merge_if_pipeline_succeeds ? [{ name: 'pipeline', passed: current.pipelineStatus === 'success' }] : [];
  }
  return { all, protected: protectedChecks };
}

export async function merge(exec, context, headSha) {
  const parsed = parseChangeUrl(context.url);
  await api(exec, context)('PUT', `projects/${encode(context.repository)}/merge_requests/${parsed.number}/merge`, [`sha=${headSha}`, 'squash=true', 'should_remove_source_branch=true']);
}
