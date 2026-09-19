import type { ScmProvider } from './contract.ts';
import { SCM_GATES } from './gates.ts';

const number = (url: string) => /\/(\d+)\/?$/.exec(url)?.[1] ?? '';
const gitlabHost = (env: Record<string, string | undefined>) => env.GITLAB_HOST ? `https://${env.GITLAB_HOST.replace(/^https?:\/\//, '')}` : 'https://gitlab.com';

// Change URLs, view, checks and merge live in gates.ts and publishing in publish.ts; a provider adds the rest of the host's conventions.
const github: ScmProvider = {
  name: 'github', cli: 'gh', tokenVariable: 'GH_TOKEN', changeNoun: 'pull request', changeAbbreviation: 'PR', gate: SCM_GATES.github!,
  mergeDenials: ['gh pr merge'],
  host: () => 'https://github.com',
  validateRepository: repository => typeof repository === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+$/.test(repository) && !['.', '..'].includes(repository.split('/')[1]!),
  isChangeUrl: url => github.gate.parseChangeUrl(url) !== null,
  linkText: url => github.isChangeUrl(url) ? `#${number(url)}` : url.replace(/^https:\/\/github\.com\//, ''),
  commitUrl: (repository, sha) => `https://github.com/${repository}/commit/${sha}`,
  auth: (exec, cwd) => exec('gh', ['auth', 'status'], { cwd }),
};

const gitlab: ScmProvider = {
  name: 'gitlab', cli: 'glab', tokenVariable: 'GITLAB_TOKEN', changeNoun: 'merge request', changeAbbreviation: 'MR', gate: SCM_GATES.gitlab!,
  mergeDenials: ['glab mr merge', 'glab mr approve'],
  host: (env = process.env) => gitlabHost(env),
  // Nested groups are allowed: group/subgroup/project.
  validateRepository: repository => typeof repository === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*)+$/.test(repository) && !repository.split('/').some(part => ['.', '..'].includes(part)),
  isChangeUrl: url => gitlab.gate.parseChangeUrl(url) !== null,
  linkText: url => gitlab.isChangeUrl(url) ? `!${number(url)}` : url.replace(/^https:\/\/[^/]+\//, ''),
  commitUrl: (repository, sha, env = process.env) => `${gitlabHost(env)}/${repository}/-/commit/${sha}`,
  auth: (exec, cwd) => exec('glab', ['auth', 'status'], { cwd }),
};

const ADAPTERS: Record<string, ScmProvider> = { github, gitlab };
export const SCM_KINDS = Object.keys(ADAPTERS);
export const DEFAULT_SCM = 'github';

export function scmAdapter(kind: string = DEFAULT_SCM): ScmProvider {
  const adapter = Object.hasOwn(ADAPTERS, kind) ? ADAPTERS[kind] : undefined;
  if (!adapter) throw new Error(`Unknown scm kind: ${kind}. Use ${SCM_KINDS.join(', ')}`);
  return adapter;
}

// Link text for any known provider URL, for screens that show runs from several projects.
export function linkText(url: string): string {
  const adapter = Object.values(ADAPTERS).find(candidate => candidate.isChangeUrl(url));
  return adapter ? adapter.linkText(url) : url.replace(/^https:\/\//, '');
}
