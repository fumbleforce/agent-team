import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deriveFromManifest, newDeployment, readDeployment, writeDeployment, listDeployments, secretPlan, generateSecret } from './deployment.mjs';
import { normalizeManifest } from './manifest.mjs';

const v2 = { version: 2, name: 'Example', queueProjectId: 'example', instructions: [], scm: { kind: 'gitlab', repository: 'group/project', baseBranch: 'main' },
  tracker: { kind: 'linear', workspaceId: 'w', workspaceUrl: 'https://t/w', teamId: 't', projectId: 'p', projectUrl: 'https://t/p', readyLabel: 'r' },
  engine: { default: 'claude', billing: 'bedrock' }, worker: { launcher: 'ec2', setup: 'SKIP_INFRA=1 npm run setup' } };
const v1 = { version: 1, name: 'Legacy Thing', instructions: [], workspaceId: 'w', workspaceUrl: 'https://t/w', teamId: 't', projectId: 'p', projectUrl: 'https://t/p', readyLabel: 'r' };

test('derivation reads every fixed fact from the manifest and defaults the image parameter by convention', t => {
  const checkout = mkdtempSync(path.join(os.tmpdir(), 'deploy-derive-')); t.after(() => rmSync(checkout, { recursive: true, force: true }));
  writeFileSync(path.join(checkout, '.agent-team.json'), JSON.stringify(v2));
  const derived = deriveFromManifest(checkout);
  assert.equal(derived.projectId, 'example'); assert.equal(derived.checkout, checkout);
  assert.deepEqual(derived.scm, { kind: 'gitlab', repository: 'group/project', host: 'gitlab.com', cloneUrl: 'https://gitlab.com/group/project.git', baseBranch: 'main' });
  assert.equal(derived.worker.amiParameter, '/agent-team/example/worker-ami'); assert.equal(derived.worker.setup, 'SKIP_INFRA=1 npm run setup');
  assert.deepEqual(derived.secrets.map(secret => secret.name), ['AGENT_TEAM_TOKEN', 'AGENT_TEAM_DASHBOARD_PASSWORD', 'LINEAR_API_KEY', 'GITLAB_TOKEN']);
  assert.deepEqual(derived.secrets.filter(secret => secret.generated).map(secret => secret.name), ['AGENT_TEAM_TOKEN', 'AGENT_TEAM_DASHBOARD_PASSWORD']);
  const legacy = deriveFromManifest(checkout, v1);
  assert.equal(legacy.projectId, 'legacy-thing'); assert.equal(legacy.scm.kind, 'github'); assert.equal(legacy.worker.launcher, 'local'); assert.equal(legacy.worker.setup, 'npm ci');
  assert.equal(secretPlan(normalizeManifest(v1)).find(secret => secret.adapter === 'github').name, 'GH_TOKEN');
  assert.throws(() => deriveFromManifest(path.join(checkout, 'nowhere')), /No \.agent-team\.json/);
  assert.throws(() => deriveFromManifest(checkout, { ...v2, worker: { launcher: 'ec2', setup: '' } }), /worker\.setup/);
});

test('deployment files round-trip with private permissions and never contain secret values', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'deploy-files-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const checkout = mkdtempSync(path.join(os.tmpdir(), 'deploy-derive-')); t.after(() => rmSync(checkout, { recursive: true, force: true }));
  writeFileSync(path.join(checkout, '.agent-team.json'), JSON.stringify(v2));
  const deployment = newDeployment(deriveFromManifest(checkout), { region: 'eu-central-1' });
  assert.equal(deployment.aws.region, 'eu-central-1'); assert.equal(deployment.aws.instanceId, null);
  const file = writeDeployment(deployment, dir);
  assert.equal(statSync(file).mode & 0o777, 0o600); assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.deepEqual(readDeployment('example', dir), deployment);
  assert.equal(readDeployment('other', dir), null);
  assert.deepEqual(listDeployments(dir), ['example']);
  assert.deepEqual(listDeployments(path.join(dir, 'missing')), []);
  assert.throws(() => readDeployment('../etc', dir), /Invalid project id/);
  const secret = generateSecret();
  assert.ok(secret.length >= 30 && !JSON.stringify(deployment).includes(secret));
});
