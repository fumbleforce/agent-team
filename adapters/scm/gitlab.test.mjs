import test from 'node:test';
import assert from 'node:assert/strict';
import * as gitlab from './gitlab.mjs';
import { scmAdapter, SCM_KINDS, linkText } from './index.mjs';

const sha = 'a'.repeat(40);
const url = 'https://gitlab.com/group/sub/project/-/merge_requests/42';
const context = { url, repository: 'group/sub/project', cwd: '/tmp', env: {}, signal: undefined };

// A fake `glab api` that answers by route and records every call.
function fakeExec(routes) {
  const calls = [];
  const exec = async (bin, args) => {
    assert.equal(bin, 'glab');
    const [, , method, route, ...rest] = args.slice(args.indexOf('api'));
    calls.push({ method, route, fields: rest.filter(value => value !== '-f') });
    const answer = routes[`${method} ${route}`];
    if (answer === undefined) throw new Error(`Unexpected route ${method} ${route}`);
    return JSON.stringify(typeof answer === 'function' ? answer() : answer);
  };
  return { exec, calls };
}

test('repository names, merge request URLs and link text follow GitLab conventions including nested groups', () => {
  assert.ok(gitlab.validateRepository('group/sub/project'));
  for (const bad of ['single', 'group/../x', 'https://gitlab.com/g/p', 'group//p']) assert.equal(gitlab.validateRepository(bad), false);
  assert.deepEqual(gitlab.parseChangeUrl(url), { repository: 'group/sub/project', number: 42 });
  assert.equal(gitlab.parseChangeUrl('https://gitlab.com/g/p/merge_requests/1'), null);
  assert.equal(gitlab.linkText(url), '!42');
  assert.equal(linkText(url), '!42', 'the index picks the adapter from the URL shape');
  assert.equal(linkText('https://github.com/o/r/pull/7'), '#7');
  assert.match(gitlab.publishInstructions({ repository: 'g/p', baseBranch: 'main', branch: 'agents/x' }), /glab mr create --draft --target-branch main/);
  assert.deepEqual(gitlab.MERGE_DENIALS, ['glab mr merge', 'glab mr approve']);
  assert.ok(SCM_KINDS.includes('gitlab')); assert.equal(scmAdapter('gitlab').CHANGE_NOUN, 'merge request');
  assert.throws(() => scmAdapter('svn'), /Unknown scm kind/);
});

test('view, checks and merge use the REST passthrough with the head sha pinned', async () => {
  const mr = { web_url: url, state: 'opened', draft: false, target_branch: 'main', source_branch: 'agents/x', sha, project_id: 7, source_project_id: 7, target_project_id: 7, detailed_merge_status: 'mergeable', head_pipeline: { id: 99, status: 'success' } };
  const encoded = encodeURIComponent('group/sub/project');
  const { exec, calls } = fakeExec({
    [`GET projects/${encoded}/merge_requests/42`]: mr,
    [`GET projects/${encoded}/pipelines/99/jobs?per_page=100&include_retried=false`]: [{ name: 'test', status: 'success' }, { name: 'humbugbot', status: 'failed', allow_failure: false }, { name: 'lint', status: 'skipped', allow_failure: true }],
    [`GET projects/${encoded}`]: { only_allow_merge_if_pipeline_succeeds: true },
    [`PUT projects/${encoded}/merge_requests/42/merge`]: {},
  });
  const view = await gitlab.view(exec, context);
  assert.deepEqual([view.state, view.headSha, view.baseRef, view.headRef, view.sameRepository, view.mergeable, view.mergeCommit, view.pipelineId], ['OPEN', sha, 'main', 'agents/x', true, true, null, 99]);
  const status = await gitlab.checks(exec, context, { includeProtected: true });
  assert.deepEqual(status.all, [{ name: 'test', passed: true }, { name: 'humbugbot', passed: false }, { name: 'lint', passed: true }]);
  assert.deepEqual(status.protected, [{ name: 'pipeline', passed: true }]);
  assert.deepEqual((await gitlab.checks(exec, context, { includeProtected: false })).protected, null);
  await gitlab.merge(exec, context, sha);
  const merge = calls.at(-1);
  assert.equal(merge.method, 'PUT');
  assert.deepEqual(merge.fields, [`sha=${sha}`, 'squash=true', 'should_remove_source_branch=true']);
  const forked = await gitlab.view(async () => JSON.stringify({ ...mr, source_project_id: 8, state: 'merged', squash_commit_sha: 'b'.repeat(40) }), context);
  assert.equal(forked.sameRepository, false); assert.equal(forked.state, 'MERGED'); assert.equal(forked.mergeCommit, 'b'.repeat(40));
  await assert.rejects(gitlab.checks(async () => JSON.stringify({ ...mr, head_pipeline: null }), context, { includeProtected: false }), /no head pipeline/);
});
