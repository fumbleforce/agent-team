import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

// Every existing directory on the way must be a real directory: a link there would put worktrees in somebody else's tree.
export function validateDirectoryAncestors(directory: string): void {
  let current = path.parse(directory).root;
  for (const part of directory.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat) return;
    if (!stat.isDirectory()) throw new Error(`Expected a real directory (links are refused): ${current}`);
  }
}

// Created one level at a time and looked at afterwards, so a link planted in between is seen and not followed.
function safeDirectory(directory: string): void {
  try { mkdirSync(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  if (!lstatSync(directory).isDirectory()) throw new Error(`Expected a real directory (links are refused): ${directory}`);
}
function safeDirectories(from: string, to: string): void {
  validateDirectoryAncestors(to);
  let current = from;
  for (const part of path.relative(from, to).split(path.sep).filter(Boolean)) { current = path.join(current, part); safeDirectory(current); }
}

// Worktrees live beside the checkout, never inside it, so tooling cannot resolve the primary checkout's files.
export function worktreeContainer(checkout: string): string {
  const root = realpathSync(checkout);
  const container = path.join(path.dirname(root), '.agent-team-worktrees', createHash('sha256').update(root).digest('hex').slice(0, 12));
  const relative = path.relative(root, container);
  if (!relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`))) throw new Error('The worktree container must be outside the project root');
  validateDirectoryAncestors(container);
  return container;
}

// Worktree add, remove and prune, fetch and gc all write the primary checkout's shared .git. Within one worker process they
// run one at a time per checkout, whichever turn asks; the key is the real path, so two spellings of one checkout share a queue.
const mutexes = new Map<string, Promise<unknown>>();
const checkoutKey = (checkout: string) => { try { const real = realpathSync(checkout); return process.platform === 'win32' ? real.toLowerCase() : real; } catch { return checkout; } };
export function gitAdmin<T>(checkout: string, fn: () => Promise<T>): Promise<T> {
  const key = checkoutKey(checkout);
  const next = (mutexes.get(key) ?? Promise.resolve()).then(fn, fn);
  mutexes.set(key, next.catch(() => {}));
  return next;
}

// A turn that is about to change shared git state says so first and says when it is done, so that a lease lost in between
// is known to have left the checkout, and not only the task, in an unknown state.
export interface AdminHooks { begin(): Promise<void>; end(): Promise<void> }
async function mutating<T>(hooks: AdminHooks | undefined, fn: () => Promise<T>): Promise<T> {
  await hooks?.begin();
  const result = await fn();
  await hooks?.end();
  return result;
}

const slugOf = (taskKey: string) => taskKey.toLowerCase().replace(/[^a-z0-9-]/g, '-');
// Where a task's worktree and branch live; the same derivation as ensureWorktree, without touching git.
export function worktreeFor(checkout: string, taskKey: string, branchPrefix: string): { path: string; branch: string } {
  const slug = slugOf(taskKey);
  return { path: path.join(worktreeContainer(checkout), slug), branch: `${branchPrefix}${slug}` };
}
// Review worktrees sit in a directory no task slug can spell.
const REVIEWS = '_reviews';
export function reviewWorktreeFor(checkout: string, taskKey: string, reviewer: string): string {
  return path.join(worktreeContainer(checkout), REVIEWS, `${slugOf(taskKey)}.${slugOf(reviewer)}`);
}

// The base has to be a commit of this repository that one of its refs leads to: a loose object somebody dropped into the store is refused.
async function validatedCommit(checkout: string, rev: string): Promise<string> {
  const commit = (await git(checkout, ['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`]).catch(() => { throw new Error(`The base ${rev} is not a commit of the primary checkout`); })).trim();
  const fromHead = await git(checkout, ['merge-base', '--is-ancestor', commit, 'HEAD']).then(() => true, () => false);
  if (!fromHead && !(await git(checkout, ['for-each-ref', '--count=1', '--contains', commit])).trim()) throw new Error(`The base ${commit.slice(0, 10)} is not reachable from any branch of the primary checkout`);
  return commit;
}

