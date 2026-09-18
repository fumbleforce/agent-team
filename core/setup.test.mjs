import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chooser, collectSecrets, defaultBranch, detectRepository, draftManifest, ensureIgnores, installedEngines, projectIdFor, readSecrets, secretsFile, writeManifest, writeSecrets } from './setup.mjs';
import { normalizeManifest } from './manifest.mjs';

// A scripted prompt: answers in order; the fallback is what an empty terminal answer would give.
const scripted = answers => async (question, { fallback = null } = {}) => { if (!answers.length) throw new Error(`No answer scripted for: ${question}`); const answer = answers.shift(); return answer === '' ? fallback ?? '' : answer; };
const runWith = (available, remote = 'https://github.com/o/r.git') => (bin, args) => {
  if (bin === 'git' && args.includes('get-url')) return { ok: Boolean(remote), stdout: remote ?? '', stderr: '' };
  if (bin === 'git' && args.includes('symbolic-ref')) return { ok: true, stdout: 'origin/develop\n', stderr: '' };
  return { ok: available.includes(bin), stdout: `${bin} 1.0`, stderr: '' };
};

test('a choice accepts a number, a value or a label and falls back to the marked option', async () => {
  const asked = [];
  const answers = ['', 'two', 'Number Two', 'nine', '1'];
  const choose = chooser(async (question, options) => { asked.push([question, options.fallback]); return answers.shift(); });
  const options = [{ value: 'one', label: 'Number one', hint: 'first' }, { value: 'two', label: 'Number two' }];
  assert.equal(await choose('Pick', options, { fallback: 'two' }), 'two', 'an empty answer without a terminal fallback asks again');
  assert.equal(asked[0][1], '2'); assert.match(asked[0][0], /1\. Number one  \(first\)\n  2\. Number two\nChoose$/);
  assert.equal(await choose('Pick', options), 'two', 'a label, in any case');
  assert.equal(await choose('Pick', options), 'one', 'an unknown answer asks again; a number picks');
  assert.deepEqual(answers, []);
});

test('the checkout tells the setup its host, repository and base branch', () => {
  assert.deepEqual(detectRepository('/repo', runWith([], 'git@github.com:owner/name.git')), { host: 'github.com', repository: 'owner/name', kind: 'github' });
  assert.deepEqual(detectRepository('/repo', runWith([], 'https://user@gitlab.com/group/sub/project.git\n')), { host: 'gitlab.com', repository: 'group/sub/project', kind: 'gitlab' });
  assert.deepEqual(detectRepository('/repo', runWith([], 'ssh://git@git.example.org/team/app')), { host: 'git.example.org', repository: 'team/app', kind: null });
  assert.equal(detectRepository('/repo', runWith([], null)), null);
  assert.equal(defaultBranch('/repo', runWith([])), 'develop');
  assert.equal(defaultBranch('/repo', (bin, args) => ({ ok: args.includes('--abbrev-ref'), stdout: 'feature\n' })), 'feature');
  assert.equal(defaultBranch('/repo', () => ({ ok: false, stdout: '' })), 'main');
  assert.deepEqual(installedEngines(runWith(['git', 'codex', 'opencode'])), ['opencode', 'codex']);
  assert.equal(projectIdFor('My Shop, v2!'), 'my-shop-v2'); assert.equal(projectIdFor('***'), 'project');
});

test('secrets live in one private file per project and never inside the repository', () => {
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'setup-secrets-'));
  try {
    assert.deepEqual(readSecrets('repo', configDir), {});
    const file = writeSecrets('repo', { GH_TOKEN: 'ghp_1', LINEAR_API_KEY: 'lin_2' }, configDir);
    assert.equal(file, secretsFile('repo', configDir));
    assert.equal(statSync(file).mode & 0o777, 0o600); assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
    assert.deepEqual(readSecrets('repo', configDir), { GH_TOKEN: 'ghp_1', LINEAR_API_KEY: 'lin_2' });
    assert.throws(() => writeSecrets('repo', { 'bad name': 'x' }, configDir), /Cannot store/);
    assert.throws(() => writeSecrets('repo', { GH_TOKEN: 'two\nlines' }, configDir), /Cannot store/);
  } finally { rmSync(configDir, { recursive: true, force: true }); }
});

