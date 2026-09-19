import test from 'node:test';
import assert from 'node:assert/strict';
import { PUBLISH_KINDS } from './publish.ts';
import { SCM_GATES } from './gates.ts';
import { DEFAULT_SCM, SCM_KINDS, linkText, scmAdapter } from './index.ts';

const SHA = 'a'.repeat(40);
const HOSTS = {
  github: { change: 'https://github.com/o/r/pull/7', text: '#7', other: 'https://github.com/o/r/issues/7', otherText: 'o/r/issues/7', commit: `https://github.com/o/r/commit/${SHA}`, repository: 'o/r',
    bad: ['single', 'o/..', 'https://github.com/o/r', '-o/r', 'a/b/c'], denials: ['gh pr merge'], cli: 'gh', token: 'GH_TOKEN', noun: 'pull request', abbreviation: 'PR' },
  gitlab: { change: 'https://gitlab.com/group/sub/project/-/merge_requests/42', text: '!42', other: 'https://gitlab.com/g/p/merge_requests/1', otherText: 'g/p/merge_requests/1', commit: `https://gitlab.com/group/sub/project/-/commit/${SHA}`, repository: 'group/sub/project',
    bad: ['single', 'group/../x', 'https://gitlab.com/g/p', 'group//p'], denials: ['glab mr merge', 'glab mr approve'], cli: 'glab', token: 'GITLAB_TOKEN', noun: 'merge request', abbreviation: 'MR' },
} as const;

test('every host has a provider, a gate and a publisher', () => {
  assert.deepEqual(SCM_KINDS, ['github', 'gitlab']);
  assert.deepEqual(Object.keys(SCM_GATES), SCM_KINDS); assert.deepEqual(PUBLISH_KINDS, SCM_KINDS);
  assert.equal(scmAdapter().name, DEFAULT_SCM);
  assert.throws(() => scmAdapter('svn'), /Unknown scm kind/);
  assert.equal(linkText('https://example.com/x'), 'example.com/x');
});

// Both hosts pass the same contract.
for (const [name, host] of Object.entries(HOSTS)) {
  test(`${name}: names, repository validation, links and merge denials follow the host's conventions`, async () => {
    const scm = scmAdapter(name);
    assert.deepEqual([scm.name, scm.cli, scm.tokenVariable, scm.changeNoun, scm.changeAbbreviation], [name, host.cli, host.token, host.noun, host.abbreviation]);
    assert.equal(scm.gate, SCM_GATES[name]); assert.equal(scm.changeAbbreviation, scm.gate.changeNoun);
    assert.ok(scm.validateRepository(host.repository));
    for (const bad of [...host.bad, undefined, 7]) assert.equal(scm.validateRepository(bad), false, String(bad));
    assert.equal(scm.isChangeUrl(host.change), true); assert.equal(scm.isChangeUrl(host.other), false);
    assert.equal(scm.linkText(host.change), host.text); assert.equal(scm.linkText(host.other), host.otherText);
    assert.equal(linkText(host.change), host.text, 'the index picks the adapter from the URL shape');
    assert.equal(scm.commitUrl(host.repository, SHA, {}), host.commit);
    assert.deepEqual(scm.mergeDenials, host.denials);
    const calls: string[][] = [];
    await scm.auth(async (bin, args) => { calls.push([bin, ...args]); return ''; }, '/tmp');
    assert.deepEqual(calls, [[host.cli, 'auth', 'status']]);
  });
}

test('gitlab links follow GITLAB_HOST on a self-managed instance', () => {
  const gitlab = scmAdapter('gitlab');
  assert.equal(gitlab.host({ GITLAB_HOST: 'https://git.example.com' }), 'https://git.example.com');
  assert.equal(gitlab.commitUrl('g/p', SHA, { GITLAB_HOST: 'git.example.com' }), `https://git.example.com/g/p/-/commit/${SHA}`);
});
