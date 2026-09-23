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
  const state = { merged: false, merges: 0, readied: 0, draft: overrides.change?.isDraft === true };
  const gate: ScmGate = {
    name: 'fake', changeNoun: 'PR',
    parseChangeUrl: url => (url === PR ? { repository: 'acme/app' } : null),
    view: async () => ({ url: PR, state: state.merged ? 'MERGED' : 'OPEN', isDraft: false, baseRef: 'main', headRef: 'agents/gh-7', headSha: head, sameRepository: true, mergeable: true, mergeCommit: state.merged ? 'c'.repeat(40) : null, ...overrides.change, ...(overrides.change?.isDraft === true ? { isDraft: state.draft } : {}) }),
    ready: async () => { state.readied++; state.draft = false; },
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

test('the gate asks for the one reviewer approval by default; the roles it is given change what it asks for', async () => {
  const { root, head } = worktree();
  const { reviewer, ...standIns } = approved(head), only: Approvals = { reviewer: reviewer! };
  const alone = scm(head);
  const result = await deliver({ config, scm: alone.gate, prUrl: PR, approvals: async () => only, worktree: root, branch: 'agents/gh-7' });
  assert.deepEqual([result.state, alone.state.merges], ['merged', 1]);
  const without = scm(head);
  const refused = await deliver({ config, scm: without.gate, prUrl: PR, approvals: async () => standIns, worktree: root, branch: 'agents/gh-7' });
  assert.deepEqual([refused.state, without.state.merges], ['blocked', 0]);
  const named = scm(head);
  const held = await deliver({ config, scm: named.gate, prUrl: PR, approvals: async () => only, approvalRoles: ['reviewer', 'pm'], worktree: root, branch: 'agents/gh-7' });
  assert.deepEqual([held.state, named.state.merges], ['blocked', 0]);
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
  // An approved draft is marked ready by the gate (next test); a draft on another branch is not the approved change and blocks.
  assert.match(await attempt({ change: { isDraft: true, headRef: 'agents/other' } }), /gate failed/);
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

test('an approved draft is marked ready and merged; a draft that is not the approved change is left alone', async () => {
  const { root, head } = worktree();
  const draft = scm(head, { change: { isDraft: true } });
  const merged = await deliver({ config, scm: draft.gate, prUrl: PR, approvals: async () => approved(head), worktree: root, branch: 'agents/gh-7' });
  assert.deepEqual([merged.state, draft.state.readied, draft.state.merges], ['merged', 1, 1]);

  // Without the approvals nothing is touched, not even the draft flag.
  const unapproved = scm(head, { change: { isDraft: true } });
  const refused = await deliver({ config, scm: unapproved.gate, prUrl: PR, approvals: async () => ({}), worktree: root, branch: 'agents/gh-7' });
  assert.deepEqual([refused.state, unapproved.state.readied, unapproved.state.merges], ['blocked', 0, 0]);

  // A draft at another head, or from a fork, is not the change that was approved.
  for (const change of [{ isDraft: true, headSha: 'b'.repeat(40) }, { isDraft: true, sameRepository: false }]) {
    const other = scm(head, { change });
    const result = await deliver({ config, scm: other.gate, prUrl: PR, approvals: async () => approved(head), worktree: root, branch: 'agents/gh-7' });
    assert.deepEqual([result.state, other.state.readied, other.state.merges], ['blocked', 0, 0]);
  }
});

test('run again after a merge that was cut off, the gate finds it already merged and merges nothing a second time; a different change that is merged is not taken for it', async () => {
  const { root, head } = worktree();
  const { gate, state } = scm(head);
  state.merged = true;
  const again = await deliver({ config, scm: gate, prUrl: PR, approvals: async () => approved(head), worktree: root, branch: 'agents/gh-7' });
  assert.deepEqual([again.state, again.mergeAttempted, state.merges, again.mergeCommit], ['merged', false, 0, 'c'.repeat(40)]);
  // Merged at another head than the one that was approved: that is not this delivery.
  const other = scm(head, { change: { headSha: 'd'.repeat(40) } });
  other.state.merged = true;
  const refused = await deliver({ config, scm: other.gate, prUrl: PR, approvals: async () => approved(head), worktree: root, branch: 'agents/gh-7' });
  assert.deepEqual([refused.state, other.state.merges], ['blocked', 0]);
});

test('a required check that has not finished is a reason to come back, not a refusal; one that failed is a refusal whatever else still runs', async () => {
  const { root, head } = worktree();
  const running = scm(head, { checks: [{ name: 'verify', passed: false, pending: true } as { name: string; passed: boolean }] });
  const waiting = await deliver({ config, scm: running.gate, prUrl: PR, approvals: async () => approved(head), worktree: root, branch: 'agents/gh-7' });
  assert.deepEqual([waiting.state, waiting.waiting, waiting.reason, running.state.merges], ['blocked', true, 'Waiting for verify to finish', 0]);
  const failed = scm(head, { checks: [{ name: 'verify', passed: false }, { name: 'lint', passed: false, pending: true } as { name: string; passed: boolean }] });
  const refused = await deliver({ config, scm: failed.gate, prUrl: PR, approvals: async () => approved(head), worktree: root, branch: 'agents/gh-7' });
  assert.deepEqual([refused.state, refused.waiting, failed.state.merges], ['blocked', undefined, 0]);
});

test('a host calls a change "not clean" while its checks run: that is a wait, never a conflict; a real conflict is named as one, for the author', async () => {
  const { root, head } = worktree();
  // Just brought up to date and pushed: checks running, so the host reports it as not mergeable yet.
  const fresh = scm(head, { change: { mergeable: false }, checks: [{ name: 'verify', passed: false, pending: true } as { name: string; passed: boolean }] });
  const waiting = await deliver({ config, scm: fresh.gate, prUrl: PR, approvals: async () => approved(head), worktree: root, branch: 'agents/gh-7' });
  assert.deepEqual([waiting.waiting, waiting.reason, fresh.state.merges], [true, 'Waiting for verify to finish', 0]);
  // The host has not worked out yet whether it merges.
  const undecided = scm(head, { change: { mergeable: false, undecided: true } });
  assert.equal((await deliver({ config, scm: undecided.gate, prUrl: PR, approvals: async () => approved(head), worktree: root, branch: 'agents/gh-7' })).waiting, true);
  // It really collides with the base.
  const collides = scm(head, { change: { mergeable: false, conflicting: true } });
  const refused = await deliver({ config, scm: collides.gate, prUrl: PR, approvals: async () => approved(head), worktree: root, branch: 'agents/gh-7' });
  assert.deepEqual([refused.state, refused.waiting, refused.reason, collides.state.merges], ['blocked', undefined, 'PR conflicts with the base branch', 0]);
});