test('the manifest draft asks for what the checkout cannot tell and validates as a version 2 manifest', async () => {
  const checkout = mkdtempSync(path.join(os.tmpdir(), 'setup-draft-'));
  try {
    writeFileSync(path.join(checkout, 'AGENTS.md'), 'rules');
    const log = [];
    // name, scm (fallback: detected github), repository (fallback), base branch (fallback), tracker (fallback: github issues), engine, billing, environment
    const answers = ['Shop App', '', '', '', '', '', '2', '2'];
    const { manifest, secrets } = await draftManifest({ checkout, ask: scripted(answers), run: runWith(['git', 'claude']), target: 'local', env: {}, log: line => log.push(line) });
    assert.deepEqual(answers, []);
    assert.deepEqual(manifest, { version: 2, name: 'Shop App', queueProjectId: 'shop-app', instructions: ['AGENTS.md'],
      scm: { kind: 'github', repository: 'o/r', baseBranch: 'develop', branchPrefix: 'agents/' }, tracker: { kind: 'github', repository: 'o/r', readyLabel: 'agent:ready' },
      engine: { default: 'claude', billing: 'api' }, worker: { launcher: 'local', environment: 'browser' }, pm: { autonomy: 'suggest', dailyCapUsd: 10 },
      ideation: { enabled: true, backlogCap: 8, batchSize: 3, minimumIntervalHours: 24, ideaLabel: 'idea', proposedState: 'idea:proposed', approvedState: 'agent:approved', rejectedState: 'closed' } });
    assert.deepEqual(secrets, {});
    assert.equal(normalizeManifest(manifest).engine.billing, 'api');
    // A bad repository path is refused and asked again; the cloud target gets cloud workers.
    // scm gitlab, a refused repository path, the branch, tracker linear typed by hand (no key), engine opencode, standard environment
    const retry = ['App', '2', 'not a repo', 'group/project', 'main', '1', '', 'wsid', 'https://linear.app/ws', 'team', 'proj', 'https://linear.app/ws/project/p', '', '1', '1'];
    const linear = await draftManifest({ checkout, ask: scripted(retry), run: runWith(['git', 'opencode'], null), target: 'aws', env: {}, log: line => log.push(line) });
    assert.deepEqual(retry, []);
    assert.match(log.join('\n'), /not a repo is not a gitlab repository path/); assert.equal(linear.manifest.scm.kind, 'gitlab');
    assert.equal(linear.manifest.scm.repository, 'group/project'); assert.equal(linear.manifest.worker.launcher, 'ec2');
    assert.deepEqual(linear.manifest.tracker, { kind: 'linear', workspaceId: 'wsid', workspaceUrl: 'https://linear.app/ws', teamId: 'team', projectId: 'proj', projectUrl: 'https://linear.app/ws/project/p', readyLabel: 'agent:ready' });
    assert.equal(linear.manifest.engine.default, 'opencode'); assert.equal(linear.manifest.engine.billing, 'provider');
    const file = writeManifest(checkout, manifest);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).name, 'Shop App');
    assert.deepEqual(ensureIgnores(checkout), ['.agent-team/', '.agent-team-result.json']);
    writeFileSync(path.join(checkout, '.gitignore'), 'node_modules\n.agent-team/');
    assert.deepEqual(ensureIgnores(checkout), ['.agent-team-result.json']);
    assert.equal(readFileSync(path.join(checkout, '.gitignore'), 'utf8'), 'node_modules\n.agent-team/\n.agent-team-result.json\n');
    assert.deepEqual(ensureIgnores(checkout), []);
  } finally { rmSync(checkout, { recursive: true, force: true }); }
});

