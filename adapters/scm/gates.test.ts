import test from 'node:test';
import assert from 'node:assert/strict';
import type { Exec } from '../../packages/worker/src/deliver/gate.ts';
import { SCM_GATES } from './gates.ts';

const HEAD = 'a'.repeat(40), MERGE = 'c'.repeat(40);

// Recorded answers of each host's CLI, keyed by the part of the command that identifies the call.
const HOSTS = {
  github: {
    url: 'https://github.com/acme/app/pull/7', repository: 'acme/app',
    answers: (merged: boolean): [RegExp, unknown][] => [
      [/pr checks .* --required/, [{ name: 'verify', bucket: 'pass' }]],
      // The change's own roll-up, as the host's CLI prints it: a finished run, a failed one, and one still going.
      [/pr view .*statusCheckRollup/, { statusCheckRollup: [{ __typename: 'CheckRun', name: 'verify', status: 'COMPLETED', conclusion: 'SUCCESS' }, { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' }, { __typename: 'CheckRun', name: 'e2e', status: 'IN_PROGRESS', conclusion: '' }] }],
      [/pr view/, { url: 'https://github.com/acme/app/pull/7', state: merged ? 'MERGED' : 'OPEN', isDraft: false, baseRefName: 'main', headRefName: 'agents/gh-7', headRefOid: HEAD, isCrossRepository: false, headRepository: { name: 'app' }, headRepositoryOwner: { login: 'acme' }, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', mergeCommit: merged ? { oid: MERGE } : null }],
    ],
  },
  gitlab: {
    url: 'https://gitlab.com/acme/group/app/-/merge_requests/7', repository: 'acme/group/app',
    answers: (merged: boolean): [RegExp, unknown][] => [
      [/pipelines\/55\/jobs/, [{ name: 'verify', status: 'success' }, { name: 'lint', status: 'failed', allow_failure: false }]],
      [/merge_requests\/7$/, { web_url: 'https://gitlab.com/acme/group/app/-/merge_requests/7', state: merged ? 'merged' : 'opened', draft: false, target_branch: 'main', source_branch: 'agents/gh-7', sha: HEAD, source_project_id: 1, target_project_id: 1, project_id: 1, detailed_merge_status: 'mergeable', squash_commit_sha: merged ? MERGE : null, head_pipeline: { id: 55, status: 'success' } }],
      [/projects\/acme%2Fgroup%2Fapp$/, { only_allow_merge_if_pipeline_succeeds: true }],
    ],
  },
} as const;

// Both hosts pass the same contract.
for (const [name, host] of Object.entries(HOSTS)) {
  const gate = SCM_GATES[name]!;
  const calls: string[] = [];
  let merged = false;
  const exec: Exec = async (bin, args) => {
    const command = `${bin} ${args.join(' ')}`;
    calls.push(command);
    if (/ merge |-X PUT/.test(command)) { merged = true; return '{}'; }
    const answer = host.answers(merged).find(([pattern]) => pattern.test(command));
    if (!answer) throw new Error(`Unexpected command: ${command}`);
    return JSON.stringify(answer[1]);
  };
  const context = { url: host.url, repository: host.repository, cwd: '.' };

  test(`${name}: recognizes its own change URLs only`, () => {
    assert.deepEqual(gate.parseChangeUrl(host.url), { repository: host.repository });
    assert.equal(gate.parseChangeUrl('https://example.test/not/a/change'), null);
  });

  test(`${name}: view, checks and merge normalize to one shape`, async () => {
    const change = await gate.view(exec, context);
    assert.deepEqual([change.state, change.isDraft, change.baseRef, change.headRef, change.headSha, change.sameRepository, change.mergeable, change.mergeCommit], ['OPEN', false, 'main', 'agents/gh-7', HEAD, true, true, null]);
    const checks = await gate.checks(exec, context, { includeProtected: true });
    const seen = (check: string) => { const found = checks.all.find(item => item.name === check); return found ? [found.passed, found.pending ?? false] : null; };
    assert.deepEqual([seen('verify'), seen('lint')], [[true, false], [false, false]]);
    // A check that still runs is told apart from one that failed, where the host says so.
    if (name === 'github') assert.deepEqual(seen('e2e'), [false, true]);
    assert.ok(Array.isArray(checks.protected) && checks.protected.every(check => check.passed));
    assert.equal((await gate.checks(exec, context, { includeProtected: false })).protected, null);
    await gate.merge(exec, context, HEAD);
    assert.ok(calls.at(-1)!.includes(HEAD) && /squash/.test(calls.at(-1)!));
    const after = await gate.view(exec, context);
    assert.deepEqual([after.state, after.mergeCommit], ['MERGED', MERGE]);
  });
}

test('gitlab: forks are not the same repository, allowed failures pass, and a missing head pipeline fails closed', async () => {
  const gate = SCM_GATES.gitlab!, host = HOSTS.gitlab;
  const context = { url: host.url, repository: host.repository, cwd: '.' };
  const mr = host.answers(false)[1]![1] as Record<string, unknown>;
  const answer = (change: unknown, jobs: unknown): Exec => async (_bin, args) => JSON.stringify(/jobs/.test(args.join(' ')) ? jobs : change);
  assert.equal((await gate.view(answer({ ...mr, source_project_id: 2 }, []), context)).sameRepository, false);
  const checks = await gate.checks(answer(mr, [{ name: 'lint', status: 'skipped', allow_failure: true }, { name: 'flaky', status: 'failed', allow_failure: true }, { name: 'docs', status: 'skipped' }]), context, { includeProtected: false });
  assert.deepEqual(checks.all.map(check => check.passed), [true, true, false]);
  await assert.rejects(gate.checks(answer({ ...mr, head_pipeline: null }, []), context, { includeProtected: false }), /no head pipeline/);
  await assert.rejects(gate.view(answer(mr, []), { ...context, url: 'https://gitlab.com/g/p/merge_requests/1' }), /Not a merge request URL/);
});