// File names only are inspected. A name git cannot hand over as valid text cannot be excluded reliably, so it is refused.
async function inspectTree(checkout: string, commit: string): Promise<string[]> {
  const names = await git(checkout, ['ls-tree', '-rz', '--name-only', commit]);
  if (names.includes('\ufffd')) throw new Error('Tracked file names must be valid UTF-8 for a safe sparse exclusion');
  const excluded = names.split('\0').filter(file => file && isSensitivePath(file));
  sparsePatterns(excluded);
  return excluded;
}
function verifyExcluded(target: string, excluded: string[]): void {
  for (const file of excluded) if (lstatSync(path.join(target, file), { throwIfNoEntry: false })) throw new Error(`A sensitive path is present in the worktree: ${file}`);
}

const OVERLAY_RESERVED = ['.git', '.agent-team', 'node_modules', 'database', 'secrets'];
// A path the manifest may name: relative, plain, below no hidden or reserved directory, and never a sensitive file.
export function overlayPath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 300 || path.isAbsolute(value) || /[\\:*?{}]/.test(value) || [...value].some(char => char.charCodeAt(0) < 32)) throw new Error(`Unsafe overlay path: ${String(value)}`);
  const parts = value.split('/');
  if (parts.some((part, index) => !part || part === '.' || part === '..' || OVERLAY_RESERVED.includes(part) || (index < parts.length - 1 && part.startsWith('.')))) throw new Error(`Unsafe overlay path: ${value}`);
  if (isSensitivePath(value)) throw new Error(`A sensitive file cannot be an overlay: ${value}`);
  return value;
}

// Reads a file below a root without following a link anywhere on the way: every component is looked at, not resolved.
export function readSafeFile(root: string, relative: string, optional = false): Buffer | null {
  if (!relative || path.isAbsolute(relative) || [...relative].some(char => char === '\\' || char.charCodeAt(0) < 32)) throw new Error(`Unsafe relative path: ${relative}`);
  const parts = relative.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error(`Unsafe relative path: ${relative}`);
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat && optional) return null;
    if (!stat) throw new Error(`Required file missing: ${relative}`);
    if (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()) throw new Error(`Unsafe file or parent (links are refused): ${relative}`);
  }
  return readFileSync(current);
}

// The files the manifest committed at the base lists under `overlays` (local settings templates, generated configuration),
// read from the primary checkout's working directory. A listed file that is not there is skipped; an unsafe one refuses the worktree.
export async function overlaysFor(checkout: string, commit: string): Promise<Record<string, Buffer>> {
  const manifest = await git(checkout, ['show', `${commit}:.agent-team.json`]).catch(() => null);
  if (!manifest) return {};
  let listed: unknown;
  try { listed = (JSON.parse(manifest) as { overlays?: unknown }).overlays; } catch { return {}; }
  if (listed === undefined) return {};
  if (!Array.isArray(listed) || listed.length > 40) throw new Error('The manifest overlays must be a list of at most 40 paths');
  const files: Record<string, Buffer> = {};
  for (const relative of new Set(listed.map(overlayPath))) {
    const content = readSafeFile(checkout, relative, true);
    if (content !== null) files[relative] = content;
  }
  return files;
}

const OVERLAY_RECORD = 'agent-team-overlays.json';
const sha256 = (content: Uint8Array) => createHash('sha256').update(content).digest('hex');
async function adminDir(worktree: string): Promise<string> { return path.resolve(worktree, (await git(worktree, ['rev-parse', '--git-dir'])).trim()); }

