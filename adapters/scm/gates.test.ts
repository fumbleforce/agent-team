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
      [/pr checks/, [{ name: 'verify', bucket: 'pass' }, { name: 'lint', bucket: 'fail' }]],
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
    assert.deepEqual(checks.all.find(check => check.name === 'verify'), { name: 'verify', passed: true });
    assert.deepEqual(checks.all.find(check => check.name === 'lint'), { name: 'lint', passed: false });
    assert.ok(Array.isArray(checks.protected) && checks.protected.every(check => check.passed));
    assert.equal((await gate.checks(exec, context, { includeProtected: false })).protected, null);
    await gate.merge(exec, context, HEAD);
    assert.ok(calls.at(-1)!.includes(HEAD) && /squash/.test(calls.at(-1)!));
    const after = await gate.view(exec, context);
    assert.deepEqual([after.state, after.mergeCommit], ['MERGED', MERGE]);
  });
}
