import test from 'node:test';
import assert from 'node:assert/strict';
import { approvalStatus, createClient, identifier, issueNumber, mcpServers, normalizeIssue, scopeInstructions, validateManifest } from './github.mjs';
import { trackerAdapter, trackerCredentialPresent, trackersWithCredentials, isIssueId } from './index.mjs';
import { normalizeManifest, flatTracker } from '../../core/manifest.mjs';

const ideation = { enabled: true, backlogCap: 5, batchSize: 2, minimumIntervalHours: 24, ideaLabel: 'idea', proposedState: 'idea:proposed', approvedState: 'agent:approved', rejectedState: 'closed' };
const raw = { version: 2, name: 'Repo', queueProjectId: 'repo', instructions: [], scm: { kind: 'github', repository: 'o/r', baseBranch: 'main' }, tracker: { kind: 'github', repository: 'o/r', readyLabel: 'agent:ready' }, ideation };

// A tiny GitHub REST double: labels, issues and comments for one repository.
function fakeGitHub({ labels = ['agent:ready', 'idea', 'agent:approved', 'idea:proposed'], issues = [] } = {}) {
  const state = { labels: labels.map(name => ({ name })), issues: [...issues], comments: {}, calls: [] };
  const fetchImpl = async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    state.calls.push(`${init.method} ${pathname}${searchParams.get('page') && searchParams.get('page') !== '1' ? `?page=${searchParams.get('page')}` : ''}`);
    const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (init.headers.authorization !== 'Bearer ghp_test') return json({}, 401);
    const page = Number(searchParams.get('page') ?? 1);
    if (pathname === '/repos/o/r/labels' && init.method === 'GET') return json(page === 1 ? state.labels : []);
    if (pathname === '/repos/o/r/labels' && init.method === 'POST') { const body = JSON.parse(init.body); state.labels.push({ name: body.name }); return json({ name: body.name }, 201); }
    if (pathname === '/repos/o/r/issues' && init.method === 'GET') { const wanted = searchParams.get('labels'); const open = searchParams.get('state') === 'open'; return json(page === 1 ? state.issues.filter(issue => (!open || issue.state === 'open') && (!wanted || issue.labels.some(label => label.name === wanted))) : []); }
    if (pathname === '/repos/o/r/issues' && init.method === 'POST') { const body = JSON.parse(init.body); const issue = { number: state.issues.length + 1, title: body.title, body: body.body, state: 'open', labels: (body.labels ?? []).map(name => ({ name })), html_url: `https://github.com/o/r/issues/${state.issues.length + 1}` }; state.issues.push(issue); return json(issue, 201); }
    const one = /^\/repos\/o\/r\/issues\/(\d+)(?:\/(comments|labels))?$/.exec(pathname);
    if (one) {
      const issue = state.issues.find(item => item.number === Number(one[1]));
      if (!issue) return json({}, 404);
      if (!one[2]) return json(issue);
      if (one[2] === 'labels') { for (const name of JSON.parse(init.body).labels) issue.labels.push({ name }); return json(issue.labels); }
      if (init.method === 'GET') return json(page === 1 ? state.comments[issue.number] ?? [] : []);
      const comment = { id: 100 + Object.values(state.comments).flat().length, body: JSON.parse(init.body).body, created_at: new Date(2026, 0, 1 + Object.values(state.comments).flat().length).toISOString(), user: { login: 'bot' } };
      (state.comments[issue.number] ??= []).push(comment); return json(comment, 201);
    }
    return json({}, 404);
  };
  return { state, fetchImpl };
}

test('the github tracker registers, validates its manifest and derives the neutral scope fields', () => {
  assert.equal(trackerAdapter('github').NAME, 'github');
  const manifest = normalizeManifest(raw);
  assert.equal(manifest.tracker.projectId, 'o/r'); assert.equal(manifest.tracker.teamId, 'o/r'); assert.equal(manifest.tracker.projectUrl, 'https://github.com/o/r/issues');
  assert.throws(() => validateManifest({ repository: 'nope', readyLabel: 'x' }), /owner\/name/);
  assert.throws(() => validateManifest({ repository: 'o/r', readyLabel: 'x', ownerInboxIssue: 'TEAM-1' }), /GH-12/);
  assert.ok(isIssueId('github', 'GH-12')); assert.ok(!isIssueId('github', 'TEAM-12'));
  assert.equal(identifier(7), 'GH-7'); assert.equal(issueNumber('GH-7'), 7); assert.equal(issueNumber('GH-0'), null);
  assert.match(scopeInstructions(manifest.tracker), /GitHub Issues on o\/r/);
  assert.deepEqual(mcpServers(manifest.tracker, {}), { tracker: { type: 'http', url: 'https://api.githubcopilot.com/mcp/' } });
  assert.equal(mcpServers(manifest.tracker, { GH_TOKEN: 't' }).tracker.headers.Authorization, 'Bearer t');
  assert.ok(trackerCredentialPresent('github', { GH_TOKEN: 't' })); assert.ok(!trackerCredentialPresent('github', {}));
  assert.deepEqual(trackersWithCredentials({ GITHUB_ISSUES_TOKEN: 'x', LINEAR_API_KEY: 'y' }), ['linear', 'github']);
});

