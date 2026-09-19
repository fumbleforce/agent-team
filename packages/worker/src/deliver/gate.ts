import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const SHA = /^[0-9a-f]{40}$/;
export type Exec = (bin: string, args: string[], options: { cwd: string }) => Promise<string>;
export interface Change { url: string; state: string; isDraft: boolean; baseRef: string; headRef: string; headSha: string; sameRepository: boolean; mergeable: boolean; mergeCommit?: string | null }
export interface ScmGate {
  name: string; changeNoun: string;
  parseChangeUrl(url: string): { repository: string } | null;
  view(exec: Exec, context: GateContext): Promise<Change>;
  checks(exec: Exec, context: GateContext, options: { includeProtected: boolean }): Promise<{ all: { name: string; passed: boolean }[]; protected: { name: string; passed: boolean }[] | null }>;
  // Takes the change out of draft. The platform publishes drafts; this is the one place a change stops being one.
  ready(exec: Exec, context: GateContext): Promise<unknown>;
  merge(exec: Exec, context: GateContext, headSha: string): Promise<unknown>;
}
export interface GateContext { url: string; repository: string; cwd: string }
export interface DeliveryConfig { repository: string; baseBranch: string; requiredChecks: string[]; autoMergeAuthorized: boolean; checkEnforcement?: 'protected' | 'runner' }
export interface Approval { verdict: string; headSha: string; sessionId: string }
export type Approvals = Partial<Record<'tester' | 'reviewer' | 'pm', Approval>>;
export interface GateResult { state: 'merged' | 'blocked'; reason: string; mergeAttempted: boolean; headSha?: string; mergeCommit?: string }

const VERDICT = { tester: 'PASS', reviewer: 'APPROVE', pm: 'APPROVE' } as const;

export function validateApprovals(approvals: Approvals, headSha: string, roles: readonly (keyof typeof VERDICT)[]): void {
  if (!SHA.test(headSha)) throw new Error('Invalid local head SHA');
  const sessions = new Set<string>();
  for (const role of roles) {
    const approval = approvals[role];
    if (!approval || approval.verdict !== VERDICT[role] || approval.headSha !== headSha || !approval.sessionId.trim() || sessions.has(approval.sessionId)) throw new Error(`Missing, stale or non-independent ${role} approval`);
    sessions.add(approval.sessionId);
  }
}

