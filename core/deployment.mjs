import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { normalizeManifest } from './manifest.mjs';
import { scmAdapter } from '../adapters/scm/index.mjs';
import { trackerAdapter } from '../adapters/tracker/index.mjs';
import { engineAdapter } from '../adapters/engine/index.mjs';
import { integrationAdapter } from '../adapters/integration/index.mjs';
import { builtinEnvironments, provisioning } from './environments.mjs';

// A deployment file describes one project's hosted control plane: where the checkout is, which
// cloud resources exist and which secret names the hosts read. It never holds a secret value.
// Everything that can be derived from the project's manifest or the cloud account is derived, so
// the owner only ever provides a checkout path and the credentials.
export const CONFIG_DIR = process.env.AGENT_TEAM_CONFIG_DIR ?? path.join(os.homedir(), '.config', 'agent-team');
export const DEFAULT_SETUP = 'npm ci';
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

export function deploymentPath(projectId, dir = CONFIG_DIR) {
  if (!ID.test(projectId)) throw new Error('Invalid project id');
  return path.join(dir, `${projectId}.json`);
}

// Which secrets a deployment needs, from the adapters the manifest names. Generated secrets are
// created by `init` when missing; provided ones are asked for. `scope: 'control'` marks secrets
// that only the control plane may read; hosting adapters keep them where workers have no access.
export function secretPlan(manifest) {
  const scm = scmAdapter(manifest.scm.kind);
  const tracker = trackerAdapter(manifest.tracker.kind);
  const engine = engineAdapter(manifest.engine.default);
  const plan = [
    { name: 'AGENT_TEAM_TOKEN', generated: true, scope: 'control', purpose: 'coordinator bearer token' },
    { name: 'AGENT_TEAM_DASHBOARD_PASSWORD', generated: true, scope: 'control', purpose: 'dashboard password' },
    // A tracker that shares the SCM's token (the adapter names that SCM) needs no key of its own.
    { name: tracker.API_KEY_VARIABLE, generated: false, purpose: `${tracker.NAME} API key`, adapter: tracker.NAME, ...(tracker.SHARES_TOKEN_WITH === scm.NAME ? { optional: true } : {}) },
    { name: scm.TOKEN_VARIABLE, generated: false, purpose: `${scm.NAME} token able to push branches and open ${scm.CHANGE_NOUN}s`, adapter: scm.NAME }
  ];
  // An engine adapter may declare API_KEY_VARIABLE and the billing modes that need it.
  const engineKey = engine.API_KEY_VARIABLE ?? null;
  if (engineKey && (engine.KEYED_BILLING ?? []).includes(manifest.engine.billing)) plan.push({ name: engineKey, generated: false, purpose: `${manifest.engine.default} API key`, adapter: manifest.engine.default });
  // One credential per connected integration, under the first name its adapter reads.
  for (const integration of manifest.integrations ?? []) {
    const adapter = integrationAdapter(integration.kind);
    const name = adapter.CREDENTIAL_VARIABLES[0] ?? adapter.credentialVariable(integration.name);
    if (!plan.some(entry => entry.name === name)) plan.push({ name, generated: false, optional: true, purpose: `${adapter.TITLE} token for the ${integration.name} integration`, adapter: integration.kind });
  }
  return plan;
}

// Reads the manifest at `checkout` and derives the deployment's fixed facts from it.
export function deriveFromManifest(checkout, manifestOverride = null) {
  const file = path.join(checkout, '.agent-team.json');
  if (!manifestOverride && !existsSync(file)) throw new Error(`No .agent-team.json in ${checkout}; add one before deploying`);
  const manifest = normalizeManifest(manifestOverride ?? JSON.parse(readFileSync(file, 'utf8')));
  const projectId = manifest.queueProjectId ?? manifest.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!ID.test(projectId)) throw new Error('Manifest queueProjectId is not a valid project id');
  const scm = scmAdapter(manifest.scm.kind);
  const host = scm.HOST.replace(/^https?:\/\//, '');
  const prefix = `/agent-team/${projectId}`;
  const ami = manifest.worker.ami ?? `ssm:${prefix}/worker-ami`;
  return {
    projectId, name: manifest.name, checkout: path.resolve(checkout),
    scm: { kind: manifest.scm.kind, repository: manifest.scm.repository, host, cloneUrl: `https://${host}/${manifest.scm.repository}.git`, baseBranch: manifest.scm.baseBranch },
    tracker: { kind: manifest.tracker.kind },
    engine: { default: manifest.engine.default, billing: manifest.engine.billing },
    worker: { launcher: manifest.worker.launcher, instanceType: manifest.worker.instanceType ?? 'c6i.2xlarge', setup: manifest.worker.setup ?? DEFAULT_SETUP, amiParameter: ami.startsWith('ssm:') ? ami.slice(4) : null, ami: ami.startsWith('ssm:') ? null : ami,
      environment: manifest.worker.environment, provisioning: environmentProvisioning(manifest.worker.environment) },
    ssmPrefix: prefix,
    secrets: secretPlan(manifest)
  };
}

// Packages and setup the worker image needs for the project's environment. Built-in
// environments resolve here; a stored custom one is refreshed from the coordinator by
// `agent-team image` when it can reach it, otherwise the image carries only the standard tools.
export function environmentProvisioning(id, stored = null) {
  const environment = stored ?? builtinEnvironments().find(item => item.id === id) ?? null;
  return environment ? provisioning(environment) : { packages: [], setup: [] };
}

export function generateSecret(bytes = 24) { return randomBytes(bytes).toString('base64url'); }

// Shape of the file on disk. `aws` holds account facts and the ids of created resources, filled in
// as deploy progresses so every command is idempotent and resumable. Roles are named per project so
// one project's policy never widens another's. `network: 'dedicated'` keeps the hosts in a VPC of
// their own, `dashboard: 'tunnel'` keeps the dashboard off the internet, and `permissionsBoundary`
// (a policy ARN) is attached to both roles for accounts that require one. `toolkit` names the
// repository and revision the hosts run; null follows the hosting adapter's default branch.
export function newDeployment(derived, { region, hostingKind = 'aws', permissionsBoundary = null, toolkit = null } = {}) {
  return { version: 1, hosting: hostingKind, createdAt: new Date().toISOString(), ...derived, toolkit, aws: { region: region ?? null, accountId: null, vpcId: null, subnetId: null, securityGroupId: null, instanceId: null, publicIp: null, privateIp: null, amiId: null, dataVolumeId: null, network: 'dedicated', dashboard: 'tunnel', permissionsBoundary,
    roles: { control: `agent-team-${derived.projectId.slice(0, 44)}-control`, worker: `agent-team-${derived.projectId.slice(0, 44)}-worker` } } };
}

export function readDeployment(projectId, dir = CONFIG_DIR) {
  const file = deploymentPath(projectId, dir);
  if (!existsSync(file)) return null;
  const deployment = JSON.parse(readFileSync(file, 'utf8'));
  if (deployment.version !== 1 || deployment.projectId !== projectId) throw new Error(`Unreadable deployment file ${file}`);
  return deployment;
}

export function writeDeployment(deployment, dir = CONFIG_DIR) {
  const file = deploymentPath(deployment.projectId, dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(deployment, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
  return file;
}

// Deployment files present in the config directory, for commands run without a project argument.
export function listDeployments(dir = CONFIG_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)).filter(name => ID.test(name));
}