test('issues normalize to the neutral shape and approval reads labels as states', () => {
  const manifest = flatTracker(normalizeManifest(raw));
  const approved = normalizeIssue({ number: 3, title: 'Idea', body: 'b', state: 'open', labels: [{ name: 'idea' }, { name: 'agent:approved' }] }, manifest, ideation);
  assert.equal(approved.identifier, 'GH-3'); assert.equal(approved.state.name, 'agent:approved'); assert.equal(approved.projectId, 'o/r');
  assert.deepEqual(approvalStatus(manifest, approved), { allowed: true, reason: 'Owner approved' });
  const proposed = normalizeIssue({ number: 4, state: 'open', labels: [{ name: 'idea' }, { name: 'idea:proposed' }] }, manifest, ideation);
  assert.equal(proposed.state.type, 'backlog'); assert.equal(approvalStatus(manifest, proposed).reason, 'Owner approval required');
  const held = normalizeIssue({ number: 5, state: 'open', labels: [{ name: 'idea' }, { name: 'agent:approved' }, { name: 'owner:decision' }] }, manifest, ideation);
  assert.match(approvalStatus(manifest, held).reason, /on hold/);
  const closed = normalizeIssue({ number: 6, state: 'closed', state_reason: 'not_planned', labels: [{ name: 'idea' }] }, manifest, ideation);
  assert.equal(closed.state.type, 'canceled'); assert.equal(closed.state.name, 'closed');
  assert.equal(approvalStatus(manifest, normalizeIssue({ number: 7, state: 'open', labels: [] }, manifest, ideation)).reason, 'Not an active repository idea');
});

test('the client snapshots, publishes ideas under the cap, readies approved ones, comments and bootstraps', async () => {
  const manifest = flatTracker(normalizeManifest(raw));
  const github = fakeGitHub({ issues: [{ number: 1, title: 'Existing idea', body: '', state: 'open', labels: [{ name: 'idea' }, { name: 'agent:approved' }], html_url: 'https://github.com/o/r/issues/1' }, { number: 2, title: 'A PR', state: 'open', labels: [], pull_request: {} }] });
  assert.throws(() => createClient({ apiKey: '' }), /GITHUB_ISSUES_TOKEN/);
  const client = createClient({ apiKey: 'ghp_test', fetchImpl: github.fetchImpl });
  const snapshot = await client.snapshot(manifest);
  assert.deepEqual(snapshot.allIssues.map(issue => issue.identifier), ['GH-1'], 'pull requests are not issues');
  assert.equal(snapshot.remaining, 4);
  const proposal = { title: 'New idea', problem: 'p', benefit: 'b', scope: 's', successCriteria: ['c'], effort: 'S', evidence: ['e'], whyNow: 'w' };
  const published = await client.publishProposals(manifest, [proposal, { ...proposal, title: 'existing IDEA' }], { jobId: 'job-1' });
  assert.equal(published.created.length, 1); assert.equal(published.skipped, 1);
  assert.deepEqual(github.state.issues[2].labels.map(label => label.name), ['idea', 'idea:proposed']);
  assert.equal(published.created[0].identifier, 'GH-3');
  assert.equal((await client.checkApproved(manifest, 'GH-3')).allowed, false);
  const readied = await client.prepareApproved(manifest, 'GH-1');
  assert.ok(readied.labels.some(label => label.name === 'agent:ready'));
  await assert.rejects(client.prepareApproved(manifest, 'GH-3'), /Owner approval required/);
  const posted = await client.postComment(manifest, 'GH-1', 'Claimed');
  assert.deepEqual(posted, { id: '100', issue: 'GH-1', title: 'Existing idea' });
  assert.deepEqual((await client.issueComments(manifest, 'GH-1')).map(comment => [comment.author, comment.body]), [['bot', 'Claimed']]);
  await assert.rejects(client.postComment(manifest, 'GH-99', 'x'), /not in the configured repository/);
  assert.deepEqual(await client.inboxComments(manifest), [], 'no inbox configured yet');
  const log = [];
  const bootstrap = await client.bootstrap(manifest, { log: line => log.push(line) });
  assert.equal(bootstrap.ownerInboxIssue, 'GH-4');
  assert.ok(bootstrap.created.includes('agent:blocked') && bootstrap.created.includes('agent:in-review') && bootstrap.created.includes('agent:inbox'));
  assert.deepEqual((await client.bootstrap(manifest, {})).created, [], 'a second bootstrap creates nothing');
  assert.equal((await client.bootstrap(manifest, {})).ownerInboxIssue, 'GH-4', 'the open inbox issue is found again');
  assert.deepEqual((await client.lookup({ repository: 'o/r' })).labels.map(label => label.name).slice(0, 2), ['agent:ready', 'idea']);
  const missing = fakeGitHub({ labels: ['agent:ready'] });
  await assert.rejects(createClient({ apiKey: 'ghp_test', fetchImpl: missing.fetchImpl }).snapshot(manifest), /label "idea" is missing/);
  await assert.rejects(createClient({ apiKey: 'wrong', fetchImpl: github.fetchImpl }).snapshot(manifest), /HTTP request failed \(401\)/);
});
