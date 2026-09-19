export type Exec = (bin: string, args: string[], options: { cwd: string }) => Promise<string>;
export interface PublishInput { worktree: string; repository: string; branch: string; base: string; title: string; body: string }
export interface PublishResult { url: string; created: boolean }

interface ScmPublisher { cli: string; find(input: PublishInput): string[]; create(input: PublishInput): string[]; urlOf(output: string): string | null }

// The same contract for both hosts: look for an open change on the branch, else open a draft against the base.
const PUBLISHERS: Record<string, ScmPublisher> = {
  github: {
    cli: 'gh',
    find: input => ['pr', 'list', '--repo', input.repository, '--head', input.branch, '--state', 'open', '--json', 'url', '--jq', '.[0].url'],
    create: input => ['pr', 'create', '--repo', input.repository, '--draft', '--base', input.base, '--head', input.branch, '--title', input.title, '--body', input.body],
    urlOf: output => /https:\/\/\S+\/pull\/\d+/.exec(output)?.[0] ?? null,
  },
  gitlab: {
    cli: 'glab',
    find: input => ['mr', 'list', '--repo', input.repository, '--source-branch', input.branch, '--output', 'json'],
    create: input => ['mr', 'create', '--repo', input.repository, '--draft', '--target-branch', input.base, '--source-branch', input.branch, '--title', input.title, '--description', input.body, '--yes'],
    urlOf: output => /https:\/\/\S+\/-\/merge_requests\/\d+/.exec(output)?.[0] ?? null,
  },
};
export const PUBLISH_KINDS = Object.keys(PUBLISHERS);

// Publishing is worker code, never an agent's: push without force, then create or reuse the draft change.
export async function publish(kind: string, input: PublishInput, exec: Exec): Promise<PublishResult> {
  const publisher = PUBLISHERS[kind];
  if (!publisher) throw new Error(`Unknown SCM "${kind}"`);
  if (input.branch === input.base) throw new Error('Refusing to publish the base branch');
  await exec('git', ['-C', input.worktree, 'push', '--set-upstream', 'origin', `${input.branch}:${input.branch}`], { cwd: input.worktree });
  const existing = publisher.urlOf(await exec(publisher.cli, publisher.find(input), { cwd: input.worktree }).catch(() => ''));
  if (existing) return { url: existing, created: false };
  const url = publisher.urlOf(await exec(publisher.cli, publisher.create(input), { cwd: input.worktree }));
  if (!url) throw new Error('The SCM did not return a change URL');
  return { url, created: true };
}
