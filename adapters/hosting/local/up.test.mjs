import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readToken, start, writeConfigs } from './up.mjs';
import { normalizeManifest } from '../../../core/manifest.mjs';

const manifest = normalizeManifest({ version: 2, name: 'Repo', queueProjectId: 'repo', instructions: [], scm: { kind: 'github', repository: 'o/r' }, tracker: { kind: 'github', repository: 'o/r', readyLabel: 'agent:ready' }, engine: { default: 'claude', billing: 'api', model: 'sonnet' } });

test('local configs bind to loopback, share one token and name the trackers with credentials', () => {
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'local-up-'));
  try {
    const local = writeConfigs({ projectId: 'repo', checkout: '/srv/repo', manifest, configDir, token: 'x'.repeat(32), env: { GH_TOKEN: 't' } });
    const read = name => JSON.parse(readFileSync(local.files[name], 'utf8'));
    assert.equal(read('coordinator').host, '127.0.0.1'); assert.deepEqual(read('coordinator').projects, { repo: { repository: 'o/r' } });
    assert.deepEqual(read('worker').projects, { repo: '/srv/repo' }); assert.equal(read('worker').engine, 'claude');
    assert.deepEqual(read('intake').trackers, ['github']);
    assert.equal(read('pm').model, 'sonnet'); assert.equal(read('pm').billing, 'api');
    assert.equal(read('dashboard').coordinatorUrl, 'http://127.0.0.1:4310');
    assert.equal(statSync(local.envFile).mode & 0o777, 0o600);
    assert.equal(readToken('repo', configDir), 'x'.repeat(32));
    assert.equal(readToken('other', configDir), null);
    assert.equal(local.dashboardUrl, 'http://127.0.0.1:4311/');
  } finally { rmSync(configDir, { recursive: true, force: true }); }
});

test('the supervisor starts services in order with the token and stops all when one exits', async () => {
  const spawned = [];
  const spawnImpl = (bin, args, options) => { const child = new EventEmitter(); child.exitCode = null; child.kill = () => { child.exitCode = 143; child.emit('exit', 143); }; spawned.push({ script: path.basename(args[0]), token: options.env.AGENT_TEAM_TOKEN, child }); return child; };
  const files = { coordinator: 'c.json', dashboard: 'd.json', worker: 'w.json', intake: 'i.json', pm: 'p.json' };
  const log = [];
  const services = start({ files, token: 'tok', env: {}, log: line => log.push(line), spawnImpl, withPm: false });
  await services.started;
  assert.deepEqual(spawned.map(item => item.script), ['queue.mjs', 'dashboard.mjs', 'worker.mjs', 'intake.mjs']);
  assert.ok(spawned.every(item => item.token === 'tok'));
  spawned[2].child.exitCode = 1; spawned[2].child.emit('exit', 1);
  await services.finished;
  assert.match(log[0], /worker exited with 1/);
  assert.ok(spawned.every(item => item.child.exitCode !== null), 'every sibling was stopped');
});