test('credentials come from the environment, then the private file, then one hidden question each', async () => {
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'setup-collect-'));
  try {
    const manifest = normalizeManifest({ version: 2, name: 'Repo', instructions: [], scm: { kind: 'github', repository: 'o/r' }, tracker: { kind: 'github', repository: 'o/r', readyLabel: 'agent:ready' }, engine: { default: 'claude', billing: 'api' }, integrations: [{ kind: 'slack' }] });
    const log = [];
    const questions = [];
    const ask = answers => async (question, options) => { questions.push([question, options?.secret === true]); return answers.shift(); };
    // The SCM token also serves the tracker, so it is not asked twice; the integration is optional.
    const first = await collectSecrets({ manifest, projectId: 'repo', configDir, env: { HOME: '/h' }, ask: ask(['ghp_1', 'sk-2', '']), log: line => log.push(line) });
    assert.deepEqual(questions.map(([q, secret]) => [q.replace(/^Paste the /, ''), secret]), [['github token able to push branches and open pull requests', true], ['claude API key', true], ['Slack token for the slack integration (empty to skip; the engine may log in itself)', true]]);
    assert.deepEqual(first.values, { GH_TOKEN: 'ghp_1', ANTHROPIC_API_KEY: 'sk-2' });
    assert.deepEqual(first.env, { HOME: '/h', GH_TOKEN: 'ghp_1', ANTHROPIC_API_KEY: 'sk-2' });
    assert.deepEqual(readSecrets('repo', configDir), { GH_TOKEN: 'ghp_1', ANTHROPIC_API_KEY: 'sk-2' });
    assert.match(log.join('\n'), /stored for this machine only/);
    assert.ok(!log.join('\n').includes('ghp_1') && !log.join('\n').includes('sk-2'));
    // Next time nothing is asked but the optional integration; the environment wins over the file.
    questions.length = 0;
    const second = await collectSecrets({ manifest, projectId: 'repo', configDir, env: { ANTHROPIC_API_KEY: 'env-key' }, ask: ask(['xoxb-3']), log: line => log.push(line) });
    assert.deepEqual(questions.map(([q]) => q.slice(0, 15)), ['Paste the Slack']);
    assert.deepEqual(second.env, { ANTHROPIC_API_KEY: 'env-key', GH_TOKEN: 'ghp_1', SLACK_MCP_TOKEN: 'xoxb-3' });
    assert.deepEqual(readSecrets('repo', configDir), { GH_TOKEN: 'ghp_1', ANTHROPIC_API_KEY: 'sk-2', SLACK_MCP_TOKEN: 'xoxb-3' });
    // A preset (typed during the manifest draft) is kept without asking; a required blank fails.
    const preset = await collectSecrets({ manifest, projectId: 'other', configDir, env: {}, ask: ask(['sk-9', '']), preset: { GH_TOKEN: 'ghp_p' }, store: false });
    assert.deepEqual(preset.values, { GH_TOKEN: 'ghp_p', ANTHROPIC_API_KEY: 'sk-9' }); assert.deepEqual(readSecrets('other', configDir), {}); assert.equal(preset.file, null);
    await assert.rejects(collectSecrets({ manifest, projectId: 'other', configDir, env: {}, ask: ask(['']) }), /github token .* is required/);
    // `replace` asks for everything again and overwrites the file.
    const replaced = await collectSecrets({ manifest, projectId: 'repo', configDir, env: { GH_TOKEN: 'ignored' }, ask: ask(['ghp_new', 'sk-new', '']), replace: true });
    assert.deepEqual(readSecrets('repo', configDir), { GH_TOKEN: 'ghp_new', ANTHROPIC_API_KEY: 'sk-new' }); assert.equal(replaced.env.GH_TOKEN, 'ghp_new');
  } finally { rmSync(configDir, { recursive: true, force: true }); }
});
