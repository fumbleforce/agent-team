import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { install, parseArgs } from './install-local.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-team-install-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'user home'); const project = path.join(root, 'checkout');
  mkdirSync(home); mkdirSync(project);
  const logs = [];
  const options = { home, project, key: 'myntbase', repository: 'fumbleforce/stockapp',
    toolkit: path.join(root, 'team kit'), nodePath: path.join(root, 'nvm node/bin/node'),
    workerId: 'x3d', existingPath: '/usr/bin:/bin', resolveBinary: name => name === 'opencode' ? '/opt/open code/bin/opencode' : null, log: line => logs.push(line) };
  const configDir = path.join(home, '.config/agent-team'); const unitDir = path.join(home, '.config/systemd/user');
  const read = file => readFileSync(file, 'utf8');
  return { root, home, options, logs, configDir, unitDir, read, run: extra => install({ ...options, install: true, ...extra }) };
}

test('CLI requires all three arguments, rejects unsupported flags, defaults to dry-run', () => {
  const args = ['--project', '/repo', '--key', 'myntbase', '--repository', 'fumbleforce/stockapp'];
  assert.equal(parseArgs(args).install, undefined);
  assert.equal(parseArgs([...args, '--install']).install, true);
  assert.equal(parseArgs([...args, '--dry-run']).install, false);
  for (const invalid of [args.slice(0, 4), [...args, '--home', '/tmp'], [...args, '--replace'], [...args, '--install', '--dry-run'], [...args, '--key', 'other']]) assert.throws(() => parseArgs(invalid));
});

test('engine selection requires that engine on PATH and records the worker default', t => {
  const f = fixture(t);
  assert.equal(parseArgs(['--project', '/repo', '--key', 'k', '--repository', 'o/r', '--engine', 'claude']).engine, 'claude');
  assert.throws(() => parseArgs(['--project', '/repo', '--key', 'k', '--repository', 'o/r', '--engine', 'unknown-engine']), /Unknown engine/);
  assert.throws(() => f.run({ engine: 'claude' }), /Cannot resolve claude/);
  assert.throws(() => f.run({ resolveBinary: () => null }), /Cannot resolve opencode/);
  f.run({ engine: 'claude', resolveBinary: name => name === 'claude' ? '/home/user/.local/bin/claude' : null });
  assert.equal(JSON.parse(f.read(path.join(f.configDir, 'worker.json'))).engine, 'claude');
  assert.match(f.read(path.join(f.configDir, 'service.env')), /PATH=".*\/home\/user\/\.local\/bin:\/usr\/bin:\/bin"/);
  assert.throws(() => f.run({ engine: 'opencode' }), /Conflicting engine/);
});

test('dry-run writes nothing and reports only paths and start commands', t => {
  const f = fixture(t); const result = install(f.options);
  assert.equal(result.installed, false); assert.deepEqual(readdirSync(f.home), []);
  assert.deepEqual(f.logs, [...result.paths, 'systemctl --user daemon-reload', 'systemctl --user start agent-team-coordinator.service agent-team-worker.service agent-team-dashboard.service']);
});

test('private atomic installation is idempotent, paths are quoted, no schedules or token output', t => {
  const f = fixture(t); const result = f.run();
  const envFile = path.join(f.configDir, 'service.env'); const first = f.read(envFile);
  const token = /^AGENT_TEAM_TOKEN=([a-f0-9]{64})\n/.exec(first)[1];
  assert.equal(first, `AGENT_TEAM_TOKEN=${token}\nPATH="${path.dirname(f.options.nodePath)}:/opt/open code/bin:/usr/bin:/bin"\n`);
  const before = result.paths.map(f.read); f.run(); assert.deepEqual(result.paths.map(f.read), before);
  f.run({ existingPath: '/usr/local/bin:/usr/bin' }); assert.ok(f.read(envFile).includes(token));
  assert.ok(!f.logs.join('\n').includes(token));
  for (const file of result.paths) assert.equal(statSync(file).mode & 0o777, 0o600);
  for (const dir of [f.configDir, path.join(f.home, '.local/state/agent-team'), path.join(f.home, '.local/state/agent-team/worker')]) assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(f.configDir).sort(), ['coordinator.json', 'dashboard.json', 'service.env', 'worker.json']);
  assert.deepEqual(readdirSync(f.unitDir).sort(), ['agent-team-coordinator.service', 'agent-team-dashboard.service', 'agent-team-worker.service']);
  assert.deepEqual(JSON.parse(f.read(path.join(f.configDir, 'dashboard.json'))), { host: '127.0.0.1', port: 4311, coordinator: path.join(f.configDir, 'coordinator.json'), worker: path.join(f.configDir, 'worker.json') });
  for (const [role, script] of [['coordinator', 'queue'], ['worker', 'worker'], ['dashboard', 'dashboard']]) {
    const text = f.read(path.join(f.unitDir, `agent-team-${role}.service`));
    assert.ok(text.includes(`ExecStart="${f.options.nodePath}" "${f.options.toolkit}/core/${script}.mjs" --config "${f.configDir}/${role}.json"`));
    assert.ok(text.includes(`WorkingDirectory=${f.options.toolkit}\n`));
    assert.ok(text.includes(`EnvironmentFile=${envFile}\n`));
    assert.ok(text.includes('Environment="AGENT_TEAM_URL=http://127.0.0.1:4310"'));
    assert.ok(!text.includes('[Install]'));
  }
  const coordinator = JSON.parse(f.read(path.join(f.configDir, 'coordinator.json')));
  assert.deepEqual(coordinator, { host: '127.0.0.1', port: 4310, db: path.join(f.home, '.local/state/agent-team/queue.sqlite'), projects: { myntbase: { repository: 'fumbleforce/stockapp' } } });
  const worker = JSON.parse(f.read(path.join(f.configDir, 'worker.json')));
  assert.equal(worker.workerId, 'x3d'); assert.equal(worker.concurrency, 1); assert.equal(worker.projects.myntbase, f.options.project);
});

