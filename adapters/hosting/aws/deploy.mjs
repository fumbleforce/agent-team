import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aws as defaultAws } from '../../launcher/ec2.mjs';

// Idempotent AWS deployment of one project's control plane and worker image. Every step looks for
// the resource it would create (by recorded id, then by name or tag) before creating it, records
// what it finds in the deployment object, and calls `save` so a rerun after any failure continues
// where it stopped. The `aws` runner is injectable so the whole plan is testable without an account.
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const STEPS = ['secrets', 'iam', 'network', 'controlPlane', 'image', 'verify'];
const TRUST = JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }] });
const SSM_CORE = 'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore';
const AL2023 = '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64';
const UBUNTU = '/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id';
export const TOOLKIT_REPO = 'https://github.com/fumbleforce/agent-team.git';

// Errors a person can act on: the CLI shows `hint` beneath the message.
export class DeployError extends Error { constructor(message, hint) { super(message); this.hint = hint; } }

const isNotFound = error => /NoSuchEntity|NotFound|does not exist|InvalidGroup\.NotFound|ParameterNotFound|InvalidInstanceID/i.test(error.message);
const region = deployment => ['--region', deployment.aws.region];
const tagSpec = (type, tags) => `ResourceType=${type},Tags=[${Object.entries(tags).map(([k, v]) => `{Key=${k},Value=${v}}`).join(',')}]`;

// Account facts: caller identity, region, default VPC and subnet. Asks through `prompt` only when
// there is no default VPC to fall back on.
export async function discover(deployment, { aws = defaultAws, prompt = null, log = () => {} } = {}) {
  let identity;
  try { identity = await aws(['sts', 'get-caller-identity']); } catch (error) { throw new DeployError('AWS credentials are missing or expired', 'Run `aws login` (or `aws sso login`) and try again.'); }
  deployment.aws.accountId = identity.Account;
  if (!deployment.aws.region) throw new DeployError('No AWS region configured', 'Run `aws configure set region eu-central-1` (or your region) and try again.');
  if (!deployment.aws.vpcId) {
    const vpcs = await aws(['ec2', 'describe-vpcs', ...region(deployment), '--filters', 'Name=is-default,Values=true']);
    deployment.aws.vpcId = vpcs.Vpcs?.[0]?.VpcId ?? null;
  }
  if (!deployment.aws.subnetId && deployment.aws.vpcId) {
    const subnets = await aws(['ec2', 'describe-subnets', ...region(deployment), '--filters', `Name=vpc-id,Values=${deployment.aws.vpcId}`, 'Name=default-for-az,Values=true']);
    deployment.aws.subnetId = subnets.Subnets?.[0]?.SubnetId ?? null;
  }
  if (!deployment.aws.subnetId) {
    if (!prompt) throw new DeployError('No default VPC in this region', 'Rerun interactively and provide a public subnet id, or create a default VPC with `aws ec2 create-default-vpc`.');
    const subnetId = (await prompt('Public subnet id to use (subnet-...)')).trim();
    const subnets = await aws(['ec2', 'describe-subnets', ...region(deployment), '--subnet-ids', subnetId]);
    deployment.aws.subnetId = subnetId; deployment.aws.vpcId = subnets.Subnets[0].VpcId;
  }
  log(`account ${deployment.aws.accountId}, region ${deployment.aws.region}, subnet ${deployment.aws.subnetId}`);
  return deployment;
}

