import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { packageRoot } from '@agent-team/protocol';

const FILES = ['adapters/hosting/fly/fly.toml', 'adapters/hosting/fly/Dockerfile', 'adapters/hosting/aws/control-plane-user-data.sh'];

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

// An image runs the sources as they are: Node 24, the web app built in its own stage, and every folder the processes read.
test('each image is node:24-slim, builds the web app in a stage and copies what the processes read', () => {
  for (const file of ['adapters/hosting/fly/Dockerfile', 'adapters/hosting/aws/Dockerfile']) {
    const text = readFileSync(path.join(packageRoot(), file), 'utf8');
    assert.deepEqual(text.match(/^FROM .+$/gm), ['FROM node:24-slim AS web', 'FROM node:24-slim'], file);
    assert.match(text, /RUN npm ci && npm run build -w @agent-team\/web/, file);
    const runtime = text.slice(text.lastIndexOf('FROM '));
    for (const folder of ['packages', 'adapters', 'blueprints', 'bin']) assert.match(runtime, new RegExp(`^COPY ${folder} \\./${folder}$`, 'm'), `${file} copies ${folder}`);
    assert.match(runtime, /^COPY --from=web \/app\/packages\/web\/dist \.\/packages\/web\/dist$/m, file);
    // The build stage installs from the lockfile, so every workspace named in package.json has to be there.
    const workspaces = (JSON.parse(readFileSync(path.join(packageRoot(), 'package.json'), 'utf8')) as { workspaces: string[] }).workspaces;
    for (const workspace of workspaces) assert.match(text.slice(0, text.lastIndexOf('FROM ')), new RegExp(`^COPY ${workspace.split('/*')[0]} `, 'm'), `${file} build stage has ${workspace}`);
  }
});