// Written with every parent a real directory and the destination a plain file or nothing. What was written is remembered
// in the worktree's own git directory, outside the agent's tree, so the diff gate can tell an untouched overlay from a change.
async function overlayFiles(worktree: string, files: Record<string, Buffer>): Promise<string[]> {
  const written: Record<string, string> = {};
  for (const [relative, content] of Object.entries(files)) {
    let parent = worktree;
    for (const part of relative.split('/').slice(0, -1)) { parent = path.join(parent, part); safeDirectory(parent); }
    const destination = path.join(worktree, ...relative.split('/'));
    const stat = lstatSync(destination, { throwIfNoEntry: false });
    if (stat && !stat.isFile()) throw new Error(`Unsafe overlay destination: ${relative}`);
    writeFileSync(destination, content);
    written[relative] = sha256(content);
  }
  if (Object.keys(written).length) writeFileSync(path.join(await adminDir(worktree), OVERLAY_RECORD), JSON.stringify(written), { mode: 0o600 });
  return Object.keys(written);
}
// Overlays the turn left exactly as they were written: setup, not the agent's work.
export async function untouchedOverlays(worktree: string): Promise<string[]> {
  let record: Record<string, string>;
  try { record = JSON.parse(readFileSync(path.join(await adminDir(worktree), OVERLAY_RECORD), 'utf8')) as Record<string, string>; } catch { return []; }
  return Object.entries(record).filter(([relative, hash]) => { try { const content = readSafeFile(worktree, relative, true); return content !== null && sha256(content) === hash; } catch { return false; } }).map(([relative]) => relative);
}

// What went wrong while a worktree was half made must not stay behind: least of all a sensitive file that did materialize.
async function discard(checkout: string, target: string, branch: string | null): Promise<void> {
  await git(checkout, ['worktree', 'remove', '--force', target]).catch(() => {});
  rmSync(target, { recursive: true, force: true });
  await git(checkout, ['worktree', 'prune']).catch(() => {});
  if (branch) await git(checkout, ['branch', '-D', '--end-of-options', branch]).catch(() => {});
}

// An existing directory is reused only when it is what it claims to be: a real directory that is a worktree of this checkout.
async function verifyExisting(checkout: string, target: string): Promise<void> {
  if (!lstatSync(target).isDirectory()) throw new Error(`Expected a real directory (links are refused): ${target}`);
  // The system's own resolution, so a short or differently cased spelling of one directory compares equal.
  const real = (file: string) => { const resolved = realpathSync.native(file); return process.platform === 'win32' ? resolved.toLowerCase() : resolved; };
  const common = async (cwd: string) => real(path.resolve(cwd, (await git(cwd, ['rev-parse', '--git-common-dir'])).trim()));
  const top = real((await git(target, ['rev-parse', '--show-toplevel'])).trim());
  if (top !== real(target) || await common(target) !== await common(checkout)) throw new Error(`${target} is not a worktree of the primary checkout`);
}

export interface Worktree { path: string; branch: string; baseCommit: string; excluded: string[]; created: boolean; overlays: string[] }

// One work worktree per task, reused across turns. Nothing is removed automatically. The sequence is the runner's:
// container, ancestor validation, base inspection, no-checkout add, sparse exclusions, checkout, exclusion verification, overlays.
export function ensureWorktree(options: { checkout: string; taskKey: string; branchPrefix: string; base: string; admin?: AdminHooks }): Promise<Worktree> {
  return gitAdmin(options.checkout, async () => {
    const { path: target, branch } = worktreeFor(options.checkout, options.taskKey, options.branchPrefix);
    const baseCommit = await validatedCommit(options.checkout, options.base);
    const excluded = await inspectTree(options.checkout, baseCommit);
    if (existsSync(target)) {
      await verifyExisting(options.checkout, target);
      if ((await git(target, ['symbolic-ref', '--short', 'HEAD']).catch(() => '')).trim() !== branch) throw new Error(`The worktree of ${options.taskKey} is not on its branch ${branch}`);
      verifyExcluded(target, excluded);
      return { path: target, branch, baseCommit, excluded, created: false, overlays: await untouchedOverlays(target) };
    }

    safeDirectories(path.dirname(realpathSync(options.checkout)), path.dirname(target));
    const overlays = await overlaysFor(options.checkout, baseCommit);
    return mutating(options.admin, async () => {
      // A branch that outlived its worktree keeps the work on it; only a branch made here is taken away again on failure.
      const existing = await git(options.checkout, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true, () => false);
      try {
        await git(options.checkout, ['worktree', 'prune']);
        await git(options.checkout, existing ? ['worktree', 'add', '--no-checkout', target, branch] : ['worktree', 'add', '--no-checkout', '-b', branch, target, baseCommit]);
        const hidden = existing ? [...new Set([...excluded, ...await inspectTree(options.checkout, `refs/heads/${branch}`)])] : excluded;
        await git(target, ['sparse-checkout', 'set', '--no-cone', '--stdin'], sparsePatterns(hidden));
        await git(target, ['checkout']);
        verifyExcluded(target, hidden);
        return { path: target, branch, baseCommit, excluded: hidden, created: true, overlays: await overlayFiles(target, overlays) };
      } catch (error) {
        await discard(options.checkout, target, existing ? null : branch);
        throw error;
      }
    });
  });
}

