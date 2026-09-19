import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { changedPaths, ensureReviewWorktree, ensureWorktree, gitAdmin, overlayPath, readSafeFile, removeReviewWorktrees, reviewedTasks, reviewWorktreeFor, untouchedOverlays, worktreeFor } from './worktree.ts';

const FILES = [['src.ts', 'code'], ['.env', 'SECRET=1'], ['.env.example', 'SECRET='], ['config/prod.sqlite', 'db'], ['config/id_rsa', 'key']] as const;

function repository(manifest?: unknown): { checkout: string; git: (...args: string[]) => string } {
  const checkout = path.join(mkdtempSync(path.join(os.tmpdir(), 'agent-team-wts-')), 'project');
  mkdirSync(path.join(checkout, 'config'), { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-C', checkout, ...args], { stdio: 'pipe' }).toString().trim();
  execFileSync('git', ['init', '-q', '-b', 'main', checkout]);
  git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T');
  for (const [file, body] of FILES) writeFileSync(path.join(checkout, file), body);
  if (manifest) writeFileSync(path.join(checkout, '.agent-team.json'), JSON.stringify(manifest));
  git('add', '-A', '-f'); git('commit', '-q', '-m', 'init');
  return { checkout, git };
}
// A directory link that needs no privilege on any system: a junction on Windows, a symbolic link elsewhere.
const linkDirectory = (target: string, link: string) => symlinkSync(target, link, 'junction');
const options = (checkout: string, taskKey = 'CK-31', base = 'HEAD') => ({ checkout, taskKey, branchPrefix: 'agents/', base });

test('the base must be a commit the primary checkout leads to', async () => {
  const { checkout, git } = repository();
  await assert.rejects(ensureWorktree(options(checkout, 'CK-1', 'no-such-branch')), /not a commit of the primary checkout/);
  // A commit object nothing refers to: present in the store, reachable from no branch.
  const loose = git('commit-tree', 'HEAD^{tree}', '-m', 'dropped in');
  await assert.rejects(ensureWorktree(options(checkout, 'CK-1', loose)), /not reachable from any branch/);
  assert.equal(existsSync(worktreeFor(checkout, 'CK-1', 'agents/').path), false);
  // Once a branch leads to it, it is the repository's own history, whether or not HEAD contains it.
  git('branch', 'side', loose);
  assert.equal((await ensureWorktree(options(checkout, 'CK-2', 'side'))).created, true);
});

test('a link among the ancestors of the worktree container is refused', async () => {
  const { checkout } = repository();
  const elsewhere = mkdtempSync(path.join(os.tmpdir(), 'agent-team-elsewhere-'));
  linkDirectory(elsewhere, path.join(path.dirname(checkout), '.agent-team-worktrees'));
  await assert.rejects(ensureWorktree(options(checkout)), /real directory/);
  assert.deepEqual(execFileSync('git', ['-C', checkout, 'branch', '--list', 'agents/*']).toString().trim(), '');
});

test('a sensitive path present in a worktree fails it, on reuse as after the checkout', async () => {
  const { checkout } = repository();
  const first = await ensureWorktree(options(checkout));
  writeFileSync(path.join(first.path, '.env'), 'SECRET=materialized');
  await assert.rejects(ensureWorktree(options(checkout)), /sensitive path is present in the worktree: \.env/);
});

test('a worktree that cannot be completed leaves neither a directory nor a branch behind', async () => {
  const { checkout, git } = repository();
  await assert.rejects(ensureWorktree({ ...options(checkout), branchPrefix: 'bad..prefix/' }));
  assert.equal(existsSync(worktreeFor(checkout, 'CK-31', 'bad..prefix/').path), false);
  assert.equal(git('worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).length, 1);
});

test('overlays the manifest lists are copied in, never a secret, and an untouched one is not the agent’s change', async () => {
  const { checkout } = repository({ overlays: ['config/local.example.json', 'docs/absent.md'] });
  writeFileSync(path.join(checkout, 'config/local.example.json'), '{"port":4000}');
  const tree = await ensureWorktree(options(checkout));
  assert.deepEqual(tree.overlays, ['config/local.example.json']);
  assert.equal(readFileSync(path.join(tree.path, 'config/local.example.json'), 'utf8'), '{"port":4000}');
  assert.deepEqual(await changedPaths(tree.path, tree.baseCommit), ['config/local.example.json']);
  assert.deepEqual(await untouchedOverlays(tree.path), ['config/local.example.json']);
  // The record is kept in the worktree's git directory, not in the tree the agent edits.
  assert.equal(existsSync(path.join(tree.path, 'agent-team-overlays.json')), false);
  writeFileSync(path.join(tree.path, 'config/local.example.json'), '{"port":1}');
  assert.deepEqual(await untouchedOverlays(tree.path), []);
  assert.deepEqual((await ensureWorktree(options(checkout))).overlays, []);

  for (const bad of ['.env', 'config/prod.sqlite', '../outside.txt', '/etc/passwd', 'a\\b', '.git/config', '.hidden/file.txt', 'secrets/token.txt', 'a/./b', '', 7]) assert.throws(() => overlayPath(bad), /overlay/i, String(bad));
  assert.equal(overlayPath('.env.example'), '.env.example');
  const secret = repository({ overlays: ['.env'] });
  await assert.rejects(ensureWorktree(options(secret.checkout)), /sensitive file cannot be an overlay/);
  assert.equal(existsSync(worktreeFor(secret.checkout, 'CK-31', 'agents/').path), false);
});

test('files are read without following a link out of the tree', async () => {
  const { checkout } = repository({ overlays: ['linked/notes.txt'] });
  const outside = mkdtempSync(path.join(os.tmpdir(), 'agent-team-outside-'));
  writeFileSync(path.join(outside, 'notes.txt'), 'not yours');
  linkDirectory(outside, path.join(checkout, 'linked'));
  assert.equal(readFileSync(path.join(checkout, 'linked/notes.txt'), 'utf8'), 'not yours');
  assert.throws(() => readSafeFile(checkout, 'linked/notes.txt'), /links are refused/);
  assert.throws(() => readSafeFile(checkout, '../project/src.ts'), /Unsafe relative path/);
  assert.throws(() => readSafeFile(checkout, 'absent.txt'), /missing/);
  assert.equal(readSafeFile(checkout, 'absent.txt', true), null);
  assert.equal(readSafeFile(checkout, 'src.ts')?.toString(), 'code');
  await assert.rejects(ensureWorktree(options(checkout)), /links are refused/);
});

test('a review worktree is detached at the head, hides the same secrets, is reused, follows the head and goes when the task is over', async () => {
  const { checkout } = repository();
  const author = await ensureWorktree(options(checkout));
  const commit = (file: string, body: string) => { mkdirSync(path.dirname(path.join(author.path, file)), { recursive: true }); writeFileSync(path.join(author.path, file), body); execFileSync('git', ['-C', author.path, 'add', '-f', file]); execFileSync('git', ['-C', author.path, 'commit', '-q', '-m', file]); return execFileSync('git', ['-C', author.path, 'rev-parse', 'HEAD']).toString().trim(); };
  const head1 = commit('feature.ts', 'one');

  const review = await ensureReviewWorktree({ checkout, taskKey: 'CK-31', reviewer: 'tester', headSha: head1 });
  assert.deepEqual([review.created, review.refreshed, review.headSha], [true, false, head1]);
  assert.equal(review.path, reviewWorktreeFor(checkout, 'CK-31', 'tester'));
  assert.notEqual(review.path, author.path);
  assert.equal(readFileSync(path.join(review.path, 'feature.ts'), 'utf8'), 'one');
  assert.ok(!existsSync(path.join(review.path, '.env')) && !existsSync(path.join(review.path, 'config/id_rsa')) && existsSync(path.join(review.path, '.env.example')));
  // Detached: no branch a commit could land on.
  assert.throws(() => execFileSync('git', ['-C', review.path, 'symbolic-ref', '-q', 'HEAD'], { stdio: 'pipe' }));
  assert.equal(execFileSync('git', ['-C', review.path, 'rev-parse', 'HEAD']).toString().trim(), head1);

  // Another kind of reviewer gets another tree; the same kind gets the same one, cleaned of what the last turn left.
  const other = await ensureReviewWorktree({ checkout, taskKey: 'CK-31', reviewer: 'reviewer', headSha: head1 });
  assert.notEqual(other.path, review.path);
  writeFileSync(path.join(review.path, 'left-behind.log'), 'x'); writeFileSync(path.join(review.path, 'feature.ts'), 'edited by a reviewer');
  const again = await ensureReviewWorktree({ checkout, taskKey: 'CK-31', reviewer: 'tester', headSha: head1 });
  assert.deepEqual([again.path, again.created, again.refreshed], [review.path, false, false]);
  assert.equal(existsSync(path.join(review.path, 'left-behind.log')), false);
  assert.equal(readFileSync(path.join(review.path, 'feature.ts'), 'utf8'), 'one');

  // The head moves, and brings a secret with it: the tree follows and the new secret is never written.
  const head2 = commit('deploy/.env', 'TOKEN=1');
  const moved = await ensureReviewWorktree({ checkout, taskKey: 'CK-31', reviewer: 'tester', headSha: head2 });
  assert.deepEqual([moved.refreshed, moved.headSha, moved.excluded.includes('deploy/.env')], [true, head2, true]);
  assert.equal(existsSync(path.join(moved.path, 'deploy/.env')), false);
  assert.equal(execFileSync('git', ['-C', author.path, 'symbolic-ref', '--short', 'HEAD']).toString().trim(), 'agents/ck-31');

  await assert.rejects(ensureReviewWorktree({ checkout, taskKey: 'CK-31', reviewer: 'tester', headSha: 'f'.repeat(40) }), /not in the primary checkout/);
  await assert.rejects(ensureReviewWorktree({ checkout, taskKey: 'CK-31', reviewer: 'tester', headSha: 'main' }), /full head sha/);

  assert.deepEqual(reviewedTasks(checkout), ['CK-31']);
  assert.equal((await removeReviewWorktrees(checkout, 'CK-3')).length, 0);
  assert.equal((await removeReviewWorktrees(checkout, 'CK-31')).length, 2);
  assert.ok(!existsSync(review.path) && !existsSync(other.path) && existsSync(author.path));
  assert.deepEqual(reviewedTasks(checkout), []);
  assert.equal(execFileSync('git', ['-C', checkout, 'worktree', 'list', '--porcelain']).toString().split('\n').filter(line => line.startsWith('worktree ')).length, 2);
});

test('git-admin operations on one checkout run one at a time and are announced on both sides', async () => {
  const { checkout } = repository();
  const log: string[] = [];
  let inside = 0, overlapped = false;
  const admin = (name: string) => ({ begin: async () => { if (++inside > 1) overlapped = true; log.push(`begin ${name}`); await new Promise(resolve => setTimeout(resolve, 20)); }, end: async () => { log.push(`end ${name}`); inside--; } });
  const trees = await Promise.all(['CK-1', 'CK-2', 'CK-3', 'CK-4'].map(taskKey => ensureWorktree({ ...options(checkout, taskKey), admin: admin(taskKey) })));
  assert.equal(trees.every(tree => tree.created), true);
  assert.equal(overlapped, false);
  assert.deepEqual(log, ['CK-1', 'CK-2', 'CK-3', 'CK-4'].flatMap(name => [`begin ${name}`, `end ${name}`]));
  // Reuse changes nothing shared, so it announces nothing.
  await ensureWorktree({ ...options(checkout, 'CK-1'), admin: admin('again') });
  assert.equal(log.length, 8);

  // Two spellings of one checkout share the queue; a failure does not wedge it.
  const order: string[] = [];
  const slow = gitAdmin(checkout, async () => { await new Promise(resolve => setTimeout(resolve, 30)); order.push('first'); throw new Error('failed'); });
  const next = gitAdmin(path.join(checkout, '.', 'config', '..'), async () => { order.push('second'); });
  await assert.rejects(slow, /failed/);
  await next;
  assert.deepEqual(order, ['first', 'second']);
});
