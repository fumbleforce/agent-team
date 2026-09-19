import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { changedPaths, ensureWorktree, isSensitivePath, sparsePatterns } from './worktree.ts';

function repository(): string {
  const root = path.join(mkdtempSync(path.join(os.tmpdir(), 'agent-team-wt-')), 'project');
  mkdirSync(path.join(root, 'config'), { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T');
  for (const [file, body] of [['src.ts', 'code'], ['.env', 'SECRET=1'], ['.env.example', 'SECRET='], ['config/prod.sqlite', 'db'], ['config/id_rsa', 'key']] as const) writeFileSync(path.join(root, file), body);
  git('add', '-A', '-f'); git('commit', '-q', '-m', 'init');
  return root;
}

test('sensitive paths are recognized; templates are not', () => {
  for (const file of ['.env', 'apps/web/.env.local', 'prod.env', '.secrets/x', 'data/app.sqlite-wal', 'keys/id_ed25519', 'cert.pem']) assert.equal(isSensitivePath(file), true, file);
  for (const file of ['.env.example', 'src/environment.ts', 'docs/database.md', 'config/sample.env']) assert.equal(isSensitivePath(file), false, file);
  assert.equal(sparsePatterns(['a b/.env']), '/*\n!/a b/.env\n');
  assert.throws(() => sparsePatterns(['bad\nname']));
});

test('a task worktree excludes secrets, is reused, and reports changed paths', async () => {
  const checkout = repository();
  const first = await ensureWorktree({ checkout, taskKey: 'CK-31', branchPrefix: 'agents/', base: 'HEAD' });
  assert.equal(first.created, true);
  assert.equal(first.branch, 'agents/ck-31');
  assert.deepEqual(first.excluded.sort(), ['.env', 'config/id_rsa', 'config/prod.sqlite']);
  assert.ok(existsSync(path.join(first.path, 'src.ts')) && existsSync(path.join(first.path, '.env.example')));
  assert.ok(!existsSync(path.join(first.path, '.env')) && !existsSync(path.join(first.path, 'config/id_rsa')));
  assert.ok(!first.path.startsWith(checkout + path.sep));

  writeFileSync(path.join(first.path, 'new.ts'), 'x');
  const again = await ensureWorktree({ checkout, taskKey: 'CK-31', branchPrefix: 'agents/', base: 'HEAD' });
  assert.equal(again.created, false);
  assert.deepEqual(await changedPaths(again.path, again.baseCommit), ['new.ts']);
});
