import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { blocking, preflight, renderChecks } from './preflight.mjs';
import { normalizeManifest } from './manifest.mjs';

const manifest = normalizeManifest({ version: 2, name: 'Repo', instructions: [], scm: { kind: 'github', repository: 'o/r' }, tracker: { kind: 'github', repository: 'o/r', readyLabel: 'agent:ready' }, engine: { default: 'claude', billing: 'api' }, integrations: [{ kind: 'slack' }] });
const run = (available, versions = {}) => (bin, args) => ({ ok: available.includes(bin), stdout: versions[bin] ?? `${bin} 1.0.0`, stderr: '' });

test('preflight lists every requirement once with a fix, and only required misses block', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'preflight-'));
  try {
    writeFileSync(path.join(dir, '.gitignore'), '.agent-team/\n.agent-team-result.json\n');
    const good = preflight({ checkout: dir, manifest, target: 'local', env: { GH_TOKEN: 't', ANTHROPIC_API_KEY: 'k' }, run: run(['git', 'claude', 'gh', 'npx']), nodeVersion: 'v22.21.1' });
    assert.deepEqual(blocking(good), []);
    assert.ok(good.find(check => check.name === 'Engine access').ok);
    assert.equal(good.find(check => check.name === 'Slack (slack)').ok, false, 'an integration token is optional');
    const bad = preflight({ checkout: dir, manifest, target: 'aws', env: {}, run: run(['git']), nodeVersion: 'v20.0.0' });
    const names = blocking(bad).map(check => check.name);
    assert.deepEqual(names, ['Node.js', 'github token', 'github tracker credential', 'AWS CLI', 'AWS credentials', 'Session Manager plugin']);
    assert.ok(!names.includes('Engine claude'), 'the engine binary is a worker-host concern for the cloud target');
    assert.match(renderChecks(bad), /MISSING  Node.js: v20.0.0\n\s+Install Node 22.21.1 or newer/);
    assert.match(renderChecks(bad), /Export GITHUB_ISSUES_TOKEN, or let GH_TOKEN serve issues too/);
    const missingKey = preflight({ checkout: dir, manifest, target: 'local', env: { GH_TOKEN: 't' }, run: run(['git', 'claude', 'gh']), nodeVersion: 'v22.22.0' });
    assert.match(missingKey.find(check => check.name === 'Engine access').detail, /ANTHROPIC_API_KEY/);
    writeFileSync(path.join(dir, '.gitignore'), '');
    assert.ok(blocking(preflight({ checkout: dir, manifest, target: 'local', env: { GH_TOKEN: 't', ANTHROPIC_API_KEY: 'k' }, run: run(['git', 'claude', 'gh']), nodeVersion: 'v22.21.1' })).some(check => check.name === '.gitignore'));
    assert.deepEqual(preflight({ checkout: dir, manifest: null, run: run(['git']), nodeVersion: 'v22.21.1' }).map(check => check.name), ['Node.js', 'Git', 'Manifest']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
