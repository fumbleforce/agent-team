// SCM adapter for GitHub through the `gh` CLI. Delivery reads a normalized change-request view
// and merges with --match-head-commit so the server rejects a moved head.
export const NAME = 'github';
export const CLI = 'gh';
export const TOKEN_VARIABLE = 'GH_TOKEN';
export const CHANGE_NOUN = 'pull request';
export const CHANGE_ABBREVIATION = 'PR';
export const HOST = 'https://github.com';

const FIELDS = 'url,state,isDraft,baseRefName,headRefName,headRefOid,headRepository,headRepositoryOwner,isCrossRepository,mergeStateStatus,mergeable,mergeCommit';
const SHA = /^[0-9a-f]{40}$/;

export function validateRepository(repository) {
  return typeof repository === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+$/.test(repository) && !['.', '..'].includes(repository.split('/')[1]);
}

export function parseChangeUrl(url) {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]*)$/.exec(String(url ?? ''));
  return match ? { repository: match[1], number: Number(match[2]) } : null;
}

export function isChangeUrl(url) { return parseChangeUrl(url) !== null; }

export function linkText(url) {
  const parsed = parseChangeUrl(url);
  return parsed ? `#${parsed.number}` : String(url).replace(/^https:\/\/github\.com\//, '');
}

export function commitUrl(repository, sha) { return `${HOST}/${repository}/commit/${sha}`; }

// Shell prefixes engines must never run; the runner's delivery helper is the only merge path.
export const MERGE_DENIALS = ['gh pr merge'];

// Prompt text telling the coordinator how to publish with this provider.
export function publishInstructions({ repository, baseBranch, branch }) {
  return `Source control is GitHub (${repository}); use the gh CLI. Push the assigned branch ${branch} and open an inspectable draft pull request against ${baseBranch} early with \`gh pr create --draft --base ${baseBranch}\`, clearly stating unrun or failed checks. Mark it ready with \`gh pr ready\` only after all gates accept. Never run gh pr merge.`;
}

export function auth({ command, cwd, env }) { return command(CLI, ['auth', 'status'], cwd, env); }

function gh(exec, { url, repository, cwd, env, signal }) {
  return (verb, ...args) => exec(CLI, ['pr', verb, url, '--repo', repository, ...args], { cwd, env, signal });
}

export async function view(exec, context) {
  const pr = JSON.parse(await gh(exec, context)('view', '--json', FIELDS));
  return { url: pr.url, state: pr.state, isDraft: pr.isDraft, baseRef: pr.baseRefName, headRef: pr.headRefName, headSha: pr.headRefOid,
    sameRepository: pr.isCrossRepository === false && `${pr.headRepositoryOwner?.login}/${pr.headRepository?.name}` === context.repository,
    mergeable: pr.mergeable === 'MERGEABLE' && pr.mergeStateStatus === 'CLEAN', mergeCommit: SHA.test(pr.mergeCommit?.oid ?? '') ? pr.mergeCommit.oid : null };
}

// `protected` is null when the caller enforces only configured checks; otherwise the checks the
// branch protection requires. An unavailable protected-check lookup throws (fail closed).
export async function checks(exec, context, { includeProtected }) {
  const normalize = list => list.map(check => ({ name: check.name, passed: check.bucket === 'pass' }));
  const all = normalize(JSON.parse(await gh(exec, context)('checks', '--json', 'name,bucket,state')));
  const protectedChecks = includeProtected ? normalize(JSON.parse(await gh(exec, context)('checks', '--required', '--json', 'name,bucket,state'))) : null;
  if (!Array.isArray(all) || (includeProtected && !Array.isArray(protectedChecks))) throw new Error('Unreadable check status');
  return { all, protected: protectedChecks };
}

export async function merge(exec, context, headSha) {
  await gh(exec, context)('merge', '--squash', '--match-head-commit', headSha);
}
