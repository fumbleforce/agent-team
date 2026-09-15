import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireLock, main, parseArgs, validateResult, modelEnvironment, isSensitivePath, sparsePatterns } from './runner.mjs';

const runner = fileURLToPath(new URL('./runner.mjs', import.meta.url));
const resultName = '.agent-team-result.json';
const fakeOpenCode = String.raw`#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify(args) + '\n');
if (args[0] === '--version') { console.log('opencode fake-test'); process.exit(0); }
const cwd = args[args.indexOf('--dir') + 1];
if (process.env.AGENT_TEAM_TOKEN !== undefined) throw new Error('Worker token leaked to model');
for (const name of JSON.parse(process.env.EXPECT_ABSENT || '[]')) {
  if (fs.existsSync(path.join(cwd, name))) throw new Error('Sensitive artifact materialized: ' + name);
}
for (const name of JSON.parse(process.env.EXPECT_PRESENT || '[]')) {
  if (!fs.existsSync(path.join(cwd, name))) throw new Error('Safe artifact missing: ' + name);
}
if (process.env.EXPECT_CLEAN === '1') {
  const status = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd, encoding: 'utf8' });
  if (status.status !== 0 || status.stdout !== '') throw new Error('Dirty checkout baseline: ' + status.stdout + status.stderr);
}
fs.writeFileSync(process.env.CONFIG_CAPTURE, process.env.OPENCODE_CONFIG_CONTENT);
const countFile = process.env.COUNT;
const count = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) + 1 : 1;
fs.writeFileSync(countFile, String(count));
console.log(JSON.stringify({type: 'fake', cycle: count}));
console.error('fake stderr ' + count);
fs.writeFileSync(path.join(cwd, 'agent-change.txt'), 'cycle ' + count);
const modes = JSON.parse(process.env.MODES || '["ready"]');
const mode = modes[count - 1] || modes.at(-1);
if (mode === 'hang') {
  const descendant = spawn(process.execPath, ['-e',
    'process.on("SIGTERM", () => {}); process.send("ready"); setInterval(() => {}, 1000)'],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  descendant.on('message', () => {
    fs.writeFileSync(process.env.PIDS, JSON.stringify({parent: process.pid, descendant: descendant.pid}));
  });
  setInterval(() => {}, 1000);
} else {
  const report = {outcome: mode === 'fail' ? 'ready' : mode, issue: process.env.RESULT_ISSUE || 'TEST-1', summary: 'Fake targeted test evidence', prUrl: null};
  if (process.env.REPORT_OVERRIDE) Object.assign(report, JSON.parse(process.env.REPORT_OVERRIDE));
  if (mode === 'malformed') fs.writeFileSync(path.join(cwd, '${resultName}'), '{broken');
  else if (mode === 'extra') fs.writeFileSync(path.join(cwd, '${resultName}'), JSON.stringify({...report, unexpected: true}));
  else if (mode === 'symlink') fs.symlinkSync(process.env.CALLS, path.join(cwd, '${resultName}'));
  else if (mode !== 'missing') fs.writeFileSync(path.join(cwd, '${resultName}'), JSON.stringify(report));
  process.exitCode = mode === 'fail' ? 7 : 0;
}
`;

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture(t, modes = ['ready']) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runner-test-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'repo with spaces');
  const bin = path.join(temporary, 'bin');
  const packageDir = path.join(temporary, 'shared package');
  fs.mkdirSync(root);
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(packageDir, 'agents'), { recursive: true });
  fs.copyFileSync(runner, path.join(packageDir, 'runner.mjs'));
  fs.copyFileSync(fileURLToPath(new URL('./delivery.mjs', import.meta.url)), path.join(packageDir, 'delivery.mjs'));
  fs.writeFileSync(path.join(packageDir, 'agents', 'team-coordinator.md'), 'Shared generic coordinator prompt');
  fs.writeFileSync(path.join(packageDir, 'agents', 'team-developer.md'), 'Shared generic developer prompt');
  fs.writeFileSync(path.join(packageDir, 'opencode.json'), JSON.stringify({ agent: {
    'team-coordinator': { mode: 'primary', prompt: '{file:./agents/team-coordinator.md}' },
    'team-developer': { mode: 'subagent', prompt: '{file:./agents/team-developer.md}' },
  } }));
  git(root, 'init', '--quiet');
  fs.writeFileSync(path.join(root, '.gitignore'), '.agent-team/\n.agent-team-result.json\nnode_modules/\n.env\n');
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'base contents\n');
  git(root, 'add', '.');
  git(root, '-c', 'user.name=Runner Test', '-c', 'user.email=runner@example.invalid', 'commit', '-qm', 'fixture base');
  const base = git(root, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'staged main work\n');
  git(root, 'add', 'tracked.txt');
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'uncommitted main work\n');
  fs.writeFileSync(path.join(root, 'untracked.txt'), 'private untracked work');
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=never-copy');
  fs.mkdirSync(path.join(root, 'database'));
  fs.writeFileSync(path.join(root, 'database', 'portis-dev.db'), 'never copy a database');
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'node_modules', 'secret'), 'never copy dependencies');
  fs.mkdirSync(path.join(root, 'docs'));
  fs.mkdirSync(path.join(root, '.opencode', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(root, 'opencode.json'), '{"local":"must not overlay"}');
  fs.writeFileSync(path.join(root, '.opencode', 'agents', 'team-coordinator.md'), 'Local role must not overlay');
  const setup = {
    'AGENTS.md': 'Local coordinator instructions',
    '.cursorrules': 'Project rules',
    'docs/AGENT_TEAM.md': 'Team instructions',
    'docs/PRODUCT_CHARTER.md': 'Product scope',
    '.agent-team.json': JSON.stringify({ version: 1, name: 'Synthetic project', charter: 'docs/PRODUCT_CHARTER.md',
      instructions: ['AGENTS.md', '.cursorrules', 'docs/AGENT_TEAM.md'], workspaceId: 'workspace', workspaceUrl: 'https://linear.app/test',
      teamId: 'team', projectId: 'project', projectUrl: 'https://linear.app/test/project', readyLabel: 'agent:ready' }),
  };
  for (const [name, value] of Object.entries(setup)) fs.writeFileSync(path.join(root, name), value);
  fs.writeFileSync(path.join(bin, 'opencode'), fakeOpenCode, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}\nimport fs from 'node:fs';\nfs.appendFileSync(process.env.CALLS, JSON.stringify(['gh', ...process.argv.slice(2)]) + '\\n');\nprocess.exit(Number(process.env.GH_EXIT || 0));\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLS: path.join(temporary, 'calls'),
    COUNT: path.join(temporary, 'count'), PIDS: path.join(temporary, 'pids'), MODES: JSON.stringify(modes),
    CONFIG_CAPTURE: path.join(temporary, 'resolved-config') };
  delete env.OPENCODE_CONFIG_CONTENT;
  const output = [];
  const warnings = [];
  return { root, base, setup, env, output, warnings, packageDir,
    run: (args = [], overrides = {}) => main(args, { cwd: root, env, packageDir, output: message => output.push(message),
      warning: message => warnings.push(message), graceMs: 80, ...overrides }),
    calls: () => fs.existsSync(env.CALLS) ? fs.readFileSync(env.CALLS, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [],
    journals: () => fs.readdirSync(path.join(root, '.agent-team', 'runs')).map(id =>
      JSON.parse(fs.readFileSync(path.join(root, '.agent-team', 'runs', id, 'journal.json'), 'utf8'))),
  };
}