export interface ReviewWorktree { path: string; headSha: string; excluded: string[]; created: boolean; refreshed: boolean }
const REVIEW_RECORD = '.task.json';

// A reviewer or tester reads the change in a tree of its own, detached at the head under review: never the author's worktree,
// never a branch anything could be committed to. One per task and reviewer kind, moved along when the head moves.
export function ensureReviewWorktree(options: { checkout: string; taskKey: string; reviewer: string; headSha: string; projectId?: string; admin?: AdminHooks }): Promise<ReviewWorktree> {
  return gitAdmin(options.checkout, async () => {
    if (!/^[0-9a-f]{40}$/.test(options.headSha)) throw new Error('A review needs the full head sha');
    const target = reviewWorktreeFor(options.checkout, options.taskKey, options.reviewer);
    const present = () => git(options.checkout, ['cat-file', '-e', `${options.headSha}^{commit}`]).then(() => true, () => false);
    // The head was made on this machine as a rule; when it was not, it is fetched, which is shared state again.
    if (!await present()) await mutating(options.admin, () => git(options.checkout, ['fetch', '--quiet', '--no-tags', 'origin']).catch(() => ''));
    if (!await present()) throw new Error(`The head ${options.headSha.slice(0, 10)} is not in the primary checkout`);
    const excluded = await inspectTree(options.checkout, options.headSha);
    const settle = async (created: boolean, refreshed: boolean): Promise<ReviewWorktree> => {
      verifyExcluded(target, excluded);
      if ((await git(target, ['rev-parse', 'HEAD'])).trim() !== options.headSha) throw new Error('The review worktree is not at the head under review');
      if (await git(target, ['symbolic-ref', '-q', 'HEAD']).then(() => true, () => false)) throw new Error('The review worktree is on a branch; it must be detached');
      return { path: target, headSha: options.headSha, excluded, created, refreshed };
    };

    if (existsSync(target)) {
      await verifyExisting(options.checkout, target);
      const moved = (await git(target, ['rev-parse', 'HEAD'])).trim() !== options.headSha;
      // Patterns first, so nothing sensitive in the new head is written even for a moment; then whatever the last review left is dropped.
      await git(target, ['sparse-checkout', 'set', '--no-cone', '--stdin'], sparsePatterns(excluded));
      await git(target, ['checkout', '--quiet', '--force', '--detach', options.headSha]);
      await git(target, ['clean', '-fdq']);
      return settle(false, moved);
    }

    safeDirectories(path.dirname(realpathSync(options.checkout)), path.dirname(target));
    return mutating(options.admin, async () => {
      try {
        await git(options.checkout, ['worktree', 'prune']);
        await git(options.checkout, ['worktree', 'add', '--no-checkout', '--detach', target, options.headSha]);
        await git(target, ['sparse-checkout', 'set', '--no-cone', '--stdin'], sparsePatterns(excluded));
        await git(target, ['checkout', '--quiet', '--detach', options.headSha]);
        // Beside the tree, not in it: which task this belongs to, so it can be found and removed once the task is over.
        writeFileSync(`${target}${REVIEW_RECORD}`, JSON.stringify({ taskKey: options.taskKey, projectId: options.projectId ?? null }), { mode: 0o600 });
        return await settle(true, false);
      } catch (error) {
        await discard(options.checkout, target, null);
        rmSync(`${target}${REVIEW_RECORD}`, { force: true });
        throw error;
      }
    });
  });
}

