import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { SCM_APIS, xmlEntries } from './api.ts';
import { SCM_KINDS, scmAdapter, scmApi } from './index.ts';

// Both hosts answer the same neutral questions from recorded API responses (fixtures/<host>.json, trimmed to the fields read).
const fixture = (name: string) => readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8');
const SHA = 'b'.repeat(40);

// A zip as the artifact download returns it: entries deflated or stored, then the central directory.
function zip(entries: { name: string; data: string; deflate: boolean }[]): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), raw = Buffer.from(entry.data), data = entry.deflate ? deflateRawSync(raw) : raw;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(entry.deflate ? 8 : 0, 8); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26);
    const header = Buffer.alloc(46); header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(entry.deflate ? 8 : 0, 10); header.writeUInt32LE(data.length, 20); header.writeUInt32LE(raw.length, 24); header.writeUInt16LE(name.length, 28); header.writeUInt32LE(offset, 42);
    locals.push(local, name, data); central.push(header, name);
    offset += 30 + name.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
const ARCHIVE = zip([{ name: 'README.txt', data: 'not a report', deflate: false }, { name: 'reports/junit.xml', data: fixture('junit.xml'), deflate: true }, { name: 'reports/other.xml', data: '<coverage/>', deflate: false }]);

const HOSTS = {
  github: { env: { GH_TOKEN: 'host-token' }, base: 'https://api.github.com', repository: 'o/r', change: 'https://github.com/o/r/pull/7', foreign: 'https://github.com/o/other/pull/7', suite: 'junit-e2e', header: 'authorization',
    review: { state: 'approved', approvals: 1, reviewers: [{ name: 'ana', state: 'approved' }, { name: 'ben', state: 'commented' }] },
    environments: [{ name: 'preview', url: 'https://preview.example.com', branch: 'feature/pay' }] },
  gitlab: { env: { GITLAB_TOKEN: 'host-token', GITLAB_HOST: 'git.example.com' }, base: 'https://git.example.com/api/v4', repository: 'group/sub/project', change: 'https://git.example.com/group/sub/project/-/merge_requests/42', foreign: 'https://git.example.com/group/other/-/merge_requests/42', suite: 'e2e', header: 'private-token',
    review: { state: 'approved', approvals: 1, reviewers: [{ name: 'ana', state: 'approved' }] },
    environments: [{ name: 'preview', url: 'https://preview.example.com', branch: null }] },
} as const;

function recorded(name: keyof typeof HOSTS) {
  const host = HOSTS[name], answers = JSON.parse(fixture(`${name}.json`)) as Record<string, unknown>, seen: string[] = [];
  const fake = (async (url: string | URL, init?: RequestInit) => {
    const route = String(url).replace(host.base, '');
    seen.push(route);
    assert.match(String(((init?.headers ?? {}) as Record<string, string>)[host.header]), /host-token/, 'every call carries the token');
    if (route.endsWith('/zip')) return new Response(new Uint8Array(ARCHIVE), { status: 200 });
    return Object.hasOwn(answers, route) ? new Response(JSON.stringify(answers[route]), { status: 200 }) : new Response(JSON.stringify({ message: 'host-token is not welcome here' }), { status: 404 });
  }) as typeof fetch;
  return { seen, api: scmApi(name, { env: host.env, fetch: fake })! };
}

test('every host has a polling client, and none without its token', () => {
  assert.deepEqual(Object.keys(SCM_APIS), SCM_KINDS);
  for (const kind of SCM_KINDS) { assert.equal(scmApi(kind, { env: {} }), null); assert.equal(scmAdapter(kind).api({ env: {} }), null); }
  assert.equal(scmApi('svn', { env: { GH_TOKEN: 'x' } }), null);
});

