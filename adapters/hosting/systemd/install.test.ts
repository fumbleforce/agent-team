import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { plan } from './install.ts';

test('the plan is two units on one port with a private token that never appears in a unit or a config', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'agent-team-systemd-'));
  const files = plan({ projects: { shop: '/srv/shop' }, engine: 'claude', node: '/usr/bin/node', home, env: { AGENT_TEAM_CONFIG_DIR: path.join(home, 'cfg') }, token: 'secret-token-value-0123456789' });
  const named = Object.fromEntries(files.map(file => [path.basename(file.path), file]));
  assert.deepEqual(Object.keys(named).sort(), ['agent-team-coordinator.service', 'agent-team-worker.service', 'coordinator.json', 'service.env', 'worker.json']);
  assert.equal(named['service.env']!.mode, 0o600);
  for (const file of files.filter(item => path.basename(item.path) !== 'service.env')) assert.ok(!file.content.includes('secret-token-value'), file.path);
  assert.match(named['agent-team-coordinator.service']!.content, /packages.coordinator.src.main\.ts" --config/);
  assert.match(named['agent-team-worker.service']!.content, /After=agent-team-coordinator\.service/);
  assert.equal(JSON.parse(named['coordinator.json']!.content).port, 4310);
  assert.deepEqual(JSON.parse(named['worker.json']!.content).projects, { shop: '/srv/shop' });
  assert.ok(!files.some(file => /4311|dashboard/.test(file.content)));
});