async function waitFor(predicate, timeout = 8_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for test condition');
    await delay(20);
  }
}

function alive(pid) {
  try {
    // Killed orphans can briefly remain zombies before the host init reaps them.
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return !/^\s*[ZX]/.test(stat.slice(stat.lastIndexOf(')') + 1));
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

test('CLI defaults, bounds, conflicts and strict report schema', () => {
  assert.deepEqual(parseArgs([]), { execute: false, cycles: 1, timeoutMinutes: 45, base: 'HEAD', publish: false, autoMerge: false });
  for (const args of [['--cycles', '0'], ['--cycles', '6'], ['--cycles', '1.5'], ['--timeout-minutes', '121'],
    ['--timeout-minutes', '0'], ['--model'], ['--wat'], ['--execute', '--dry-run'], ['--status', '--execute'], ['--execute', '--execute'],
    ['--publish', '--cycles', '2'], ['--issue', 'https://linear.app/issue'], ['--issue', 'FUM-0'], ['--project']]) {
    assert.throws(() => parseArgs(args));
  }
  assert.equal(parseArgs(['--cycles', '5', '--timeout-minutes', '120']).timeoutMinutes, 120);
  const good = { outcome: 'ready', issue: null, summary: 'Evidence', prUrl: null };
  assert.deepEqual(validateResult(good), good);
  for (const report of [null, [], {}, { ...good, extra: true }, { ...good, outcome: 'done' },
    { ...good, issue: 2 }, { ...good, summary: '' }, { ...good, prUrl: 'not a URL' }]) {
    assert.throws(() => validateResult(report));
  }
});

test('auto-merge requires publish and one cycle; approvals only extend ready merge reports', () => {
  assert.throws(() => parseArgs(['--auto-merge']), /requires --publish/);
  assert.throws(() => parseArgs(['--auto-merge', '--publish', '--cycles', '2']));
  assert.equal(parseArgs(['--auto-merge', '--publish', '--cycles', '1']).autoMerge, true);
  const report = { outcome: 'ready', issue: 'TEST-1', summary: 'Evidence', prUrl: null, approvals: null };
  assert.throws(() => validateResult(report));
  assert.equal(validateResult(report, { autoMerge: true }), report);
  assert.throws(() => validateResult({ ...report, unexpected: true }, { autoMerge: true }));
});

function authorizeDelivery(f, checkEnforcement) {
  const file = path.join(f.root, '.agent-team.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  config.delivery = { repository: 'fumbleforce/stockapp', baseBranch: 'master', requiredChecks: ['Agent verification'], autoMergeAuthorized: true };
  if (checkEnforcement !== undefined) config.delivery.checkEnforcement = checkEnforcement;
  fs.writeFileSync(file, JSON.stringify(config));
}

test('auto-merge preflight requires project authorization and dry-run stays read-only', async t => {
  const f = fixture(t);
  await assert.rejects(f.run(['--auto-merge', '--publish']), /autoMergeAuthorized/);
  assert.deepEqual(f.calls(), []);
  authorizeDelivery(f);
  assert.equal(await f.run(['--auto-merge', '--publish', '--dry-run']), 0);
  assert.equal(fs.existsSync(path.join(f.root, '.agent-team')), false);
  assert.deepEqual(f.calls(), [['--version'], ['gh', 'auth', 'status']]);
  assert.match(JSON.parse(f.output.at(-1)).prompt, /distinct Task sessions/);
});

test('auto-merge blockers preserve readable report, PR, recovery and exit 2', async t => {
  const f = fixture(t);
  authorizeDelivery(f);
  const prUrl = 'https://github.com/fumbleforce/stockapp/pull/42';
  const env = { ...f.env, REPORT_OVERRIDE: JSON.stringify({ prUrl, approvals: null }) };
  assert.equal(await f.run(['--execute', '--publish', '--auto-merge', '--issue', 'TEST-1'], { env }), 2);
  const journal = JSON.parse(f.output.at(-1));
  assert.equal(journal.outcome, 'blocked');
  assert.equal(journal.cycles[0].result.outcome, 'ready');
  assert.equal(journal.prUrl, prUrl);
  assert.equal(journal.delivery.state, 'blocked');
  assert.match(journal.summary, /do not reselect/);
  assert.ok(!f.calls().some(call => call[0] === 'gh' && call.includes('merge')));
});

test('runner ready in auto-merge mode requires verified merged delivery', async t => {
  const f = fixture(t);
  authorizeDelivery(f, 'runner');
  const sha = 'a'.repeat(40), mergeSha = 'b'.repeat(40);
  const prUrl = 'https://github.com/fumbleforce/stockapp/pull/42';
  const approvals = Object.fromEntries(['tester', 'reviewer', 'pm'].map(role => [role,
    { verdict: role === 'tester' ? 'PASS' : 'APPROVE', headSha: sha, sessionId: role }]));
  let merged = false;
  const deliveryExec = async (bin, args) => {
    if (bin === 'git') {
      if (args[2] === 'rev-parse') return sha;
      if (args[2] === 'branch') return f.journals()[0].branch;
      return '';
    }
    if (args[1] === 'checks') {
      assert.ok(!args.includes('--required'));
      return JSON.stringify([{ name: 'Agent verification', bucket: 'pass', state: 'SUCCESS' }]);
    }
    if (args[1] === 'merge') { merged = true; return ''; }
    return JSON.stringify({ url: prUrl, state: merged ? 'MERGED' : 'OPEN', isDraft: false, baseRefName: 'master',
      headRefName: f.journals()[0].branch, headRefOid: sha, headRepository: { name: 'stockapp' },
      headRepositoryOwner: { login: 'fumbleforce' }, isCrossRepository: false, mergeStateStatus: 'CLEAN',
      mergeable: 'MERGEABLE', mergeCommit: merged ? { oid: mergeSha } : null });
  };
  assert.equal(await f.run(['--execute', '--publish', '--auto-merge'], { deliveryExec,
    env: { ...f.env, REPORT_OVERRIDE: JSON.stringify({ prUrl, approvals }) } }), 0);
  const journal = JSON.parse(f.output.at(-1));
  assert.equal(journal.outcome, 'ready');
  assert.equal(journal.delivery.state, 'merged');
  assert.equal(journal.delivery.mergeCommit, mergeSha);
  assert.equal(journal.delivery.checkEnforcement, 'runner');
  assert.equal(journal.delivery.checkSource, 'Configured requiredChecks enforced by runner');
});

test('default dry-run performs version preflight without a model, lock or worktree', async t => {
  const f = fixture(t);
  const before = git(f.root, 'status', '--porcelain=v1', '--untracked-files=all');
  assert.equal(await f.run(), 0);
  assert.equal(fs.existsSync(path.join(f.root, '.agent-team')), false);
  assert.deepEqual(f.calls(), [['--version']]);
  assert.equal(git(f.root, 'status', '--porcelain=v1', '--untracked-files=all'), before);
  assert.equal(git(f.root, 'worktree', 'list', '--porcelain').split('worktree ').length - 1, 1);
  assert.equal(JSON.parse(f.output[0]).baseCommit, f.base);
  const plannedWorktree = JSON.parse(f.output[0]).worktree;
  const hash = createHash('sha256').update(fs.realpathSync(f.root)).digest('hex').slice(0, 12);
  assert.equal(path.dirname(plannedWorktree), path.join(path.dirname(f.root), '.agent-team-worktrees', hash));
  assert.ok(!plannedWorktree.includes('<id>'));
  assert.equal(fs.existsSync(path.join(path.dirname(f.root), '.agent-team-worktrees')), false);
});

test('external worktree cannot resolve a package installed only in primary node_modules', async t => {
  const f = fixture(t);
  const name = 'runner-primary-only-synthetic-package';
  const packageDirectory = path.join(f.root, 'node_modules', name);
  fs.mkdirSync(packageDirectory);
  fs.writeFileSync(path.join(packageDirectory, 'package.json'), JSON.stringify({ name, main: 'index.cjs' }));
  fs.writeFileSync(path.join(packageDirectory, 'index.cjs'), 'module.exports = "synthetic primary-only dependency";');
  assert.equal(createRequire(path.join(f.root, 'probe.cjs')).resolve(name), path.join(packageDirectory, 'index.cjs'));
  assert.equal(await f.run(['--execute']), 0);
  const [journal] = f.journals();
  assert.ok(path.relative(fs.realpathSync(f.root), journal.worktree).startsWith(`..${path.sep}`));
  const hash = createHash('sha256').update(fs.realpathSync(f.root)).digest('hex').slice(0, 12);
  assert.equal(journal.worktree, path.join(path.dirname(f.root), '.agent-team-worktrees', hash, journal.id));
  assert.throws(() => createRequire(path.join(journal.worktree, 'probe.cjs')).resolve(name), { code: 'MODULE_NOT_FOUND' });
  assert.equal(fs.existsSync(path.join(f.root, '.agent-team', 'worktrees')), false);
  const prompt = f.calls().find(args => args[0] === 'run').at(-1);
  assert.match(prompt, /reserve the final 60 seconds/);
  assert.match(prompt, /at most 150 words/);
  assert.match(prompt, /does not extend or change the hard timeout/);
  assert.equal(await f.run(['--status']), 0);
  assert.equal(JSON.parse(f.output.at(-1)).runs[0].worktree, journal.worktree);
});

test('worktree container hashing uses the real project root even through an alias', async t => {
  const f = fixture(t);
  const alias = path.join(path.dirname(f.root), 'project-alias');
  fs.symlinkSync(f.root, alias);
  assert.equal(await f.run(['--project', alias, '--dry-run']), 0);
  const plan = JSON.parse(f.output.at(-1));
  const hash = createHash('sha256').update(fs.realpathSync(f.root)).digest('hex').slice(0, 12);
  assert.equal(plan.root, fs.realpathSync(f.root));
  assert.equal(path.dirname(plan.worktree), path.join(path.dirname(f.root), '.agent-team-worktrees', hash));
});

test('symlinked external containers are rejected without writes or model invocation', async t => {
  for (const level of ['container', 'project-hash']) {
    await t.test(level, async t => {
      const f = fixture(t);
      const container = path.join(path.dirname(f.root), '.agent-team-worktrees');
      const hash = createHash('sha256').update(fs.realpathSync(f.root)).digest('hex').slice(0, 12);
      if (level === 'project-hash') fs.mkdirSync(container);
      const destination = level === 'container' ? container : path.join(container, hash);
      fs.symlinkSync(f.root, destination);
      for (const mode of ['--dry-run', '--execute']) {
        await assert.rejects(f.run([mode]), /symlinks forbidden/);
      }
      assert.equal(fs.existsSync(path.join(f.root, '.agent-team')), false);
      assert.deepEqual(f.calls(), []);
    });
  }
});

test('legacy retained worktrees and journal paths remain unchanged and visible in status', async t => {
  const f = fixture(t);
  const legacyPath = path.join(f.root, '.agent-team', 'worktrees', 'legacy');
  const legacyRun = path.join(f.root, '.agent-team', 'runs', 'legacy');
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  fs.mkdirSync(legacyRun, { recursive: true });
  git(f.root, 'worktree', 'add', '--detach', legacyPath, f.base);
  fs.writeFileSync(path.join(legacyPath, 'tracked.txt'), 'retained legacy work');
  const legacyJournal = JSON.stringify({ id: 'legacy', state: 'ready', worktree: legacyPath });
  fs.writeFileSync(path.join(legacyRun, 'journal.json'), legacyJournal);
  assert.equal(await f.run(['--execute']), 0);
  assert.equal(fs.readFileSync(path.join(legacyRun, 'journal.json'), 'utf8'), legacyJournal);
  assert.equal(fs.readFileSync(path.join(legacyPath, 'tracked.txt'), 'utf8'), 'retained legacy work');
  assert.match(git(f.root, 'worktree', 'list', '--porcelain'), new RegExp(legacyPath));
  assert.equal(await f.run(['--status']), 0);
  const journals = JSON.parse(f.output.at(-1)).runs;
  assert.equal(journals.find(journal => journal.id === 'legacy').worktree, legacyPath);
  assert.ok(path.relative(f.root, journals.find(journal => journal.id !== 'legacy').worktree).startsWith(`..${path.sep}`));
});

test('sensitive filename classification keeps examples and code while excluding secrets, DBs and keys', () => {
  for (const name of ['.env', '.env.local', 'config/live.env', '.secrets', '.secrets.json',
    '.secrets/credentials.txt', 'data/live.db', 'backup/live.sqlite', 'data/live.sqlite3',
    'live.db-wal', 'live.db-shm', 'live.sqlite3-journal', 'live.sqlite.wal',
    '.ssh/id_rsa', 'keys/id_ed25519', 'id_ecdsa_sk', 'ssh_host_rsa_key']) {
    assert.equal(isSensitivePath(name), true, name);
  }
  for (const name of ['.env.example', '.env.sample', '.env.template', 'config/example.env',
    'config/dev.sample.env', 'config/live.env.example', 'database/migrations/001.sql',
    'database/schema.ts', 'keys/id_rsa.pub', 'README.md']) {
    assert.equal(isSensitivePath(name), false, name);
  }
  assert.throws(() => sparsePatterns(['data/new\nline.db']), /Cannot safely sparse-exclude/);
  assert.throws(() => sparsePatterns(['data/new\rline.db']), /Cannot safely sparse-exclude/);
});

test('tracked synthetic secrets stay out of checkout while index and clean baseline are preserved', async t => {
  const f = fixture(t);
  const excluded = ['.env', 'config/live.env', '.env.production', '.secrets.json',
    'database/backup/portis-backup.db', 'database/backup/portis-backup-2.db',
    'data/live.sqlite', 'data/live.sqlite3', 'data/live.db-wal', 'data/live.db-shm',
    'data/live.db-journal', 'keys/id_rsa', 'keys/id_ed25519',
    'spaces and [brackets]/literal*.db', 'question?/live.sqlite', 'back\\slash/.env',
    '#hash/!bang/.env.private', 'tabs\there/.env.private', '.env.trailing ', '.env.secret*'];
  const present = ['.env.example', '.env.sample', '.env.template', 'config/example.env',
    'config/dev.sample.env', '.env.secret.sample', 'database/migrations/001.sql',
    'database/schema.ts', 'keys/id_rsa.pub'];
  const marker = 'SYNTHETIC-PRIVATE-CONTENT-MUST-NOT-APPEAR-IN-RUN-EVIDENCE';
  for (const name of [...excluded, ...present]) {
    fs.mkdirSync(path.dirname(path.join(f.root, name)), { recursive: true });
    fs.writeFileSync(path.join(f.root, name), excluded.includes(name) ? marker : 'safe fixture code/example');
  }
  // Commit only synthetic data and setup so the fake model can require a clean baseline.
  git(f.root, '--literal-pathspecs', 'add', '-f', '--', ...excluded, ...present, ...Object.keys(f.setup));
  git(f.root, '-c', 'user.name=Runner Test', '-c', 'user.email=runner@example.invalid', 'commit', '-qm', 'synthetic sensitive fixtures');
  const sensitiveBase = git(f.root, 'rev-parse', 'HEAD');
  const before = git(f.root, 'status', '--porcelain=v1', '--untracked-files=all');
  assert.equal(await f.run(['--dry-run', '--base', sensitiveBase]), 0);
  const plan = JSON.parse(f.output.at(-1));
  assert.deepEqual([...plan.excludedPaths].sort(), [...excluded].sort());
  assert.match(plan.warnings[0], /will not be materialized/);
  assert.equal(fs.existsSync(path.join(f.root, '.agent-team')), false);
  // Choosing the previous local base must not pick exclusions from current HEAD.
  assert.equal(await f.run(['--dry-run', '--base', f.base]), 0);
  assert.deepEqual(JSON.parse(f.output.at(-1)).excludedPaths, []);
  const env = { ...f.env, EXPECT_ABSENT: JSON.stringify(excluded), EXPECT_PRESENT: JSON.stringify(present),
    EXPECT_CLEAN: '1', AGENT_TEAM_TOKEN: 'synthetic-worker-token' };
  // Observe every Git boundary as well as model startup: a normal initial
  // checkout followed by deletion would fail this guard immediately.
  const bin = path.dirname(f.env.CALLS);
  const gitShim = path.join(bin, 'bin', 'git');
  fs.writeFileSync(gitShim, String.raw`#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
const adding = args[0] === 'worktree' && args[1] === 'add';
if (adding && !args.includes('--no-checkout')) throw new Error('Initial checkout is forbidden');
const worktree = adding ? args.at(-2) : process.cwd();
const inspect = () => {
  if (!worktree.includes('/.agent-team-worktrees/')) return;
  for (const name of JSON.parse(process.env.EXPECT_ABSENT || '[]')) {
    if (fs.existsSync(path.join(worktree, name))) throw new Error('Sensitive path at Git boundary: ' + name);
  }
};
inspect();
const result = spawnSync('git', args, { env: { ...process.env, PATH: process.env.ORIGINAL_PATH }, input: fs.readFileSync(0) });
inspect();
if (adding && result.status === 0 && fs.readdirSync(worktree).some(name => name !== '.git')) {
  throw new Error('Worktree add materialized files before sparse rules');
}
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
process.exit(result.status ?? 1);
`, { mode: 0o755 });
  env.ORIGINAL_PATH = process.env.PATH;
  assert.equal(await f.run(['--execute', '--base', sensitiveBase], { env }), 0, f.output.at(-1));
  const [journal] = f.journals();
  assert.deepEqual([...journal.excludedPaths].sort(), [...excluded].sort());
  assert.match(f.warnings[0], /Preflight warning/);
  assert.ok(!f.warnings[0].includes(marker));
  assert.equal(git(f.root, 'status', '--porcelain=v1', '--untracked-files=all'), before);
  assert.equal(git(journal.worktree, 'diff', '--cached', '--name-only'), '');
  assert.equal(git(journal.worktree, 'diff', '--name-only'), '');
  const skipped = git(journal.worktree, 'ls-files', '-t', '-z').split('\0').filter(Boolean);
  for (const name of excluded) {
    assert.equal(fs.existsSync(path.join(journal.worktree, name)), false, name);
    assert.ok(skipped.includes(`S ${name}`), `skip-worktree bit preserved: ${name}`);
  }
  for (const name of present) assert.ok(fs.existsSync(path.join(journal.worktree, name)), name);
  const runDir = path.join(f.root, '.agent-team', 'runs', journal.id);
  for (const name of ['journal.json', 'events.jsonl', 'stderr.log', 'summary.md']) {
    const evidence = fs.readFileSync(path.join(runDir, name), 'utf8');
    assert.ok(!evidence.includes(marker), name);
    assert.ok(!evidence.includes('synthetic-worker-token'), name);
  }
  assert.match(fs.readFileSync(path.join(runDir, 'stderr.log'), 'utf8'), /Preflight warning/);
  assert.match(fs.readFileSync(path.join(runDir, 'summary.md'), 'utf8'), /portis-backup\.db/);
});

test('unrepresentable sensitive filenames fail before creating a worktree', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'newline\nprivate.db'), 'synthetic only');
  git(f.root, '--literal-pathspecs', 'add', '--', 'newline\nprivate.db');
  git(f.root, '-c', 'user.name=Runner Test', '-c', 'user.email=runner@example.invalid', 'commit', '-qm', 'unrepresentable filename');
  assert.equal(await f.run(['--execute']), 1);
  const [journal] = f.journals();
  assert.match(journal.error, /Cannot safely sparse-exclude/);
  assert.equal(fs.existsSync(journal.worktree), false);
  assert.equal(f.calls().filter(args => args[0] === 'run').length, 0);
});