test('the report archive reader takes the XML entries, deflated or stored, and refuses what is not a zip', () => {
  assert.deepEqual(xmlEntries(ARCHIVE).map(text => text.slice(0, 12)), ['<?xml versio', '<coverage/>']);
  assert.throws(() => xmlEntries(Buffer.from('plainly not an archive, but long enough to look at')), /Unreadable report archive/);
});

for (const [name, host] of Object.entries(HOSTS) as [keyof typeof HOSTS, (typeof HOSTS)[keyof typeof HOSTS]][]) {
  test(`${name}: review state, test reports and environments come back in the neutral shape`, async () => {
    const { api, seen } = recorded(name);
    assert.deepEqual(await api.reviewState(host.repository, host.change), host.review);
    await assert.rejects(api.reviewState(host.repository, host.foreign), /Not a change of this repository/);
    // The recorded change collides with its base.
    assert.deepEqual(await api.changeState(host.repository, host.change), { open: true, merged: false, headSha: SHA, conflicting: true });
    await assert.rejects(api.changeState(host.repository, host.foreign), /Not a change of this repository/);

    const expected = [{ suite: host.suite, branch: 'feature/pay', sha: SHA, counts: [1, 1, 1, 3, 1500], failing: [{ name: 'checkout.spec › pays with card', status: 'failed', message: 'Expected 200, got 500' }] }];
    for (const ref of [{ change: host.change }, { branch: 'feature/pay' }]) {
      const reports = await api.testReports(host.repository, ref);
      assert.deepEqual(reports.map(item => ({ suite: item.suite, branch: item.branch, sha: item.sha, counts: [item.report.passed, item.report.failed, item.report.skipped, item.report.total, item.report.durationMs], failing: item.report.failing })), expected, JSON.stringify(ref));
    }
    assert.deepEqual(await api.testReports(host.repository, { branch: 'no-pipeline-yet' }).catch(error => (error as Error).message), name === 'github' ? 'GitHub HTTP request failed (404)' : 'GitLab HTTP request failed (404)');

    assert.deepEqual(await api.environments(host.repository), host.environments);
    assert.ok(seen.every(route => route.startsWith('/')), 'only the configured host is called');
    await assert.rejects(api.environments('../escape'), /Invalid repository/);
  });

  test(`${name}: a failing host never leaks the response body or the token`, async () => {
    const api = scmApi(name, { env: host.env, fetch: (async () => new Response('host-token rejected: secret-body', { status: 500 })) as typeof fetch })!;
    for (const attempt of [api.reviewState(host.repository, host.change), api.changeState(host.repository, host.change), api.testReports(host.repository, { branch: 'main' }), api.environments(host.repository)]) await assert.rejects(attempt, error => /\(500\)/.test((error as Error).message) && !/host-token|secret-body/.test((error as Error).message));
    const offline = scmApi(name, { env: host.env, fetch: (async () => { throw new Error('connect ECONNREFUSED host-token'); }) as typeof fetch })!;
    await assert.rejects(offline.environments(host.repository), error => /network request failed/.test((error as Error).message) && !/host-token/.test((error as Error).message));
  });
}