// Secrets: provided values go to Parameter Store once; generated ones are created if absent.
// Values already stored are never overwritten unless `replace` names them.
export async function secrets(deployment, { aws = defaultAws, values = {}, generate, replace = [], log = () => {} } = {}) {
  for (const secret of deployment.secrets) {
    const name = `${deployment.ssmPrefix}/${secret.name}`;
    let exists = false;
    try { await aws(['ssm', 'get-parameter', ...region(deployment), '--name', name]); exists = true; } catch (error) { if (!isNotFound(error)) throw error; }
    if (exists && !replace.includes(secret.name)) { log(`secret ${secret.name} present`); continue; }
    const value = values[secret.name] ?? (secret.generated ? generate() : null);
    if (!value) throw new DeployError(`Secret ${secret.name} is missing`, `Run \`agent-team init ${deployment.projectId}\` to provide the ${secret.purpose}.`);
    await aws(['ssm', 'put-parameter', ...region(deployment), '--name', name, '--type', 'SecureString', '--overwrite', '--value', value]);
    log(`secret ${secret.name} stored`);
  }
  return deployment;
}

async function ensureRole(aws, deployment, name, statements, log) {
  try { await aws(['iam', 'get-role', '--role-name', name]); } catch (error) { if (!isNotFound(error)) throw error; await aws(['iam', 'create-role', '--role-name', name, '--assume-role-policy-document', TRUST]); }
  await aws(['iam', 'put-role-policy', '--role-name', name, '--policy-name', 'agent-team', '--policy-document', JSON.stringify({ Version: '2012-10-17', Statement: statements })]);
  await aws(['iam', 'attach-role-policy', '--role-name', name, '--policy-arn', SSM_CORE]);
  let created = false;
  try { await aws(['iam', 'get-instance-profile', '--instance-profile-name', name]); } catch (error) {
    if (!isNotFound(error)) throw error;
    await aws(['iam', 'create-instance-profile', '--instance-profile-name', name]);
    await aws(['iam', 'add-role-to-instance-profile', '--instance-profile-name', name, '--role-name', name]);
    created = true;
  }
  log(`role ${name} ${created ? 'created' : 'present'}`);
  return created;
}

