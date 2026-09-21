import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chooseLocal, writeLocalConfigs } from './up.ts';

test('local configs use one loopback port, one reused machine token and the two entrypoints only', () => {
  const env = { AGENT_TEAM_CONFIG_DIR: mkdtempSync(path.join(os.tmpdir(), 'agent-team-up-')) };
  const first = writeLocalConfigs({ projectId: 'shop', checkout: '/srv/shop', engine: 'fake', env });
  const coordinator = JSON.parse(readFileSync(first.coordinator, 'utf8'));
  const worker = JSON.parse(readFileSync(first.worker, 'utf8'));
  assert.deepEqual([coordinator.host, coordinator.port, coordinator.storage.kind], ['127.0.0.1', 4310, 'sqlite']);
  assert.equal(worker.coordinatorUrl, 'http://127.0.0.1:4310');
  assert.deepEqual(worker.projects, { shop: '/srv/shop' });
  assert.ok(first.machineToken.length >= 24);
  assert.equal(writeLocalConfigs({ projectId: 'shop', checkout: '/srv/shop', engine: 'fake', env }).machineToken, first.machineToken);
});

test('a command that was not told which project means the one set up for this folder, else the only one, else asks', async () => {
  const env = { AGENT_TEAM_CONFIG_DIR: mkdtempSync(path.join(os.tmpdir(), 'agent-team-local-')) };
  assert.equal(await chooseLocal('/somewhere/site', null, env), null);
  const site = writeLocalConfigs({ projectId: 'site', checkout: '/somewhere/site', engine: 'claude', port: 4555, env });
  const only = await chooseLocal('/elsewhere/unrelated', null, env);
  assert.deepEqual([only?.slug, only?.url, only?.machineToken, only?.coordinator], ['site', 'http://127.0.0.1:4555', site.machineToken, site.coordinator]);
  writeLocalConfigs({ projectId: 'shop', checkout: '/somewhere/shop', engine: 'claude', env });
  assert.equal((await chooseLocal('/somewhere/Shop', null, env))?.slug, 'shop');
  assert.equal(await chooseLocal('/elsewhere/unrelated', null, env), null);
  assert.equal((await chooseLocal('/elsewhere/unrelated', async () => 'shop', env))?.slug, 'shop');
});
