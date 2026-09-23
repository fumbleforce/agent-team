import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ENTRYPOINTS, packageRoot } from '@agent-team/protocol';
import { createStorage } from '@agent-team/storage';
import { createSecretStore } from '../../../packages/coordinator/src/auth/secretStore.ts';

const cli = (args: string[]) => spawnSync(process.execPath, [path.join(packageRoot(), ENTRYPOINTS.cli), ...args], { encoding: 'utf8' });

// A coordinator moves: its rows, the key its secrets are sealed with and its stored files go to an export folder, and from there into
// another coordinator's empty database, where a key saved before the move still opens.
test('export and import move a coordinator, with its sealed secrets and stored files, and overwrite nothing', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'agent-team-move-')), before = path.join(root, 'before'), after = path.join(root, 'after');
  for (const dir of [before, after]) mkdirSync(dir);
  const config = (dir: string) => { const file = path.join(dir, 'coordinator.json'); writeFileSync(file, JSON.stringify({ storage: { kind: 'sqlite', path: path.join(dir, 'coordinator.sqlite') } })); return file; };
  const storage = await createStorage({ kind: 'sqlite', path: path.join(before, 'coordinator.sqlite') });
  await storage.migrate();
  await createSecretStore({ storage, dataDir: before, env: {}, now: Date.now }).set('LINEAR_API_KEY', 'lin_api_moving_with_me', null);
  await storage.close();
  mkdirSync(path.join(before, 'blobs')); writeFileSync(path.join(before, 'blobs', 'screenshot.png'), 'png-bytes');

  const out = path.join(root, 'export');
  const exported = cli(['export', '--config', config(before), '--out', out]);
  assert.equal(exported.status, 0, exported.stderr);
  assert.ok(existsSync(path.join(out, 'coordinator.sqlite')) && existsSync(path.join(out, 'secret.key')) && existsSync(path.join(out, 'blobs', 'screenshot.png')));
  assert.notEqual(cli(['export', '--config', config(before), '--out', out]).status, 0, 'an export never overwrites');

  const imported = cli(['import', out, '--config', config(after)]);
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(readFileSync(path.join(after, 'blobs', 'screenshot.png'), 'utf8'), 'png-bytes');
  const moved = await createStorage({ kind: 'sqlite', path: path.join(after, 'coordinator.sqlite') });
  try {
    const env: NodeJS.ProcessEnv = {};
    await createSecretStore({ storage: moved, dataDir: after, env, now: Date.now }).load();
    assert.equal(env.LINEAR_API_KEY, 'lin_api_moving_with_me', 'the key saved before the move opens after it');
  } finally { await moved.close(); }
  assert.notEqual(cli(['import', out, '--config', config(after)]).status, 0, 'never into a database with rows');
});