// The settings file is read as committed, a change to it goes out as a branch, one commit and a change request, and the check names
// come from where the merge gate reads them. The recorded host answers only what these calls ask.
test('both hosts read the committed settings file, propose a change to it, and name the checks of a branch', async () => {
  const calls: { method: string; url: string; body: any }[] = [];
  const settings = '{"delivery":{"autoMergeAuthorized":false}}';
  const answer = (method: string, url: string): Response => {
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (method === 'GET' && /contents\/\.agent-team\.json\?ref=main$/.test(url)) return json({ content: Buffer.from(settings).toString('base64'), encoding: 'base64', sha: 'file-sha' });
    if (method === 'GET' && /contents\/\.agent-team\.json\?ref=other$/.test(url)) return json({ message: 'Not Found' }, 404);
    if (method === 'GET' && /git\/ref\/heads\/main$/.test(url)) return json({ object: { sha: 'base-sha' } });
    if (method === 'GET' && /check-runs/.test(url)) return json({ check_runs: [{ name: 'verify' }, { name: 'e2e' }] });
    if (method === 'GET' && /\/status$/.test(url)) return json({ statuses: [{ context: 'ci/legacy' }, { context: 'verify' }] });
    if (method === 'POST' && /\/pulls$/.test(url)) return json({ html_url: 'https://github.com/o/r/pull/12' });
    if (method === 'GET' && /files\/\.agent-team\.json\/raw\?ref=main$/.test(url)) return new Response(settings);
    if (method === 'GET' && /files\/\.agent-team\.json\/raw\?ref=other$/.test(url)) return json({ message: '404 File Not Found' }, 404);
    if (method === 'GET' && /pipelines\?ref=main/.test(url)) return json([{ id: 5 }]);
    if (method === 'GET' && /pipelines\/5\/jobs/.test(url)) return json([{ name: 'verify' }, { name: 'lint' }, { name: 'verify' }]);
    if (method === 'POST' && /merge_requests$/.test(url)) return json({ web_url: 'https://git.example.com/group/sub/project/-/merge_requests/43' });
    return json({});
  };
  const fake = (async (url: string | URL, init?: RequestInit) => { const method = init?.method ?? 'GET'; calls.push({ method, url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null }); return answer(method, String(url)); }) as typeof fetch;
  const input = { base: 'main', branch: 'agent-team/settings-1', path: '.agent-team.json', content: '{"delivery":{"autoMergeAuthorized":true}}', title: 'Let the team merge', body: 'Asked for in the app.' };

  const github = SCM_APIS.github!({ env: { GH_TOKEN: 'host-token' }, fetch: fake })!;
  assert.equal(await github.readFile!('o/r', '.agent-team.json', 'main'), settings);
  assert.equal(await github.readFile!('o/r', '.agent-team.json', 'other'), null, 'no file is no settings, not a failure');
  assert.deepEqual(await github.checkNames!('o/r', 'main'), ['ci/legacy', 'e2e', 'verify']);
  calls.length = 0;
  assert.equal(await github.proposeFile!('o/r', input), 'https://github.com/o/r/pull/12');
  const writes = calls.filter(call => call.method !== 'GET');
  assert.deepEqual(writes.map(call => [call.method, call.url.replace('https://api.github.com/repos/o/r', '')]), [['POST', '/git/refs'], ['PUT', '/contents/.agent-team.json'], ['POST', '/pulls']]);
  assert.deepEqual(writes[0]!.body, { ref: 'refs/heads/agent-team/settings-1', sha: 'base-sha' });
  assert.deepEqual([Buffer.from(writes[1]!.body.content, 'base64').toString(), writes[1]!.body.branch, writes[1]!.body.sha], [input.content, input.branch, 'file-sha']);
  assert.deepEqual([writes[2]!.body.head, writes[2]!.body.base], [input.branch, 'main']);

  const gitlab = SCM_APIS.gitlab!({ env: { GITLAB_TOKEN: 'host-token', GITLAB_HOST: 'git.example.com' }, fetch: fake })!;
  assert.equal(await gitlab.readFile!('group/sub/project', '.agent-team.json', 'main'), settings);
  assert.equal(await gitlab.readFile!('group/sub/project', '.agent-team.json', 'other'), null);
  assert.deepEqual(await gitlab.checkNames!('group/sub/project', 'main'), ['lint', 'verify']);
  calls.length = 0;
  assert.equal(await gitlab.proposeFile!('group/sub/project', input), 'https://git.example.com/group/sub/project/-/merge_requests/43');
  const commit = calls.find(call => call.method === 'POST' && /repository\/commits$/.test(call.url))!;
  assert.deepEqual([commit.body.branch, commit.body.start_branch, commit.body.actions[0].action, commit.body.actions[0].content], [input.branch, 'main', 'update', input.content]);
});