// The task keys that have review worktrees beside this checkout.
export function reviewedTasks(checkout: string): string[] {
  const dir = path.join(worktreeContainer(checkout), REVIEWS);
  if (!lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
  const keys = readdirSync(dir).filter(name => name.endsWith(REVIEW_RECORD)).map(name => { try { return (JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as { taskKey?: unknown }).taskKey; } catch { return null; } });
  return [...new Set(keys.filter((key): key is string => typeof key === 'string'))];
}

// Once a task is over nobody reviews it again: its review worktrees go, the author's worktree and branch stay.
export function removeReviewWorktrees(checkout: string, taskKey: string, admin?: AdminHooks): Promise<string[]> {
  return gitAdmin(checkout, async () => {
    const dir = path.join(worktreeContainer(checkout), REVIEWS), prefix = `${slugOf(taskKey)}.`;
    if (!lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
    const targets = readdirSync(dir).filter(name => name.startsWith(prefix) && !name.endsWith(REVIEW_RECORD)).map(name => path.join(dir, name));
    if (!targets.length) return [];
    return mutating(admin, async () => {
      for (const target of targets) {
        await git(checkout, ['worktree', 'remove', '--force', target]).catch(() => {});
        if (lstatSync(target, { throwIfNoEntry: false })?.isDirectory()) rmSync(target, { recursive: true, force: true });
        rmSync(`${target}${REVIEW_RECORD}`, { force: true });
      }
      await git(checkout, ['worktree', 'prune']);
      return targets;
    });
  });
}

export async function headSha(worktree: string): Promise<string> { return (await git(worktree, ['rev-parse', 'HEAD'])).trim(); }
export async function changedPaths(worktree: string, baseCommit: string): Promise<string[]> {
  const committed = await git(worktree, ['diff', '--name-only', '-z', `${baseCommit}..HEAD`]);
  const dirty = await git(worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  return [...new Set([...committed.split('\0'), ...dirty.split('\0').map(entry => entry.slice(3))].filter(Boolean))];
}

async function committedManifest(checkout: string, base: string): Promise<Record<string, unknown> | null> {
  const manifest = await git(checkout, ['show', `${base}:.agent-team.json`]).catch(() => null);
  if (!manifest) return null;
  // A manifest that is there and cannot be read refuses the turn: guessing would widen what the repository allows.
  const parsed = JSON.parse(manifest) as unknown;
  return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
}

// The ceiling as committed at the base, read from the primary checkout and never from the agent's worktree,
// so neither an agent's edit nor a wrong coordinator can widen what the repository allows.
export async function committedCeiling(checkout: string, base: string): Promise<PermissionGrant | null> {
  const parsed = PermissionGrant.safeParse((await committedManifest(checkout, base))?.ceiling);
  return parsed.success ? parsed.data : null;
}
export const cappedBy = (grants: PermissionGrant, ceiling: PermissionGrant | null): PermissionGrant => (ceiling ? meet(grants, ceiling) : grants);

// Whether the repository itself, at the base, authorizes publishing: in its ceiling, or in the delivery section the launcher is told from.
export async function publishAuthorized(checkout: string, base: string): Promise<boolean> {
  const manifest = await committedManifest(checkout, base) as { ceiling?: { publishAuthorized?: unknown }; delivery?: { publishAuthorized?: unknown } } | null;
  return manifest?.ceiling?.publishAuthorized === true || manifest?.delivery?.publishAuthorized === true;
}
