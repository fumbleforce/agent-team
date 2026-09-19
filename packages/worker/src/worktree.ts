import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { meet, PermissionGrant } from '@agent-team/protocol';

const run = promisify(execFile);
const git = (cwd: string, args: string[], input?: string) => {
  const child = run('git', ['-C', cwd, ...args], { timeout: 120_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (input !== undefined) child.child.stdin?.end(input);
  return child.then(result => result.stdout);
};

const KEY_NAMES = /^(id_(rsa|dsa|ecdsa|ed25519)|ssh_host_.*_key|.*\.pem|.*\.p12|.*\.pfx)$/;
const TEMPLATE = /(example|sample|template)/i;

// Files an agent never sees: environment files, secret directories, databases and private keys.
export function isSensitivePath(file: string): boolean {
  return file.split('/').some(part => {
    if (TEMPLATE.test(part)) return false;
    return part === '.env' || part.startsWith('.env.') || part.endsWith('.env') || part.startsWith('.secrets') || /\.(db|sqlite3?)(-wal|-shm|-journal)?$/.test(part) || KEY_NAMES.test(part);
  });
}

export function sparsePatterns(excluded: string[]): string {
  for (const file of excluded) if (/[\r\n\0]/.test(file)) throw new Error('A tracked file name cannot be excluded safely');
  return ['/*', ...excluded.map(file => `!/${file.replace(/[\\*?[\]!#]/g, '\\$&')}`)].join('\n') + '\n';
}

// Worktrees live beside the checkout, never inside it, so tooling cannot resolve the primary checkout's files.
export function worktreeContainer(checkout: string): string {
  const root = realpathSync(checkout);
  return path.join(path.dirname(root), '.agent-team-worktrees', createHash('sha256').update(root).digest('hex').slice(0, 12));
}

const mutexes = new Map<string, Promise<unknown>>();
// Worktree add and fetch touch the checkout's shared .git; they run one at a time per checkout.
function serialized<T>(checkout: string, fn: () => Promise<T>): Promise<T> {
  const next = (mutexes.get(checkout) ?? Promise.resolve()).then(fn, fn);
  mutexes.set(checkout, next.catch(() => {}));
  return next;
}

// Where a task's worktree and branch live; the same derivation as ensureWorktree, without touching git.
export function worktreeFor(checkout: string, taskKey: string, branchPrefix: string): { path: string; branch: string } {
  const slug = taskKey.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return { path: path.join(worktreeContainer(checkout), slug), branch: `${branchPrefix}${slug}` };
}

export interface Worktree { path: string; branch: string; baseCommit: string; excluded: string[]; created: boolean }

// One work worktree per task, reused across turns. Nothing is removed automatically.
export function ensureWorktree(options: { checkout: string; taskKey: string; branchPrefix: string; base: string }): Promise<Worktree> {
  return serialized(options.checkout, async () => {
    const { path: target, branch } = worktreeFor(options.checkout, options.taskKey, options.branchPrefix);
    const baseCommit = (await git(options.checkout, ['rev-parse', '--verify', '--end-of-options', `${options.base}^{commit}`])).trim();
    const tracked = (await git(options.checkout, ['ls-tree', '-rz', '--name-only', baseCommit])).split('\0').filter(Boolean);
    const excluded = tracked.filter(isSensitivePath);
    if (existsSync(target)) return { path: target, branch, baseCommit, excluded, created: false };

    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    await git(options.checkout, ['worktree', 'add', '--no-checkout', '-b', branch, target, baseCommit]);
    await git(target, ['sparse-checkout', 'set', '--no-cone', '--stdin'], sparsePatterns(excluded));
    await git(target, ['checkout']);
    for (const file of excluded) if (lstatSync(path.join(target, file), { throwIfNoEntry: false })) throw new Error(`Excluded file materialized: ${file}`);
    return { path: target, branch, baseCommit, excluded, created: true };
  });
}

export async function headSha(worktree: string): Promise<string> { return (await git(worktree, ['rev-parse', 'HEAD'])).trim(); }
export async function changedPaths(worktree: string, baseCommit: string): Promise<string[]> {
  const committed = await git(worktree, ['diff', '--name-only', '-z', `${baseCommit}..HEAD`]);
  const dirty = await git(worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  return [...new Set([...committed.split('\0'), ...dirty.split('\0').map(entry => entry.slice(3))].filter(Boolean))];
}

// The ceiling as committed at the base, read from the primary checkout and never from the agent's worktree,
// so neither an agent's edit nor a wrong coordinator can widen what the repository allows.
export async function committedCeiling(checkout: string, base: string): Promise<PermissionGrant | null> {
  const manifest = await git(checkout, ['show', `${base}:.agent-team.json`]).catch(() => null);
  if (!manifest) return null;
  const parsed = PermissionGrant.safeParse((JSON.parse(manifest) as { ceiling?: unknown }).ceiling);
  return parsed.success ? parsed.data : null;
}
export const cappedBy = (grants: PermissionGrant, ceiling: PermissionGrant | null): PermissionGrant => (ceiling ? meet(grants, ceiling) : grants);