test('help and status are read only without OpenCode or gh preflight', async t => {
  const f = fixture(t);
  assert.equal(await f.run(['--help']), 0);
  assert.match(f.output[0], /Local Git commit\/ref/);
  assert.equal(await f.run(['--status', '--project', f.root], { cwd: os.tmpdir() }), 0);
  assert.deepEqual(JSON.parse(f.output[1]), { lock: null, runs: [] });
  assert.deepEqual(f.calls(), []);
  assert.equal(fs.existsSync(path.join(f.root, '.agent-team')), false);
});

test('--project selects a target from any cwd and --issue pins selection and result', async t => {
  const f = fixture(t);
  assert.equal(await f.run(['--project', f.root, '--execute', '--issue', 'TEST-1'], { cwd: os.tmpdir() }), 0);
  const prompt = f.calls().find(args => args[0] === 'run').at(-1);
  assert.match(prompt, /ONLY TEST-1/);
  assert.match(prompt, /Do not select or substitute any other issue/);
  assert.match(prompt, /workspace ID matches workspaceId before any writes/);
  assert.equal(JSON.parse(f.output.at(-1)).issue, 'TEST-1');
  assert.equal(await f.run(['--project', f.root, '--execute', '--issue', 'FUM-123'], { cwd: os.tmpdir() }), 1);
  const failed = JSON.parse(f.output.at(-1));
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.issue, 'FUM-123');
  assert.match(failed.error, /substitutions are forbidden/);
});

