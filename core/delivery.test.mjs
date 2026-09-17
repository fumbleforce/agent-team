import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deliver, deliveryExec, validateDelivery, verifyWorktree } from './delivery.mjs';

const head = 'a'.repeat(40), other = 'b'.repeat(40);
const config = { repository: 'fumbleforce/stockapp', baseBranch: 'master', requiredChecks: ['Agent verification'], autoMergeAuthorized: true };
const prUrl = 'https://github.com/fumbleforce/stockapp/pull/42';
const approvals = () => Object.fromEntries(['tester', 'reviewer', 'pm'].map(role => [role,
  { verdict: role === 'tester' ? 'PASS' : 'APPROVE', headSha: head, sessionId: role }]));

function fixture() {
  const f = { calls: [], views: 0, locals: 0, checks: [{ name: 'Agent verification', bucket: 'pass', state: 'SUCCESS' }],
    required: [], pr: { url: prUrl, state: 'OPEN', isDraft: false, baseRefName: 'master', headRefName: 'agents/test',
      headRefOid: head, headRepository: { name: 'stockapp' }, headRepositoryOwner: { login: 'fumbleforce' },
      isCrossRepository: false, mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE' } };
  f.options = { config, prUrl, approvals: approvals(), worktree: '/synthetic', branch: 'agents/test', exec: async (bin, args) => {
    f.calls.push([bin, ...args]);
    if (bin === 'git') {
      if (args[2] === 'rev-parse') { f.locals++; return f.locals > 1 && f.changedLocal ? other : head; }
      if (args[2] === 'branch') return 'agents/test';
      if (args[2] === 'status') return f.dirty || '';
      if (args[2] === 'ls-files') return f.hidden || '';
      if (args[2] === 'diff') return f.staged || '';
      throw new Error('Unexpected git command');
    }
    if (args[1] === 'view') {
      f.views++;
      return JSON.stringify(f.merged ? { ...f.pr, state: f.notMerged ? 'OPEN' : 'MERGED', mergeCommit: f.noCommit ? null : { oid: other } }
        : { ...f.pr, headRefOid: f.views > 1 && f.changedRemote ? other : f.pr.headRefOid });
    }
    if (args[1] === 'checks') {
      f.onChecks?.();
      if (args.includes('--required') && f.requiredError) throw new Error(f.requiredError);
      return JSON.stringify(args.includes('--required') ? f.required : f.checks);
    }
    if (args[1] === 'merge') {
      if (f.refusal) throw new Error('GitHub branch protection refused merge');
      f.merged = true;
      return '';
    }
    throw new Error('Unexpected gh command');
  } };
  return f;
}

test('delivery configuration is optional except for authorized auto-merge', () => {
  assert.equal(validateDelivery(undefined), undefined);
  assert.doesNotThrow(() => validateDelivery({ repository: config.repository, baseBranch: 'master' }));
  for (const value of [undefined, { ...config, autoMergeAuthorized: false }, { ...config, requiredChecks: [] }]) {
    assert.throws(() => validateDelivery(value, true));
  }
  for (const change of [{ repository: 'https://github.com/o/r' }, { repository: '../repo' }, { repository: 'owner/..' },
    { baseBranch: '../master' }, { baseBranch: 'x.lock' }, { checkEnforcement: 'fallback' }, { checkEnforcement: null },
    { requiredChecks: [''] }, { requiredChecks: ['a', 'a'] }, { autoMergeAuthorized: 'true' }, { unknown: true }]) {
    assert.throws(() => validateDelivery({ ...config, ...change }));
  }
});

test('valid delivery merges once pinned to head and verifies actual merge commit', async () => {
  const f = fixture();
  const result = await deliver(f.options);
  assert.equal(result.state, 'merged');
  assert.equal(result.checkEnforcement, 'protected');
  assert.match(result.checkSource, /protected-branch checks/);
  assert.equal(result.commitUrl, `https://github.com/fumbleforce/stockapp/commit/${other}`);
  assert.deepEqual(f.calls.filter(call => call[2] === 'merge'), [
    ['gh', 'pr', 'merge', prUrl, '--repo', config.repository, '--squash', '--match-head-commit', head],
  ]);
  assert.equal(f.views, 3);
  assert.equal(f.locals, 2);
  assert.equal(f.calls.filter(call => call[2] === 'checks').length, 4);
});

test('explicit runner enforcement skips protected-context lookup and journals its source', async () => {
  const f = fixture();
  f.options.config = { ...config, checkEnforcement: 'runner' };
  f.requiredError = '403 Upgrade to GitHub Pro or make repository public';
  const result = await deliver(f.options);
  assert.equal(result.state, 'merged');
  assert.equal(result.checkEnforcement, 'runner');
  assert.equal(result.checkSource, 'Configured requiredChecks enforced by runner');
  assert.ok(!f.calls.some(call => call.includes('--required')));
  assert.equal(f.calls.filter(call => call[2] === 'checks').length, 2);
  assert.equal(f.locals, 2);
  assert.equal(f.views, 3);
  assert.deepEqual(f.calls.filter(call => call[2] === 'merge'), [
    ['gh', 'pr', 'merge', prUrl, '--repo', config.repository, '--squash', '--match-head-commit', head],
  ]);
});

test('default and legacy github-required enforcement normalize to protected and never fall back on lookup failures', async () => {
  for (const mode of [undefined, 'github-required']) {
    for (const message of ['403 Upgrade to GitHub Pro or make repository public', 'no required checks reported']) {
      const f = fixture();
      f.options.config = { ...config, ...(mode ? { checkEnforcement: mode } : {}) };
      f.requiredError = message;
      const result = await deliver(f.options);
      assert.equal(result.state, 'blocked');
      assert.equal(result.reason, message);
      assert.equal(result.checkEnforcement, 'protected');
      assert.ok(f.calls.some(call => call.includes('--required')));
      assert.ok(!f.merged);
    }
  }
});

test('runner enforcement retains explicit checks, approvals, identity and fresh-head gates', async () => {
  for (const failure of ['empty', 'missing', 'fail', 'pending', 'skipping', 'approval', 'repo', 'base', 'branch', 'sha', 'fresh-local', 'fresh-remote']) {
    const f = fixture();
    f.options.config = { ...config, checkEnforcement: 'runner' };
    if (failure === 'empty') f.options.config.requiredChecks = [];
    if (failure === 'missing') f.checks = [];
    if (['fail', 'pending', 'skipping'].includes(failure)) f.checks = [{ name: 'Agent verification', bucket: failure }];
    if (failure === 'approval') f.options.approvals.pm.headSha = other;
    if (failure === 'repo') f.pr.isCrossRepository = true;
    if (failure === 'base') f.pr.baseRefName = 'other';
    if (failure === 'branch') f.pr.headRefName = 'other';
    if (failure === 'sha') f.pr.headRefOid = other;
    if (failure === 'fresh-local') f.changedLocal = true;
    if (failure === 'fresh-remote') f.changedRemote = true;
    const result = await deliver(f.options);
    assert.equal(result.state, 'blocked', failure);
    assert.equal(result.checkEnforcement, 'runner');
    assert.ok(!f.merged, failure);
    assert.ok(!f.calls.some(call => call.includes('--required')));
  }
});

for (const bucket of ['fail', 'pending', 'skipping', 'cancel', 'missing']) {
  test(`${bucket} configured check blocks without merging`, async () => {
    const f = fixture();
    f.checks = bucket === 'missing' ? [] : [{ name: 'Agent verification', bucket, state: 'IGNORED' }];
    assert.equal((await deliver(f.options)).state, 'blocked');
    assert.ok(!f.calls.some(call => call[2] === 'merge'));
  });
}

test('GitHub required checks and duplicate configured names must all pass', async () => {
  for (const kind of ['required', 'duplicate']) {
    const f = fixture();
    const bad = { name: 'Agent verification', bucket: 'pending', state: 'PENDING' };
    if (kind === 'required') f.required = [bad];
    else f.checks.push(bad);
    assert.equal((await deliver(f.options)).state, 'blocked');
    assert.ok(!f.merged);
  }
});

for (const mutation of ['missing', 'same-session', 'stale', 'bad-verdict', 'missing-pm']) {
  test(`${mutation} approvals block without merging`, async () => {
    const f = fixture();
    if (mutation === 'missing') delete f.options.approvals;
    if (mutation === 'same-session') f.options.approvals.pm.sessionId = 'reviewer';
    if (mutation === 'stale') f.options.approvals.tester.headSha = other;
    if (mutation === 'bad-verdict') f.options.approvals.reviewer.verdict = 'PASS';
    if (mutation === 'missing-pm') delete f.options.approvals.pm;
    assert.equal((await deliver(f.options)).state, 'blocked');
    assert.ok(!f.merged);
  });
}

for (const [name, change] of Object.entries({ repository: { url: 'https://github.com/other/repo/pull/42' },
  fork: { isCrossRepository: true }, owner: { headRepositoryOwner: { login: 'other' } },
  headRepo: { headRepository: { name: 'other' } }, base: { baseRefName: 'main' }, branch: { headRefName: 'agents/other' },
  sha: { headRefOid: other }, closed: { state: 'CLOSED' }, draft: { isDraft: true },
  blocked: { mergeStateStatus: 'BLOCKED' }, unknown: { mergeable: 'UNKNOWN' } })) {
  test(`wrong PR ${name} blocks`, async () => {
    const f = fixture(); Object.assign(f.pr, change);
    assert.equal((await deliver(f.options)).state, 'blocked');
    assert.ok(!f.merged);
  });
}

test('wrong URL, changed heads and dirty work never merge', async () => {
  for (const field of ['url', 'changedRemote', 'changedLocal', 'dirty', 'staged', 'hidden']) {
    const f = fixture();
    if (field === 'url') f.options.prUrl = 'https://github.com/other/repo/pull/42';
    else if (field === 'dirty') f.dirty = ' M source.ts\0';
    else if (field === 'staged') f.staged = 'source.ts\0';
    else if (field === 'hidden') f.hidden = 'h source.ts\0';
    else f[field] = true;
    const result = await deliver(f.options);
    assert.equal(result.state, 'blocked', field);
    assert.equal(result.prUrl, f.options.prUrl);
    assert.match(result.recovery, /do not reselect/);
    assert.ok(!f.merged, field);
  }
});

test('GitHub refusal, queued merge and missing merge commit are not success or retried', async () => {
  for (const field of ['refusal', 'notMerged', 'noCommit']) {
    const f = fixture(); f[field] = true;
    const result = await deliver(f.options);
    assert.equal(result.state, 'blocked');
    assert.equal(result.mergeAttempted, true);
    assert.equal(f.calls.filter(call => call[2] === 'merge').length, 1);
  }
});

test('abort before start or during checks never mutates', async () => {
  for (const before of [true, false]) {
    const f = fixture(), controller = new AbortController();
    f.options.signal = controller.signal;
    if (before) controller.abort('test');
    else f.onChecks = () => controller.abort('test');
    assert.equal((await deliver(f.options)).state, 'blocked');
    assert.ok(!f.merged);
    if (before) assert.deepEqual(f.calls, []);
  }
});

test('real git inspection allows ignored artifacts and exact overlays but blocks uncommitted source', async t => {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-test-'));
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  const git = (...args) => deliveryExec('git', args, { cwd: worktree });
  await git('init', '-q', '-b', 'agents/test');
  fs.writeFileSync(path.join(worktree, '.gitignore'), '.agent-team-result.json\nnode_modules/\nbuild/\n');
  fs.writeFileSync(path.join(worktree, 'source.ts'), 'base');
  await git('add', '.gitignore', 'source.ts');
  await git('-c', 'user.name=Synthetic', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture');
  fs.writeFileSync(path.join(worktree, 'AGENTS.md'), 'setup');
  fs.writeFileSync(path.join(worktree, '.agent-team-result.json'), '{}');
  for (const directory of ['node_modules', 'build']) {
    fs.mkdirSync(path.join(worktree, directory));
    fs.writeFileSync(path.join(worktree, directory, 'generated.js'), 'synthetic generated artifact');
  }
  const options = { worktree, branch: 'agents/test', overlays: { 'AGENTS.md': 'setup' }, exec: deliveryExec };
  assert.match(await verifyWorktree(options), /^[a-f0-9]{40}$/);
  fs.writeFileSync(path.join(worktree, 'untracked.ts'), 'unpublished issue work');
  await assert.rejects(verifyWorktree(options), /untracked.ts/);
  fs.unlinkSync(path.join(worktree, 'untracked.ts'));
  fs.writeFileSync(path.join(worktree, 'source.ts'), 'modified issue work');
  await assert.rejects(verifyWorktree(options), /source.ts/);
  await git('add', 'source.ts');
  await assert.rejects(verifyWorktree(options), /Uncommitted staged issue changes/);
  await git('restore', '--staged', 'source.ts');
  fs.writeFileSync(path.join(worktree, 'source.ts'), 'base');
  assert.match(await verifyWorktree(options), /^[a-f0-9]{40}$/);
  fs.writeFileSync(path.join(worktree, 'AGENTS.md'), 'modified setup');
  await assert.rejects(verifyWorktree(options), /AGENTS.md/);
});