test('adds registrations preserving other projects and unknown configuration fields', t => {
  const f = fixture(t); f.run();
  const file = path.join(f.configDir, 'coordinator.json'); const config = JSON.parse(f.read(file));
  config.extension = { retained: true }; writeFileSync(file, JSON.stringify(config));
  f.run({ key: 'second', repository: 'example/second' });
  assert.deepEqual(JSON.parse(f.read(file)), { ...config, projects: { ...config.projects, second: { repository: 'example/second' } } });
  assert.deepEqual(JSON.parse(f.read(path.join(f.configDir, 'worker.json'))).projects, { myntbase: f.options.project, second: f.options.project });
});

test('generated units pass systemd validation with a space in the working directory', {
  skip: spawnSync('systemd-analyze', ['--version']).status !== 0
}, t => {
  const f = fixture(t);
  mkdirSync(f.options.toolkit);
  f.run({ nodePath: process.execPath });
  const result = spawnSync('systemd-analyze', ['verify',
    path.join(f.unitDir, 'agent-team-coordinator.service'),
    path.join(f.unitDir, 'agent-team-worker.service')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /ignoring|not absolute|fatal error/i);
});

test('conflicts and foreign or edited units are refused before any writes', t => {
  const f = fixture(t); const result = f.run(); const before = result.paths.map(f.read);
  assert.throws(() => f.run({ repository: 'other/repository' }), /Conflicting project/);
  assert.throws(() => f.run({ project: f.root }), /Conflicting project/);
  assert.deepEqual(result.paths.map(f.read), before);
  const unit = path.join(f.unitDir, 'agent-team-worker.service'); writeFileSync(unit, '# custom service\n');
  assert.throws(() => f.run({ key: 'second' }), /Refusing to replace/);
  assert.equal(f.read(unit), '# custom service\n'); assert.equal(f.read(path.join(f.configDir, 'coordinator.json')), before[1]);
});

test('leaves existing web service and timers untouched', t => {
  const f = fixture(t); mkdirSync(f.unitDir, { recursive: true });
  const names = ['opencode-web.service', 'agent-team-enqueue@myntbase.timer', 'unrelated.timer'];
  for (const name of names) writeFileSync(path.join(f.unitDir, name), `existing ${name}\n`);
  f.run(); f.run();
  for (const name of names) assert.equal(f.read(path.join(f.unitDir, name)), `existing ${name}\n`);
  assert.deepEqual(readdirSync(f.unitDir).sort(), [...names, 'agent-team-coordinator.service', 'agent-team-dashboard.service', 'agent-team-worker.service'].sort());
});

test('rejects symlinked secret ancestors and secret files without touching targets', t => {
  const f = fixture(t); const target = path.join(f.root, 'target'); mkdirSync(target);
  symlinkSync(target, path.join(f.home, '.config'));
  assert.throws(() => f.run(), /Unsafe path/); assert.deepEqual(readdirSync(target), []);
  rmSync(path.join(f.home, '.config')); f.run();
  const secret = path.join(f.configDir, 'service.env'); rmSync(secret);
  const outside = path.join(target, 'secret'); writeFileSync(outside, 'do not read or change'); symlinkSync(outside, secret);
  assert.throws(() => f.run(), /Unsafe path/); assert.equal(f.read(outside), 'do not read or change');
});

test('invalid environment and JSON errors never disclose file contents', t => {
  const f = fixture(t); f.run(); const secret = 'sensitive-existing-content';
  const env = path.join(f.configDir, 'service.env'); const original = f.read(env);
  writeFileSync(env, secret);
  assert.throws(() => f.run(), error => !error.message.includes(secret) && /Unrecognized environment/.test(error.message));
  assert.equal(f.read(env), secret); writeFileSync(env, original);
  writeFileSync(path.join(f.configDir, 'worker.json'), secret);
  assert.throws(() => f.run(), error => !error.message.includes(secret) && /Invalid JSON/.test(error.message));
  assert.ok(!f.logs.join('\n').includes(secret));
});

test('rejects newline injection and escapes systemd specifiers and environment metacharacters', t => {
  const f = fixture(t);
  assert.throws(() => f.run({ existingPath: '/bin\nSECRET=value' }), /control characters/);
  assert.throws(() => f.run({ resolveBinary: () => '/bin/opencode\nother' }), /control characters/);
  assert.deepEqual(readdirSync(f.home), []);
  f.run({ toolkit: '/opt/team %h $cash "quote" \\slash', existingPath: '/bin:$cash:`literal`:"quote":\\slash' });
  const unit = f.read(path.join(f.unitDir, 'agent-team-worker.service'));
  assert.ok(unit.includes('%%h $$cash \\"quote\\" \\\\slash/core/worker.mjs'));
  assert.ok(f.read(path.join(f.configDir, 'service.env')).includes('/bin:\\$cash:\\`literal\\`:\\"quote\\":\\\\slash'));
});