test('pinned blocked work is a nonzero worker result; pinned idle is invalid', async t => {
  const blocked = fixture(t, ['blocked']);
  assert.equal(await blocked.run(['--execute', '--issue', 'TEST-1']), 2);
  assert.equal(JSON.parse(blocked.output.at(-1)).outcome, 'blocked');
  const idle = fixture(t, ['idle']);
  assert.equal(await idle.run(['--execute', '--issue', 'TEST-1']), 1);
  assert.match(JSON.parse(idle.output.at(-1)).error, /not idle/);
});

test('invalid project identity, unsafe paths and missing files fail before creating state', async t => {
  const mutations = [
    config => { config.version = 2; },
    config => { delete config.name; },
    config => { delete config.workspaceId; },
    config => { delete config.teamId; },
    config => { delete config.projectId; },
    config => { config.instructions = ['/etc/passwd']; },
    config => { config.instructions = ['docs/../AGENTS.md']; },
    config => { config.instructions = ['docs\\instructions.md']; },
    config => { config.instructions = ['.env']; },
    config => { config.instructions = ['.env.instructions.md']; },
    config => { config.instructions = ['.secrets/instructions.md']; },
    config => { config.instructions = ['node_modules/instructions.md']; },
    config => { config.instructions = ['docs/missing.md']; },
    config => { config.charter = 'docs/missing.md'; },
    config => { config.charter = '/etc/passwd'; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    await t.test(String(index + 1), async t => {
      const f = fixture(t);
      const configFile = path.join(f.root, '.agent-team.json');
      const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      mutate(config);
      fs.writeFileSync(configFile, JSON.stringify(config));
      await assert.rejects(f.run(['--execute']), /Invalid|Unsafe|Sensitive artifact|Instruction\/charter|Required file missing/);
      assert.equal(fs.existsSync(path.join(f.root, '.agent-team')), false);
      assert.deepEqual(f.calls(), []);
    });
  }
});

test('optional absent AGENTS and nested configured instruction files are supported', async t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.root, 'AGENTS.md'));
  const configFile = path.join(f.root, '.agent-team.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  fs.mkdirSync(path.join(f.root, 'docs', 'nested', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(f.root, 'docs', 'nested', 'rules', 'team.md'), 'Nested project rules');
  config.instructions.push('docs/nested/rules/team.md');
  fs.writeFileSync(configFile, JSON.stringify(config));
  assert.equal(await f.run(['--execute']), 0);
  const [journal] = f.journals();
  const resolved = JSON.parse(fs.readFileSync(f.env.CONFIG_CAPTURE, 'utf8'));
  assert.ok(resolved.instructions.includes(path.join(journal.worktree, 'docs/nested/rules/team.md')));
  assert.ok(!resolved.instructions.includes(path.join(journal.worktree, 'AGENTS.md')));
  assert.equal(fs.readFileSync(path.join(journal.worktree, 'docs/nested/rules/team.md'), 'utf8'), 'Nested project rules');
});

