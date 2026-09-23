import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { detectRepository, packageRepository, parseRemote } from '../shared/repository.ts';
import { chooseLocal, writeLocalConfigs } from './up.ts';

test('local configs use one loopback port, one reused machine token and the two entrypoints only', () => {
  const env = { AGENT_TEAM_CONFIG_DIR: mkdtempSync(path.join(os.tmpdir(), 'agent-team-up-')) };
  const first = writeLocalConfigs({ projectId: 'shop', checkout: '/srv/shop', engine: 'fake', env });
  const coordinator = JSON.parse(readFileSync(first.coordinator, 'utf8'));
  const worker = JSON.parse(readFileSync(first.worker, 'utf8'));
  assert.deepEqual([coordinator.host, coordinator.port, coordinator.storage.kind], ['127.0.0.1', 4310, 'sqlite']);
  assert.equal(coordinator.localOwner.orgName, 'shop', 'the person at this machine owns it and is not asked to sign in');
  assert.ok(coordinator.localOwner.name && /@/.test(coordinator.localOwner.email));
  assert.equal(worker.coordinatorUrl, 'http://127.0.0.1:4310');
  assert.deepEqual(worker.projects, { shop: '/srv/shop' });
  assert.equal(worker.desks, true, 'a team made later without a repository runs on this worker too');
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

test('where the code lives is read from the checkout: its remote first, else package.json, with the remote\'s main branch', () => {
  assert.deepEqual(parseRemote('git+https://github.com/owner/name.git'), { host: 'github.com', repository: 'owner/name' });
  assert.deepEqual(parseRemote('git+ssh://git@gitlab.com/group/sub/project.git'), { host: 'gitlab.com', repository: 'group/sub/project' });
  assert.deepEqual(parseRemote('git://github.com/owner/name'), { host: 'github.com', repository: 'owner/name' });
  assert.deepEqual(packageRepository('owner/name'), { host: 'github.com', repository: 'owner/name' });
  assert.deepEqual(packageRepository('gitlab:group/project'), { host: 'gitlab.com', repository: 'group/project' });
  assert.deepEqual(packageRepository({ type: 'git', url: 'https://github.com/owner/name.git' }), { host: 'github.com', repository: 'owner/name' });
  assert.equal(packageRepository('bitbucket:owner/name'), null);
  assert.equal(packageRepository(undefined), null);

  const checkout = mkdtempSync(path.join(os.tmpdir(), 'agent-team-repo-'));
  const git = (...args: string[]) => spawnSync('git', ['-C', checkout, ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'trunk');
  assert.equal(detectRepository(checkout), null, 'nothing says where it lives');
  writeFileSync(path.join(checkout, 'package.json'), JSON.stringify({ repository: { type: 'git', url: 'git+https://github.com/upstream/shop.git' } }));
  assert.deepEqual(detectRepository(checkout), { scm: { kind: 'github' }, delivery: { repository: 'upstream/shop', baseBranch: 'trunk' } });
  git('remote', 'add', 'origin', 'git@github.com:fork/shop.git');
  assert.deepEqual(detectRepository(checkout)?.delivery.repository, 'fork/shop', 'the remote pushed to wins over what package.json names');
  git('remote', 'set-url', 'origin', 'git@code.example.com:team/shop.git');
  assert.equal(detectRepository(checkout)?.delivery.repository, 'upstream/shop', 'a host no adapter serves is passed over');
});
