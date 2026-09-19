import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deliver, validateApprovals, type Approvals, type Change, type ScmGate } from './gate.ts';

const PR = 'https://example.test/acme/app/pull/7';
const config = { repository: 'acme/app', baseBranch: 'main', requiredChecks: ['verify'], autoMergeAuthorized: true };

function worktree() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'agent-team-gate-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  execFileSync('git', ['init', '-q', '-b', 'agents/gh-7', root]);
  git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T');
  writeFileSync(path.join(root, 'a.txt'), 'a'); git('add', '-A'); git('commit', '-q', '-m', 'work');
  return { root, head: git('rev-parse', 'HEAD').trim() };
}

function scm(head: string, overrides: Partial<{ change: Partial<Change>; checks: { name: string; passed: boolean }[]; protectedChecks: { name: string; passed: boolean }[] | null }> = {}) {
  const state = { merged: false, merges: 0 };
  const gate: ScmGate = {
    name: 'fake', changeNoun: 'PR',
    parseChangeUrl: url => (url === PR ? { repository: 'acme/app' } : null),
    view: async () => ({ url: PR, state: state.merged ? 'MERGED' : 'OPEN', isDraft: false, baseRef: 'main', headRef: 'agents/gh-7', headSha: head, sameRepository: true, mergeable: true, mergeCommit: state.merged ? 'c'.repeat(40) : null, ...overrides.change }),
    checks: async () => ({ all: overrides.checks ?? [{ name: 'verify', passed: true }], protected: overrides.protectedChecks === undefined ? [] : overrides.protectedChecks }),
    merge: async () => { state.merges++; state.merged = true; },
  };
  return { gate, state };
}
const approved = (head: string): Approvals => ({ tester: { verdict: 'PASS', headSha: head, sessionId: 's1' }, reviewer: { verdict: 'APPROVE', headSha: head, sessionId: 's2' }, pm: { verdict: 'APPROVE', headSha: head, sessionId: 's3' } });

test('approvals must be passing, at the head, and from distinct sessions', () => {
  const head = 'a'.repeat(40);
  validateApprovals(approved(head), head, ['tester', 'reviewer', 'pm']);
  assert.throws(() => validateApprovals({ ...approved(head), pm: { verdict: 'APPROVE', headSha: head, sessionId: 's1' } }, head, ['tester', 'reviewer', 'pm']), /pm approval/);
  assert.throws(() => validateApprovals({ ...approved(head), tester: { verdict: 'PASS', headSha: 'b'.repeat(40), sessionId: 's1' } }, head, ['tester']), /tester approval/);
  assert.throws(() => validateApprovals({}, head, ['reviewer']), /reviewer approval/);
});

test('a clean, approved, passing change merges exactly once and is confirmed', async () => {
  const { root, head } = worktree();
  const { gate, state } = scm(head);
  const result = await deliver({ config, scm: gate, prUrl: PR, approvals: async () => approved(head), worktree: root, branch: 'agents/gh-7' });
  assert.deepEqual([result.state, result.mergeAttempted, state.merges, result.mergeCommit], ['merged', true, 1, 'c'.repeat(40)]);
});

test('an approval withdrawn between the two reads stops the merge', async () => {
  const { root, head } = worktree();
  const { gate, state } = scm(head);
  let reads = 0;
  const result = await deliver({ config, scm: gate, prUrl: PR, approvals: async () => { const all = approved(head); if (++reads > 1) delete all.reviewer; return all; }, worktree: root, branch: 'agents/gh-7' });
  assert.deepEqual([result.state, result.mergeAttempted, state.merges], ['blocked', false, 0]);
  assert.match(result.reason, /reviewer approval/);
});

test('every gate blocks without merging', async () => {
  const { root, head } = worktree();
  const attempt = async (overrides: Parameters<typeof scm>[1], extra: Partial<Parameters<typeof deliver>[0]> = {}) => {
    const { gate, state } = scm(head, overrides);
    const result = await deliver({ config, scm: gate, prUrl: PR, approvals: async () => approved(head), worktree: root, branch: 'agents/gh-7', ...extra });
    assert.equal(state.merges, 0, result.reason);
    return result.reason;
  };
  assert.match(await attempt({ checks: [{ name: 'verify', passed: false }] }), /checks/);
  assert.match(await attempt({ checks: [] }), /checks/);
  assert.match(await attempt({ protectedChecks: null }), /checks/);
  assert.match(await attempt({ protectedChecks: [{ name: 'other', passed: false }] }), /checks/);
  assert.match(await attempt({ change: { isDraft: true } }), /gate failed/);
  assert.match(await attempt({ change: { headSha: 'd'.repeat(40) } }), /gate failed/);
  assert.match(await attempt({ change: { baseRef: 'release' } }), /gate failed/);
  assert.match(await attempt({}, { prUrl: 'https://example.test/other/repo/pull/1' }), /configured repository/);
  assert.match(await attempt({}, { branch: 'agents/other' }), /branch mismatch/);
  assert.match(await attempt({}, { config: { ...config, autoMergeAuthorized: false } }), /autoMergeAuthorized/);
  writeFileSync(path.join(root, 'stray.txt'), 'x');
  assert.match(await attempt({}), /Uncommitted work: stray\.txt/);
});

test('an unconfirmed merge is reported as attempted and blocked', async () => {
  const { root, head } = worktree();
  const { gate } = scm(head);
  gate.merge = async () => {};
  const result = await deliver({ config, scm: gate, prUrl: PR, approvals: async () => approved(head), worktree: root, branch: 'agents/gh-7' });
  assert.deepEqual([result.state, result.mergeAttempted], ['blocked', true]);
});