test('missing shared role and preexisting inline config fail without creating state', async t => {
  const f = fixture(t);
  await assert.rejects(f.run(['--execute'], { env: { ...f.env, OPENCODE_CONFIG_CONTENT: '{}' } }), /Preexisting OPENCODE_CONFIG_CONTENT/);
  fs.unlinkSync(path.join(f.packageDir, 'agents', 'team-developer.md'));
  await assert.rejects(f.run(['--execute']), /Required file missing/);
  assert.equal(fs.existsSync(path.join(f.root, '.agent-team')), false);
  assert.deepEqual(f.calls(), []);
});

test('model environment filters app overrides generically and retains model credentials', () => {
  const source = { AGENT_TEAM_TOKEN: 'synthetic-worker-token', MYNTBASE_DATABASE_URL: 'private', DATABASE_DIR: 'private',
    MYNTBASE_USER_DATA_DIR: 'private', STOCKAPP_CENTRAL_API_BASE_URL: 'private',
    CENTRAL_API_DATABASE_URL: 'private', E2E_FIKEN_LIVE: '1', E2E_OTHER_LIVE: 'true',
    OTHER_DATABASE_URL: 'private', OTHER_USER_DATA_DIR: 'private',
    OPENAI_API_KEY: 'test-token', ANTHROPIC_API_KEY: 'test-token', OPENAI_BASE_URL: 'test-provider',
    OPENCODE_CONFIG: '/existing/config.json', HOME: '/test/home', PATH: '/test/bin' };
  const filtered = modelEnvironment(source, { agent: {} });
  assert.deepEqual(filtered, { E2E_FIKEN_LIVE: '0', E2E_OTHER_LIVE: '0',
    OPENAI_API_KEY: 'test-token', ANTHROPIC_API_KEY: 'test-token', OPENAI_BASE_URL: 'test-provider',
    OPENCODE_CONFIG: '/existing/config.json', HOME: '/test/home', PATH: '/test/bin',
    OPENCODE_CONFIG_CONTENT: '{"agent":{}}' });
  assert.equal(source.E2E_FIKEN_LIVE, '1');
});