// Two roles: workers read their secrets, call Bedrock and upload artifacts; the control plane does
// the same and additionally starts and stops worker instances.
export async function iam(deployment, { aws = defaultAws, log = () => {}, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const { accountId, region: reg, roles } = deployment.aws;
  const parameters = { Effect: 'Allow', Action: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'], Resource: `arn:aws:ssm:${reg}:${accountId}:parameter${deployment.ssmPrefix}/*` };
  const shared = [parameters, { Effect: 'Allow', Action: 'kms:Decrypt', Resource: '*' }, { Effect: 'Allow', Action: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'], Resource: '*' }, { Effect: 'Allow', Action: 's3:PutObject', Resource: 'arn:aws:s3:::agent-team-*/*' }];
  const workerCreated = await ensureRole(aws, deployment, roles.worker, shared, log);
  const controlCreated = await ensureRole(aws, deployment, roles.control, [...shared,
    { Effect: 'Allow', Action: ['ec2:RunInstances', 'ec2:TerminateInstances', 'ec2:DescribeInstances', 'ec2:DescribeImages', 'ec2:CreateTags', 'ec2:DescribeSpotPriceHistory'], Resource: '*' },
    { Effect: 'Allow', Action: ['ssm:PutParameter'], Resource: `arn:aws:ssm:${reg}:${accountId}:parameter${deployment.ssmPrefix}/*` },
    { Effect: 'Allow', Action: 'iam:PassRole', Resource: `arn:aws:iam::${accountId}:role/${roles.worker}` }], log);
  // A new instance profile takes a few seconds to become usable by RunInstances.
  if (workerCreated || controlCreated) await sleep(10_000);
  return deployment;
}

// One security group for the control plane and the workers: dashboard from the owner's address,
// coordinator API from inside the group.
export async function network(deployment, { aws = defaultAws, myIp, log = () => {} } = {}) {
  const name = `agent-team-${deployment.projectId}`;
  let sg = deployment.aws.securityGroupId;
  if (!sg) {
    const found = await aws(['ec2', 'describe-security-groups', ...region(deployment), '--filters', `Name=group-name,Values=${name}`, `Name=vpc-id,Values=${deployment.aws.vpcId}`]);
    sg = found.SecurityGroups?.[0]?.GroupId ?? null;
  }
  if (!sg) {
    sg = (await aws(['ec2', 'create-security-group', ...region(deployment), '--group-name', name, '--description', 'agent-team control plane and workers', '--vpc-id', deployment.aws.vpcId])).GroupId;
    await aws(['ec2', 'authorize-security-group-ingress', ...region(deployment), '--group-id', sg, '--protocol', 'tcp', '--port', '4310', '--source-group', sg]);
    log(`security group ${sg} created`);
  } else log(`security group ${sg} present`);
  if (myIp) {
    try { await aws(['ec2', 'authorize-security-group-ingress', ...region(deployment), '--group-id', sg, '--protocol', 'tcp', '--port', '4311', '--cidr', `${myIp}/32`]); log(`dashboard admitted from ${myIp}`); }
    catch (error) { if (!/Duplicate/i.test(error.message)) throw error; }
  }
  deployment.aws.securityGroupId = sg;
  return deployment;
}

// User data for the control-plane host: the shared script with this deployment's values exported
// ahead of it. The launcher options point workers at the host's own private address.
export function controlPlaneUserData(deployment, { template = readFileSync(path.join(HERE, 'control-plane-user-data.sh'), 'utf8') } = {}) {
  const launcher = { kind: 'ec2', options: { region: deployment.aws.region, subnetId: deployment.aws.subnetId, securityGroupId: deployment.aws.securityGroupId, instanceProfile: deployment.aws.roles.worker, ssmPrefix: deployment.ssmPrefix, instanceType: deployment.worker.instanceType, coordinatorUrl: 'http://COORDINATOR_HOST:4310' } };
  const projects = { [deployment.projectId]: { repository: deployment.scm.repository } };
  const quote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
  const head = ['#!/bin/bash',
    `export SSM_PREFIX=${quote(deployment.ssmPrefix)} PROJECTS_JSON=${quote(JSON.stringify(projects))} PM_ENGINE=${quote(deployment.engine.default)} PM_BILLING=${quote(deployment.engine.billing)}`,
    `LAUNCHER_JSON=$(echo ${quote(JSON.stringify(launcher))} | sed "s/COORDINATOR_HOST/$(curl -fs http://169.254.169.254/latest/meta-data/local-ipv4)/"); export LAUNCHER_JSON`];
  return `${head.join('\n')}\n${template.replace(/^#!.*\n/, '')}`;
}

async function instanceState(aws, deployment, id) {
  try { const result = await aws(['ec2', 'describe-instances', ...region(deployment), '--instance-ids', id]); return result.Reservations?.[0]?.Instances?.[0] ?? null; }
  catch (error) { if (isNotFound(error)) return null; throw error; }
}

// The single control-plane host with a persistent data volume. Reuses a running instance when the
// recorded id is still alive; otherwise launches a new one, re-attaching the previous data volume.
export async function controlPlane(deployment, { aws = defaultAws, log = () => {}, instanceType = 't3.small', dataGb = 20 } = {}) {
  let instance = deployment.aws.instanceId ? await instanceState(aws, deployment, deployment.aws.instanceId) : null;
  if (instance && ['running', 'pending'].includes(instance.State?.Name)) {
    log(`control plane ${deployment.aws.instanceId} running`);
  } else {
    if (instance) {
      const volume = instance.BlockDeviceMappings?.find(mapping => mapping.DeviceName === '/dev/xvdf')?.Ebs?.VolumeId;
      if (volume) deployment.aws.dataVolumeId = volume;
    }
    const ami = (await aws(['ssm', 'get-parameter', ...region(deployment), '--name', AL2023])).Parameter.Value;
    const mappings = [{ DeviceName: '/dev/xvda', Ebs: { VolumeSize: 16, VolumeType: 'gp3' } }];
    if (!deployment.aws.dataVolumeId) mappings.push({ DeviceName: '/dev/xvdf', Ebs: { VolumeSize: dataGb, VolumeType: 'gp3', DeleteOnTermination: false } });
    const result = await aws(['ec2', 'run-instances', ...region(deployment), '--image-id', ami, '--instance-type', instanceType, '--subnet-id', deployment.aws.subnetId, '--security-group-ids', deployment.aws.securityGroupId,
      '--iam-instance-profile', `Name=${deployment.aws.roles.control}`, '--associate-public-ip-address', '--user-data', controlPlaneUserData(deployment),
      '--block-device-mappings', JSON.stringify(mappings), '--metadata-options', 'HttpTokens=optional', '--tag-specifications', tagSpec('instance', { Name: `agent-team-${deployment.projectId}`, 'agent-team:project': deployment.projectId, 'agent-team:role': 'control' })]);
    deployment.aws.instanceId = result.Instances[0].InstanceId;
    log(`control plane ${deployment.aws.instanceId} launched`);
    await aws(['ec2', 'wait', 'instance-running', ...region(deployment), '--instance-ids', deployment.aws.instanceId], { timeoutMs: 600_000 });
    if (deployment.aws.dataVolumeId) {
      await aws(['ec2', 'attach-volume', ...region(deployment), '--volume-id', deployment.aws.dataVolumeId, '--instance-id', deployment.aws.instanceId, '--device', '/dev/xvdf']);
      log(`data volume ${deployment.aws.dataVolumeId} re-attached`);
    }
    instance = await instanceState(aws, deployment, deployment.aws.instanceId);
  }
  deployment.aws.publicIp = instance?.PublicIpAddress ?? deployment.aws.publicIp ?? null;
  deployment.aws.privateIp = instance?.PrivateIpAddress ?? deployment.aws.privateIp ?? null;
  const volume = instance?.BlockDeviceMappings?.find(mapping => mapping.DeviceName === '/dev/xvdf')?.Ebs?.VolumeId;
  if (volume) deployment.aws.dataVolumeId = volume;
  return deployment;
}

export function bakeScript(deployment, { template = readFileSync(path.join(HERE, 'worker-bake.sh'), 'utf8'), toolkitRepo = TOOLKIT_REPO, toolkitRef = 'main' } = {}) {
  const tokenVariable = deployment.secrets.find(secret => secret.adapter === deployment.scm.kind)?.name;
  const values = { REGION: deployment.aws.region, SSM_PREFIX: deployment.ssmPrefix, TOOLKIT_REPO: toolkitRepo, TOOLKIT_REF: toolkitRef, PROJECT_HOST: deployment.scm.host, PROJECT_REPO: deployment.scm.repository, TOKEN_VARIABLE: tokenVariable, PROJECT_SETUP: deployment.worker.setup };
  return template.replace(/__([A-Z_]+)__/g, (match, key) => { if (!(key in values)) throw new Error(`Bake template has no value for ${key}`); return values[key]; });
}

// Bakes a worker image: launch a builder from the current Ubuntu LTS, let the bake script run and
// power off, snapshot it, publish the id to Parameter Store and prune older images.
export async function image(deployment, { aws = defaultAws, log = () => {}, keep = 3, now = () => new Date(), volumeGb = 60, toolkitRef = 'main' } = {}) {
  if (deployment.worker.launcher !== 'ec2' || !deployment.worker.amiParameter) { log('worker image not needed for this launcher'); return deployment; }
  const stamp = now().toISOString().replace(/[-:]/g, '').slice(0, 13).replace('T', '-');
  const base = (await aws(['ssm', 'get-parameter', ...region(deployment), '--name', UBUNTU])).Parameter.Value;
  const builder = (await aws(['ec2', 'run-instances', ...region(deployment), '--image-id', base, '--instance-type', deployment.worker.instanceType, '--subnet-id', deployment.aws.subnetId, '--security-group-ids', deployment.aws.securityGroupId,
    '--iam-instance-profile', `Name=${deployment.aws.roles.worker}`, '--associate-public-ip-address', '--block-device-mappings', JSON.stringify([{ DeviceName: '/dev/sda1', Ebs: { VolumeSize: volumeGb, VolumeType: 'gp3', DeleteOnTermination: true } }]),
    '--metadata-options', 'HttpTokens=required,HttpEndpoint=enabled', '--instance-initiated-shutdown-behavior', 'stop', '--user-data', bakeScript(deployment, { toolkitRef }),
    '--tag-specifications', tagSpec('instance', { Name: `agent-team-builder-${deployment.projectId}`, 'agent-team:project': deployment.projectId, 'agent-team:role': 'builder' })])).Instances[0].InstanceId;
  log(`builder ${builder} baking (this takes 10-20 minutes)`);
  await aws(['ec2', 'wait', 'instance-stopped', ...region(deployment), '--instance-ids', builder], { timeoutMs: 3_600_000 });
  const ami = (await aws(['ec2', 'create-image', ...region(deployment), '--instance-id', builder, '--name', `agent-team-worker-${deployment.projectId}-${stamp}`, '--description', `agent-team worker for ${deployment.projectId} built ${stamp}`,
    '--tag-specifications', tagSpec('image', { 'agent-team:project': deployment.projectId, 'agent-team:built': stamp })])).ImageId;
  await aws(['ec2', 'wait', 'image-available', ...region(deployment), '--image-ids', ami], { timeoutMs: 1_800_000 });
  await aws(['ec2', 'terminate-instances', ...region(deployment), '--instance-ids', builder]);
  await aws(['ssm', 'put-parameter', ...region(deployment), '--name', deployment.worker.amiParameter, '--type', 'String', '--overwrite', '--value', ami]);
  deployment.aws.amiId = ami;
  log(`worker image ${ami} published to ${deployment.worker.amiParameter}`);
  const images = (await aws(['ec2', 'describe-images', ...region(deployment), '--owners', 'self', '--filters', `Name=tag:agent-team:project,Values=${deployment.projectId}`])).Images ?? [];
  const old = images.sort((a, b) => a.CreationDate.localeCompare(b.CreationDate)).slice(0, Math.max(0, images.length - keep));
  for (const stale of old) {
    await aws(['ec2', 'deregister-image', ...region(deployment), '--image-id', stale.ImageId]);
    const snapshot = stale.BlockDeviceMappings?.[0]?.Ebs?.SnapshotId;
    if (snapshot) await aws(['ec2', 'delete-snapshot', ...region(deployment), '--snapshot-id', snapshot]);
    log(`pruned ${stale.ImageId}`);
  }
  return deployment;
}

// Polls the dashboard's health route until the control plane answers.
export async function verify(deployment, { fetchImpl = fetch, log = () => {}, attempts = 40, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (!deployment.aws.publicIp) throw new DeployError('Control plane has no public address', 'Check the instance in the EC2 console.');
  const url = `http://${deployment.aws.publicIp}:4311/health`;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { const response = await fetchImpl(url, { signal: AbortSignal.timeout(5000) }); if (response.status === 401 || response.ok) { log('dashboard answering'); return deployment; } } catch {}
    await sleep(15_000);
  }
  throw new DeployError('The control plane did not come up in time', `Inspect with: agent-team logs ${deployment.projectId}`);
}

// Runs the requested steps in order, saving after each.
export async function deploy(deployment, { only = null, skip = [], save = () => {}, log = () => {}, ...options } = {}) {
  const steps = { secrets, iam, network, controlPlane, image, verify };
  await discover(deployment, { ...options, log });
  save(deployment);
  for (const name of STEPS) {
    if ((only && !only.includes(name)) || skip.includes(name)) continue;
    log(`== ${name}`);
    await steps[name](deployment, { ...options, log });
    save(deployment);
  }
  return deployment;
}

// Tears the deployment down. IAM roles and the data volume are only removed when asked for, since
// both are shared across projects or hold the project's memory.
export async function destroy(deployment, { aws = defaultAws, log = () => {}, removeRoles = false, removeData = false, removeSecrets = false } = {}) {
  const instances = (await aws(['ec2', 'describe-instances', ...region(deployment), '--filters', `Name=tag:agent-team:project,Values=${deployment.projectId}`, 'Name=instance-state-name,Values=pending,running,stopping,stopped'])).Reservations?.flatMap(r => r.Instances.map(i => i.InstanceId)) ?? [];
  if (instances.length) { await aws(['ec2', 'terminate-instances', ...region(deployment), '--instance-ids', ...instances]); await aws(['ec2', 'wait', 'instance-terminated', ...region(deployment), '--instance-ids', ...instances], { timeoutMs: 600_000 }); log(`terminated ${instances.join(', ')}`); }
  const images = (await aws(['ec2', 'describe-images', ...region(deployment), '--owners', 'self', '--filters', `Name=tag:agent-team:project,Values=${deployment.projectId}`])).Images ?? [];
  for (const stale of images) { await aws(['ec2', 'deregister-image', ...region(deployment), '--image-id', stale.ImageId]); const snapshot = stale.BlockDeviceMappings?.[0]?.Ebs?.SnapshotId; if (snapshot) await aws(['ec2', 'delete-snapshot', ...region(deployment), '--snapshot-id', snapshot]); }
  if (images.length) log(`removed ${images.length} worker image(s)`);
  if (deployment.worker.amiParameter) { try { await aws(['ssm', 'delete-parameter', ...region(deployment), '--name', deployment.worker.amiParameter]); } catch (error) { if (!isNotFound(error)) throw error; } }
  if (removeData && deployment.aws.dataVolumeId) { await aws(['ec2', 'delete-volume', ...region(deployment), '--volume-id', deployment.aws.dataVolumeId]); log(`deleted data volume ${deployment.aws.dataVolumeId}`); deployment.aws.dataVolumeId = null; }
  if (deployment.aws.securityGroupId) { try { await aws(['ec2', 'delete-security-group', ...region(deployment), '--group-id', deployment.aws.securityGroupId]); log('security group removed'); } catch (error) { if (!isNotFound(error)) throw error; } }
  if (removeSecrets) { for (const secret of deployment.secrets) { try { await aws(['ssm', 'delete-parameter', ...region(deployment), '--name', `${deployment.ssmPrefix}/${secret.name}`]); } catch (error) { if (!isNotFound(error)) throw error; } } log('secrets removed'); }
  if (removeRoles) {
    for (const name of Object.values(deployment.aws.roles)) {
      try {
        await aws(['iam', 'remove-role-from-instance-profile', '--instance-profile-name', name, '--role-name', name]);
        await aws(['iam', 'delete-instance-profile', '--instance-profile-name', name]);
        await aws(['iam', 'detach-role-policy', '--role-name', name, '--policy-arn', SSM_CORE]);
        await aws(['iam', 'delete-role-policy', '--role-name', name, '--policy-name', 'agent-team']);
        await aws(['iam', 'delete-role', '--role-name', name]);
      } catch (error) { if (!isNotFound(error)) throw error; }
    }
    log('roles removed');
  }
  Object.assign(deployment.aws, { instanceId: null, publicIp: null, privateIp: null, amiId: null, securityGroupId: null });
  return deployment;
}

// Reads one secret value for CLI commands that need it (the coordinator token, the password).
export async function readSecret(deployment, name, { aws = defaultAws } = {}) {
  const result = await aws(['ssm', 'get-parameter', ...region(deployment), '--with-decryption', '--name', `${deployment.ssmPrefix}/${name}`]);
  return result.Parameter.Value;
}