export const defaultExec: Exec = (bin, args, options) => new Promise((resolve, reject) => {
  execFile(bin, args, { cwd: options.cwd, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => (error ? reject(new Error(`${bin} ${args.join(' ')}: ${String(stderr).trim().slice(-400) || error.message}`)) : resolve(stdout)));
});

// The worktree must be exactly the assigned branch with nothing staged, hidden or uncommitted.
export async function verifyWorktree(exec: Exec, worktree: string, branch: string, excludedPaths: string[]): Promise<string> {
  const git = (...args: string[]) => exec('git', ['-C', worktree, ...args], { cwd: worktree });
  const head = (await git('rev-parse', 'HEAD')).trim();
  if ((await git('branch', '--show-current')).trim() !== branch) throw new Error('Local assigned branch mismatch');
  if ((await git('diff', '--cached', '--name-only', '-z')).length) throw new Error('Uncommitted staged changes');
  // Assume-unchanged or newly hidden tracked files must not evade the status check.
  for (const entry of (await git('ls-files', '-v', '-z')).split('\0').filter(Boolean)) {
    const file = entry.slice(2);
    if (/^[a-z]/.test(entry) || (entry[0] === 'S' && (!excludedPaths.includes(file) || existsSync(path.join(worktree, file))))) throw new Error('Hidden tracked worktree changes');
  }
  const dirty = (await git('status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames')).split('\0').filter(Boolean);
  if (dirty.length) throw new Error(`Uncommitted work: ${dirty[0]!.slice(3)}`);
  return head;
}

// The one path to the base branch. Every gate is read twice, the second time immediately before the single merge,
// approvals included: they are re-read from the platform, so an approval withdrawn in between stops the merge.
export async function deliver(input: { config: DeliveryConfig; scm: ScmGate; approvalRoles?: readonly (keyof typeof VERDICT)[]; prUrl: string; approvals: () => Promise<Approvals>; worktree: string; branch: string; excludedPaths?: string[]; exec?: Exec; signal?: AbortSignal }): Promise<GateResult> {
  const { config, scm, prUrl, worktree, branch } = input;
  const exec = input.exec ?? defaultExec, roles = input.approvalRoles ?? ['tester', 'reviewer', 'pm'];
  let headSha: string | undefined, mergeAttempted = false;
  const abortCheck = () => { if (input.signal?.aborted) throw new Error('Delivery canceled'); };
  try {
    abortCheck();
    if (config.autoMergeAuthorized !== true || !config.requiredChecks?.length) throw new Error('Auto-merge requires delivery.autoMergeAuthorized=true and explicit nonempty requiredChecks');
    if (scm.parseChangeUrl(prUrl)?.repository !== config.repository) throw new Error(`${scm.changeNoun} URL does not belong to the configured repository`);
    const context: GateContext = { url: prUrl, repository: config.repository, cwd: worktree };
    const protectedChecks = (config.checkEnforcement ?? 'protected') !== 'runner';
    const local = () => verifyWorktree(exec, worktree, branch, input.excludedPaths ?? []);
    const validateChange = (change: Change) => {
      if (change.url !== prUrl || change.state !== 'OPEN' || change.isDraft !== false || change.baseRef !== config.baseBranch || change.headRef !== branch || change.headSha !== headSha || change.sameRepository !== true || change.mergeable !== true) throw new Error(`${scm.changeNoun} identity, head or mergeability gate failed`);
    };
    const checks = async () => {
      abortCheck();
      // Protected mode fails closed when the provider's required checks cannot be read.
      const status = await scm.checks(exec, context, { includeProtected: protectedChecks });
      const named = (name: string) => status.all.filter(check => check.name === name);
      if (!Array.isArray(status.all) || (protectedChecks && !Array.isArray(status.protected)) || config.requiredChecks.some(name => named(name).length === 0 || named(name).some(check => !check.passed)) || (status.protected ?? []).some(check => !check.passed)) throw new Error('Required checks missing or not passing');
    };

    headSha = await local();
    validateApprovals(await input.approvals(), headSha, roles);
    // Work is published as a draft. With every required approval valid at this head, and only then, the change is marked ready;
    // a draft that is not exactly the change that was approved is left alone and fails the identity check below.
    const first = await scm.view(exec, context);
    if (first.isDraft === true && first.url === prUrl && first.state === 'OPEN' && first.baseRef === config.baseBranch && first.headRef === branch && first.headSha === headSha && first.sameRepository === true) {
      abortCheck();
      await scm.ready(exec, context);
    }
    validateChange(await scm.view(exec, context));
    await checks();
    // Fresh reads immediately before the single mutation.
    if (await local() !== headSha) throw new Error('Local head changed between reads');
    validateApprovals(await input.approvals(), headSha, roles);
    await checks();
    validateChange(await scm.view(exec, context));
    abortCheck();
    mergeAttempted = true;
    await scm.merge(exec, context, headSha);
    const merged = await scm.view(exec, context);
    if (merged.url !== prUrl || merged.state !== 'MERGED' || merged.headSha !== headSha || !SHA.test(merged.mergeCommit ?? '')) throw new Error(`${scm.name} did not confirm MERGED with an actual merge commit`);
    return { state: 'merged', reason: `${scm.name} confirmed MERGED with an actual merge commit`, mergeAttempted, headSha, mergeCommit: merged.mergeCommit! };
  } catch (error) {
    return { state: 'blocked', reason: (error as Error).message, mergeAttempted, ...(headSha ? { headSha } : {}) };
  }
}