test('separate projects run concurrently using the same shared role package', async t => {
  const first = fixture(t, ['hang']);
  const second = fixture(t, ['hang']);
  const firstController = new AbortController();
  const secondController = new AbortController();
  const runs = [first.run(['--execute'], { signal: firstController.signal, timeoutMs: 5_000 }),
    second.run(['--execute'], { packageDir: first.packageDir, signal: secondController.signal, timeoutMs: 5_000 })];
  t.after(() => { firstController.abort(); secondController.abort(); });
  await waitFor(() => fs.existsSync(first.env.PIDS) && fs.existsSync(second.env.PIDS));
  assert.equal(first.journals()[0].state, 'running');
  assert.equal(second.journals()[0].state, 'running');
  firstController.abort('test-finished');
  secondController.abort('test-finished');
  assert.deepEqual(await Promise.all(runs), [130, 130]);
});

test('execute isolates dirty primary work, overlays only setup, retains evidence and worktree', async t => {
  const f = fixture(t);
  const before = git(f.root, 'status', '--porcelain=v1', '--untracked-files=all');
  assert.equal(await f.run(['--execute', '--model', 'fake/model']), 0);
  const [journal] = f.journals();
  assert.equal(journal.state, 'ready');
  assert.equal(journal.cycles[0].state, 'ready');
  assert.equal(journal.baseCommit, f.base);
  assert.equal(git(journal.worktree, 'branch', '--show-current'), journal.branch);
  assert.match(journal.branch, /^agents\//);
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.base);
  assert.equal(git(f.root, 'status', '--porcelain=v1', '--untracked-files=all'), before);
  assert.equal(fs.readFileSync(path.join(journal.worktree, 'tracked.txt'), 'utf8'), 'base contents\n');
  for (const [name, value] of Object.entries(f.setup)) assert.equal(fs.readFileSync(path.join(journal.worktree, name), 'utf8'), value);
  for (const name of ['untracked.txt', '.env', 'node_modules', 'database', 'opencode.json', '.opencode']) assert.equal(fs.existsSync(path.join(journal.worktree, name)), false);
  assert.deepEqual(JSON.parse(f.output.at(-1)), journal);
  assert.equal(journal.outcome, 'ready');
  const config = JSON.parse(fs.readFileSync(f.env.CONFIG_CAPTURE, 'utf8'));
  assert.equal(config.agent['team-coordinator'].prompt, 'Shared generic coordinator prompt');
  assert.equal(config.agent['team-developer'].prompt, 'Shared generic developer prompt');
  assert.equal(config.agent['team-coordinator'].mode, 'primary');
  assert.equal(config.agent['team-developer'].mode, 'subagent');
  assert.deepEqual(config.instructions, ['docs/PRODUCT_CHARTER.md', 'AGENTS.md', '.cursorrules', 'docs/AGENT_TEAM.md'].map(file => path.join(journal.worktree, file)));
  assert.equal(git(journal.worktree, 'check-ignore', resultName), resultName);
  assert.equal(fs.existsSync(path.join(f.root, '.agent-team', 'lock.json')), false);
  const runDir = path.join(f.root, '.agent-team', 'runs', journal.id);
  assert.match(fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8'), /"type":"fake"/);
  assert.match(fs.readFileSync(path.join(runDir, 'stderr.log'), 'utf8'), /fake stderr/);
  assert.match(fs.readFileSync(path.join(runDir, 'summary.md'), 'utf8'), /does not independently prove tests passed/);
  const invocation = f.calls().find(args => args[0] === 'run');
  assert.deepEqual(invocation.slice(0, 10), ['run', '--agent', 'team-coordinator', '--format', 'json', '--auto', '--dir', journal.worktree, '--model', 'fake/model']);
  assert.match(invocation.at(-1), /do NOT commit, push, create a PR/);
  assert.match(invocation.at(-1), /NEVER automatically mark Done/);
  assert.match(invocation.at(-1), /at most TWO repair rounds/);
  assert.match(invocation.at(-1), /projectId/);
});

test('atomic lock excludes a second runner, including apparently stale locks', async t => {
  const f = fixture(t);
  const directory = path.join(f.root, '.agent-team');
  fs.mkdirSync(directory);
  const release = acquireLock(directory, { id: 'first' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'lock.json'), 'utf8')).pid, process.pid);
  assert.throws(() => acquireLock(directory, { id: 'second' }), /lock exists/);
  await assert.rejects(f.run(['--execute']), /lock exists/);
  release();
  fs.writeFileSync(path.join(directory, 'lock.json'), JSON.stringify({ pid: 2147483647 }));
  await assert.rejects(f.run(['--execute']), /stale locks are not automatically removed/);
  assert.equal(fs.existsSync(path.join(directory, 'runs')), false);
});

