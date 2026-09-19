import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { packageRoot } from '@agent-team/protocol';

const FILES = ['adapters/hosting/fly/v2/fly.toml', 'adapters/hosting/fly/v2/Dockerfile', 'adapters/hosting/aws/v2/control-plane-user-data.sh'];

// Every hosted target starts an entrypoint that exists, serves one port, and knows nothing of the old dashboard.
test('hosting files point at real entrypoints on the single port', () => {
  for (const file of FILES) {
    const text = readFileSync(path.join(packageRoot(), file), 'utf8');
    assert.ok(!/4311|dashboard|DASHBOARD_PASSWORD|\.mjs/.test(text), file);
    for (const entry of text.match(/adapters\/hosting\/[\w/.-]+\.ts/g) ?? []) assert.ok(existsSync(path.join(packageRoot(), entry)), `${file} -> ${entry}`);
  }
  assert.match(readFileSync(path.join(packageRoot(), FILES[0]!), 'utf8'), /internal_port = 4310/);
  assert.match(readFileSync(path.join(packageRoot(), FILES[2]!), 'utf8'), /setup_24\.x/);
});