test('nonzero exits and missing, malformed, extra-field or symlink reports fail and stop', async t => {
  for (const mode of ['fail', 'missing', 'malformed', 'extra', 'symlink']) {
    await t.test(mode, async t => {
      const f = fixture(t, [mode, 'ready']);
      assert.equal(await f.run(['--execute', '--cycles', '3']), 1);
      const [journal] = f.journals();
      assert.equal(journal.state, 'failed');
      assert.equal(journal.cycles.length, 1);
      assert.equal(journal.cycles[0].state, 'failed');
      assert.ok(journal.finishedAt);
      assert.equal(fs.readFileSync(f.env.COUNT, 'utf8'), '1');
      assert.equal(fs.existsSync(journal.worktree), true);
    });
  }
});

test('ready continues up to limit; blocked/idle stop; previous report cannot satisfy next cycle', async t => {
  for (const [modes, expected, state, code] of [
    [['ready'], 3, 'ready', 0], [['ready', 'blocked', 'ready'], 2, 'blocked', 2],
    [['idle', 'ready'], 1, 'idle', 0], [['ready', 'missing'], 2, 'failed', 1],
  ]) {
    await t.test(modes.join(','), async t => {
      const f = fixture(t, modes);
      assert.equal(await f.run(['--execute', '--cycles', '3']), code);
      const [journal] = f.journals();
      assert.equal(journal.state, state);
      assert.equal(journal.cycles.length, expected);
      assert.equal(Number(fs.readFileSync(f.env.COUNT, 'utf8')), expected);
    });
  }
});

test('publish preflights gh authentication and explicitly grants publishing', async t => {
  const f = fixture(t);
  assert.equal(await f.run(['--execute', '--publish']), 0);
  assert.ok(f.calls().some(args => args.join(' ') === 'gh auth status'));
  assert.match(f.calls().find(args => args[0] === 'run').at(-1), /Publishing is explicitly authorized/);
  assert.equal(await f.run(['--execute', '--publish'], { env: { ...f.env, GH_EXIT: '1' } }), 1);
  assert.equal(f.calls().filter(args => args[0] === 'run').length, 1);
  assert.equal(f.journals().filter(journal => journal.state === 'failed').length, 1);
});

test('invalid local base persists a failed preflight with no model invocation', async t => {
  const f = fixture(t);
  assert.equal(await f.run(['--execute', '--base', 'not-a-local-ref']), 1);
  const [journal] = f.journals();
  assert.equal(journal.state, 'failed');
  assert.deepEqual(journal.cycles, []);
  assert.equal(fs.existsSync(journal.worktree), false);
  assert.equal(f.calls().filter(args => args[0] === 'run').length, 0);
});

test('explicit local base works when invoked from a repository subdirectory', async t => {
  const f = fixture(t);
  git(f.root, '-c', 'user.name=Runner Test', '-c', 'user.email=runner@example.invalid', 'commit', '-qm', 'newer local base');
  const head = git(f.root, 'rev-parse', 'HEAD');
  assert.notEqual(head, f.base);
  assert.equal(await f.run(['--execute', '--base', f.base], { cwd: path.join(f.root, 'docs') }), 0);
  const [journal] = f.journals();
  assert.equal(journal.baseCommit, f.base);
  assert.equal(git(journal.worktree, 'rev-parse', 'HEAD'), f.base);
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), head);
});

test('setup overlay rejects symlink files and parents instead of copying private data', async t => {
  for (const name of ['AGENTS.md', 'docs']) {
    await t.test(name, async t => {
      const f = fixture(t);
      const target = path.join(f.root, name);
      fs.rmSync(target, { recursive: true });
      fs.symlinkSync(path.join(f.root, name === 'docs' ? 'database' : '.env'), target);
      await assert.rejects(f.run(['--execute']), /symlinks forbidden/);
      assert.equal(fs.existsSync(path.join(f.root, '.agent-team')), false);
      assert.equal(fs.readFileSync(path.join(f.root, '.env'), 'utf8'), 'SECRET=never-copy');
      assert.equal(f.calls().filter(args => args[0] === 'run').length, 0);
    });
  }
});

test('timeout terminates the detached group including a TERM-resistant descendant', async t => {
  const f = fixture(t, ['hang']);
  const execution = f.run(['--execute', '--cycles', '3'], { timeoutMs: 1_000, graceMs: 150 });
  await waitFor(() => fs.existsSync(f.env.PIDS));
  const pids = JSON.parse(fs.readFileSync(f.env.PIDS, 'utf8'));
  t.after(() => { for (const pid of Object.values(pids)) { try { process.kill(pid, 'SIGKILL'); } catch {} } });
  const [running] = f.journals();
  assert.equal(running.state, 'running');
  assert.equal(running.cycles[0].pid, pids.parent);
  await assert.rejects(f.run(['--execute']), /lock exists/);
  assert.equal(await execution, 1);
  await waitFor(() => Object.values(pids).every(pid => !alive(pid)));
  const [finished] = f.journals();
  assert.equal(finished.cycles[0].reason, 'timeout');
  assert.equal(finished.cycles.length, 1);
  assert.equal(finished.state, 'failed');
});

test('SIGINT and SIGTERM preserve interrupted journals and kill the group', async t => {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    await t.test(signal, async t => {
      const f = fixture(t, ['hang']);
      const child = spawn(process.execPath, [path.join(f.packageDir, 'runner.mjs'), '--project', f.root, '--execute', '--cycles', '2'], { cwd: os.tmpdir(), env: f.env, stdio: 'ignore' });
      const closed = once(child, 'close');
      t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
      await waitFor(() => fs.existsSync(f.env.PIDS));
      const pids = JSON.parse(fs.readFileSync(f.env.PIDS, 'utf8'));
      t.after(() => { for (const pid of Object.values(pids)) { try { process.kill(pid, 'SIGKILL'); } catch {} } });
      child.kill(signal);
      const [code] = await closed;
      assert.equal(code, 130);
      await waitFor(() => Object.values(pids).every(pid => !alive(pid)));
      const [journal] = f.journals();
      assert.equal(journal.state, 'interrupted');
      assert.equal(journal.cycles[0].state, 'interrupted');
      assert.equal(journal.cycles[0].reason, signal);
      assert.equal(journal.cycles.length, 1);
      assert.equal(fs.existsSync(path.join(f.root, '.agent-team', 'lock.json')), false);
    });
  }
});
