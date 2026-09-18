import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aws as defaultAws } from '../../launcher/ec2.mjs';

// Idempotent AWS deployment of one project's control plane and worker image. Every step looks for
// the resource it would create (by recorded id, then by name or tag) before creating it, records
// what it finds in the deployment object, and calls `save` so a rerun after any failure continues
// where it stopped. The `aws` runner is injectable so the whole plan is testable without an account.
const HERE = path.dirname(fileURLToPath(import.meta.url));
// The network comes before the roles because the control role is limited to the deployment's subnet.
export const STEPS = ['secrets', 'network', 'iam', 'controlPlane', 'image', 'verify'];
const TRUST = JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }] });
const SSM_CORE = 'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore';
const VPC_CIDR = '10.97.0.0/24';
export const EGRESS_PORTS = [80, 443];
export const BOUNDARY_ARN = /^arn:aws[a-z-]*:iam::\d{12}:policy\/[\w+=,.@\/-]{1,512}$/;
const AL2023 = '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64';
const UBUNTU = '/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id';
export const TOOLKIT_REPO = 'https://github.com/fumbleforce/agent-team.git';

// Errors a person can act on: the CLI shows `hint` beneath the message.
export class DeployError extends Error { constructor(message, hint) { super(message); this.hint = hint; } }

const isNotFound = error => /NoSuchEntity|NotFound|does not exist|InvalidGroup\.NotFound|ParameterNotFound|InvalidInstanceID/i.test(error.message);
const region = deployment => ['--region', deployment.aws.region];
// Control-plane secrets sit one level below the prefix, where the worker role is denied and the
// workers' non-recursive read of the prefix never reaches.
export const parameterName = (deployment, secret) => `${deployment.ssmPrefix}/${secret.scope === 'control' ? 'control/' : ''}${secret.name}`;
const tagSpec = (type, tags) => `ResourceType=${type},Tags=[${Object.entries(tags).map(([k, v]) => `{Key=${k},Value=${v}}`).join(',')}]`;

// A VPC of the deployment's own with one public subnet, so agents that run shell commands share no
// network with anything else in the account. Each piece is looked up by the project tag before it
// is created, so a rerun completes a half-built network. The subnet is placed in the data volume's
// zone when one survives from an earlier deployment, because a volume only attaches within its zone.
async function dedicatedNetwork(deployment, { aws, log }) {
  const name = `agent-team-${deployment.projectId}`;
  const tags = type => tagSpec(type, { Name: name, 'agent-team:project': deployment.projectId });
  const mine = `Name=tag:agent-team:project,Values=${deployment.projectId}`;
  let created = false;
  let vpc = (await aws(['ec2', 'describe-vpcs', ...region(deployment), '--filters', mine])).Vpcs?.[0]?.VpcId ?? null;
  if (!vpc) { vpc = (await aws(['ec2', 'create-vpc', ...region(deployment), '--cidr-block', VPC_CIDR, '--tag-specifications', tags('vpc')])).Vpc.VpcId; created = true; }
  let subnet = (await aws(['ec2', 'describe-subnets', ...region(deployment), '--filters', `Name=vpc-id,Values=${vpc}`, mine])).Subnets?.[0]?.SubnetId ?? null;
  if (!subnet) {
    let zone = null;
    if (deployment.aws.dataVolumeId) { try { zone = (await aws(['ec2', 'describe-volumes', ...region(deployment), '--volume-ids', deployment.aws.dataVolumeId])).Volumes?.[0]?.AvailabilityZone ?? null; } catch (error) { if (!isNotFound(error)) throw error; deployment.aws.dataVolumeId = null; } }
    subnet = (await aws(['ec2', 'create-subnet', ...region(deployment), '--vpc-id', vpc, '--cidr-block', VPC_CIDR, ...(zone ? ['--availability-zone', zone] : []), '--tag-specifications', tags('subnet')])).Subnet.SubnetId;
    created = true;
  }
  await aws(['ec2', 'modify-subnet-attribute', ...region(deployment), '--subnet-id', subnet, '--map-public-ip-on-launch']);
  let gateway = (await aws(['ec2', 'describe-internet-gateways', ...region(deployment), '--filters', mine])).InternetGateways?.[0] ?? null;
  if (!gateway) { gateway = (await aws(['ec2', 'create-internet-gateway', ...region(deployment), '--tag-specifications', tags('internet-gateway')])).InternetGateway; created = true; }
  if (!gateway.Attachments?.some(attachment => attachment.VpcId === vpc)) await aws(['ec2', 'attach-internet-gateway', ...region(deployment), '--internet-gateway-id', gateway.InternetGatewayId, '--vpc-id', vpc]);
  const table = (await aws(['ec2', 'describe-route-tables', ...region(deployment), '--filters', `Name=vpc-id,Values=${vpc}`, 'Name=association.main,Values=true'])).RouteTables[0];
  if (!table.Routes?.some(route => route.DestinationCidrBlock === '0.0.0.0/0')) await aws(['ec2', 'create-route', ...region(deployment), '--route-table-id', table.RouteTableId, '--destination-cidr-block', '0.0.0.0/0', '--gateway-id', gateway.InternetGatewayId]);
  Object.assign(deployment.aws, { vpcId: vpc, subnetId: subnet });
  log(`dedicated network ${vpc} ${created ? 'created' : 'present'}`);
}

// Account facts: caller identity and region, and for `network: 'default'` the default VPC and
// subnet. Asks through `prompt` only when there is no default VPC to fall back on.
export async function discover(deployment, { aws = defaultAws, prompt = null, log = () => {} } = {}) {
  let identity;
  try { identity = await aws(['sts', 'get-caller-identity']); } catch (error) { throw new DeployError('AWS credentials are missing or expired', 'Run `aws login` (or `aws sso login`) and try again.'); }
  deployment.aws.accountId = identity.Account;
  if (!deployment.aws.region) throw new DeployError('No AWS region configured', 'Run `aws configure set region eu-central-1` (or your region) and try again.');
  // A dedicated network is created by the network step; discovery only looks, so `init` creates nothing.
  if (deployment.aws.network === 'dedicated') { log(`account ${deployment.aws.accountId}, region ${deployment.aws.region}, dedicated network`); return deployment; }
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
    const name = parameterName(deployment, secret);
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
  const boundary = deployment.aws.permissionsBoundary ?? null;
  let role = null;
  try { role = (await aws(['iam', 'get-role', '--role-name', name])).Role ?? {}; } catch (error) { if (!isNotFound(error)) throw error; }
  if (boundary && !BOUNDARY_ARN.test(boundary)) throw new DeployError(`${boundary} is not a policy ARN`, 'Pass the boundary as arn:aws:iam::<account>:policy/<name>.');
  if (!role) {
    try { await aws(['iam', 'create-role', '--role-name', name, '--assume-role-policy-document', TRUST, ...(boundary ? ['--permissions-boundary', boundary] : [])]); }
    catch (error) {
      if (!boundary && /AccessDenied|not authorized/i.test(error.message)) throw new DeployError(`Creating the role ${name} was denied`, `If this account requires a permissions boundary on new roles, record it with: agent-team init ${deployment.checkout ?? ''} --permissions-boundary arn:aws:iam::<account>:policy/<name>`);
      throw error;
    }
  }
  else if (boundary && role.PermissionsBoundary?.PermissionsBoundaryArn !== boundary) throw new DeployError(`Role ${name} exists without the permissions boundary ${boundary}`, 'Delete the role (agent-team destroy --roles) or attach the boundary as an administrator, then deploy again.');
  await aws(['iam', 'put-role-policy', '--role-name', name, '--policy-name', 'agent-team', '--policy-document', JSON.stringify({ Version: '2012-10-17', Statement: statements })]);
  // Earlier versions attached the managed Session Manager policy, which also reads every parameter in the account.
  const attached = (await aws(['iam', 'list-attached-role-policies', '--role-name', name])).AttachedPolicies ?? [];
  if (attached.some(policy => policy.PolicyArn === SSM_CORE)) { await aws(['iam', 'detach-role-policy', '--role-name', name, '--policy-arn', SSM_CORE]); log(`role ${name}: managed Session Manager policy detached`); }
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

// The inline policies. Model-driven shell commands on a worker can use the worker role, so it holds
// only what a job needs: this project's parameters (never the control plane's), model calls and
// artifact upload. The control plane adds Session Manager for the owner's tunnels and may start
// instances only from this project's images, in this deployment's subnet, carrying this project's
// tag, and stop only instances with that tag. Both deny every parameter outside the prefix outright.
export function rolePolicies(deployment) {
  const { accountId, region: reg, roles, subnetId } = deployment.aws;
  if (!accountId || !reg || !subnetId) throw new DeployError('The account, region and subnet must be known before roles are written', `Run: agent-team deploy ${deployment.projectId}`);
  const own = `arn:aws:ssm:${reg}:${accountId}:parameter${deployment.ssmPrefix}`;
  const ec2 = (type, owner = accountId) => `arn:aws:ec2:${reg}:${owner}:${type}/*`;
  const projectTag = key => ({ StringEquals: { [`${key}/agent-team:project`]: deployment.projectId } });
  const shared = [
    { Effect: 'Allow', Action: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'], Resource: [own, `${own}/*`] },
    { Effect: 'Deny', Action: ['ssm:GetParameter*', 'ssm:PutParameter', 'ssm:DeleteParameter*', 'ssm:LabelParameterVersion'], NotResource: [own, `${own}/*`] },
    { Effect: 'Allow', Action: 'kms:Decrypt', Resource: '*', Condition: { StringEquals: { 'kms:ViaService': `ssm.${reg}.amazonaws.com` }, StringLike: { 'kms:EncryptionContext:PARAMETER_ARN': `${own}/*` } } },
    { Effect: 'Allow', Action: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'], Resource: '*' },
    { Effect: 'Allow', Action: 's3:PutObject', Resource: 'arn:aws:s3:::agent-team-*/*', Condition: { StringEquals: { 's3:ResourceAccount': accountId } } }];
  const worker = [...shared, { Effect: 'Deny', Action: 'ssm:*', Resource: [`${own}/control`, `${own}/control/*`] }];
  const control = [...shared,
    { Effect: 'Allow', Action: ['ssm:UpdateInstanceInformation', 'ssmmessages:CreateControlChannel', 'ssmmessages:CreateDataChannel', 'ssmmessages:OpenControlChannel', 'ssmmessages:OpenDataChannel'], Resource: '*' },
    { Effect: 'Allow', Action: ['ec2:DescribeInstances', 'ec2:DescribeImages', 'ec2:DescribeSpotPriceHistory'], Resource: '*' },
    { Effect: 'Allow', Action: 'ec2:RunInstances', Resource: ec2('instance'), Condition: projectTag('aws:RequestTag') },
    { Effect: 'Allow', Action: 'ec2:RunInstances', Resource: ec2('image', ''), Condition: projectTag('ec2:ResourceTag') },
    { Effect: 'Allow', Action: 'ec2:RunInstances', Resource: [`arn:aws:ec2:${reg}:${accountId}:subnet/${subnetId}`, ec2('snapshot', ''), ...['volume', 'network-interface', 'security-group', 'key-pair', 'spot-instances-request'].map(type => ec2(type))] },
    { Effect: 'Allow', Action: 'ec2:CreateTags', Resource: ec2('instance'), Condition: { StringEquals: { 'ec2:CreateAction': 'RunInstances' } } },
    { Effect: 'Allow', Action: 'ec2:TerminateInstances', Resource: ec2('instance'), Condition: projectTag('aws:ResourceTag') },
    { Effect: 'Allow', Action: 'iam:PassRole', Resource: `arn:aws:iam::${accountId}:role/${roles.worker}`, Condition: { StringEquals: { 'iam:PassedToService': 'ec2.amazonaws.com' } } }];
  return { worker, control };
}

export async function iam(deployment, { aws = defaultAws, log = () => {}, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const policies = rolePolicies(deployment);
  const workerCreated = await ensureRole(aws, deployment, deployment.aws.roles.worker, policies.worker, log);
  const controlCreated = await ensureRole(aws, deployment, deployment.aws.roles.control, policies.control, log);
  // A new instance profile takes a few seconds to become usable by RunInstances.
  if (workerCreated || controlCreated) await sleep(10_000);
  return deployment;
}

// One security group for the control plane and the workers: coordinator API from inside the group.
// The dashboard is reached through a Session Manager tunnel; only `dashboard: 'public'` admits the
// owner's address to its plain-HTTP port.
export async function network(deployment, { aws = defaultAws, myIp, log = () => {} } = {}) {
  if (deployment.aws.network === 'dedicated') await dedicatedNetwork(deployment, { aws, log });
  if (!deployment.aws.vpcId || !deployment.aws.subnetId) throw new DeployError('No network to deploy into', `Run: agent-team init ${deployment.checkout ?? ''}`);
  const name = `agent-team-${deployment.projectId}`;
  let sg = deployment.aws.securityGroupId;
  if (!sg) {
    const found = await aws(['ec2', 'describe-security-groups', ...region(deployment), '--filters', `Name=group-name,Values=${name}`, `Name=vpc-id,Values=${deployment.aws.vpcId}`]);
    sg = found.SecurityGroups?.[0]?.GroupId ?? null;
  }
  if (!sg) { sg = (await aws(['ec2', 'create-security-group', ...region(deployment), '--group-name', name, '--description', 'agent-team control plane and workers', '--vpc-id', deployment.aws.vpcId, '--tag-specifications', tagSpec('security-group', { Name: name, 'agent-team:project': deployment.projectId })])).GroupId; log(`security group ${sg} created`); }
  else log(`security group ${sg} present`);
  // Rules are applied on every run so a group left half-configured by a failure is completed.
  const rule = async (action, ...args) => { try { await aws(['ec2', action, ...region(deployment), '--group-id', sg, ...args]); } catch (error) { if (!/Duplicate|InvalidPermission\.NotFound/i.test(error.message)) throw error; } };
  await rule('authorize-security-group-ingress', '--protocol', 'tcp', '--port', '4310', '--source-group', sg);
  // Outbound: web ports (package registries, the SCM, the tracker, model and cloud APIs) and the
  // coordinator inside the group, instead of the default allow-all.
  await rule('revoke-security-group-egress', '--ip-permissions', JSON.stringify([{ IpProtocol: '-1', IpRanges: [{ CidrIp: '0.0.0.0/0' }] }]));
  for (const port of deployment.aws.egressPorts ?? EGRESS_PORTS) await rule('authorize-security-group-egress', '--ip-permissions', JSON.stringify([{ IpProtocol: 'tcp', FromPort: port, ToPort: port, IpRanges: [{ CidrIp: '0.0.0.0/0' }] }]));
  await rule('authorize-security-group-egress', '--ip-permissions', JSON.stringify([{ IpProtocol: 'tcp', FromPort: 4310, ToPort: 4310, UserIdGroupPairs: [{ GroupId: sg }] }]));
  if (myIp && deployment.aws.dashboard === 'public') { await rule('authorize-security-group-ingress', '--protocol', 'tcp', '--port', '4311', '--cidr', `${myIp}/32`); log(`dashboard admitted from ${myIp}`); }
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
    `export TOOLKIT_REPO=${quote(deployment.toolkit?.repo ?? TOOLKIT_REPO)} TOOLKIT_REF=${quote(deployment.toolkit?.ref ?? 'main')} SSM_PREFIX=${quote(deployment.ssmPrefix)} PROJECTS_JSON=${quote(JSON.stringify(projects))} PM_ENGINE=${quote(deployment.engine.default)} PM_BILLING=${quote(deployment.engine.billing)}`,
    `LAUNCHER_JSON=$(echo ${quote(JSON.stringify(launcher))} | sed "s/COORDINATOR_HOST/$(curl -fs -H "X-aws-ec2-metadata-token: $(curl -fs -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token)" http://169.254.169.254/latest/meta-data/local-ipv4)/"); export LAUNCHER_JSON`];
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
      '--block-device-mappings', JSON.stringify(mappings), '--metadata-options', 'HttpTokens=required,HttpEndpoint=enabled,HttpPutResponseHopLimit=1', '--tag-specifications', tagSpec('instance', { Name: `agent-team-${deployment.projectId}`, 'agent-team:project': deployment.projectId, 'agent-team:role': 'control' })]);
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

export function bakeScript(deployment, { template = readFileSync(path.join(HERE, 'worker-bake.sh'), 'utf8'), toolkitRepo = deployment.toolkit?.repo ?? TOOLKIT_REPO, toolkitRef = deployment.toolkit?.ref ?? 'main' } = {}) {
  const tokenVariable = deployment.secrets.find(secret => secret.adapter === deployment.scm.kind)?.name;
  const provisioning = deployment.worker.provisioning ?? { packages: [], setup: [] };
  const values = { REGION: deployment.aws.region, SSM_PREFIX: deployment.ssmPrefix, TOOLKIT_REPO: toolkitRepo, TOOLKIT_REF: toolkitRef, PROJECT_HOST: deployment.scm.host, PROJECT_REPO: deployment.scm.repository, TOKEN_VARIABLE: tokenVariable, PROJECT_SETUP: deployment.worker.setup,
    ENVIRONMENT_PACKAGES: provisioning.packages.join(' '), ENVIRONMENT_SETUP: provisioning.setup.length ? provisioning.setup.join(' && ') : 'true' };
  return template.replace(/__([A-Z_]+)__/g, (match, key) => { if (!(key in values)) throw new Error(`Bake template has no value for ${key}`); return values[key]; });
}

// Bakes a worker image: launch a builder from the current Ubuntu LTS, let the bake script run and
// power off, snapshot it, publish the id to Parameter Store and prune older images.
export async function image(deployment, { aws = defaultAws, log = () => {}, keep = 3, now = () => new Date(), volumeGb = 60, toolkitRef = deployment.toolkit?.ref ?? 'main' } = {}) {
  if (deployment.worker.launcher !== 'ec2' || !deployment.worker.amiParameter) { log('worker image not needed for this launcher'); return deployment; }
  const stamp = now().toISOString().replace(/[-:]/g, '').slice(0, 13).replace('T', '-');
  const base = (await aws(['ssm', 'get-parameter', ...region(deployment), '--name', UBUNTU])).Parameter.Value;
  const builder = (await aws(['ec2', 'run-instances', ...region(deployment), '--image-id', base, '--instance-type', deployment.worker.instanceType, '--subnet-id', deployment.aws.subnetId, '--security-group-ids', deployment.aws.securityGroupId,
    '--iam-instance-profile', `Name=${deployment.aws.roles.worker}`, '--associate-public-ip-address', '--block-device-mappings', JSON.stringify([{ DeviceName: '/dev/sda1', Ebs: { VolumeSize: volumeGb, VolumeType: 'gp3', DeleteOnTermination: true } }]),
    '--metadata-options', 'HttpTokens=required,HttpEndpoint=enabled,HttpPutResponseHopLimit=1', '--instance-initiated-shutdown-behavior', 'stop', '--user-data', bakeScript(deployment, { toolkitRef }),
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

// Waits until the control plane answers.
export async function verify(deployment, { aws = defaultAws, probe = null, fetchImpl = fetch, log = () => {}, attempts = 40, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (deployment.aws.dashboard !== 'public') {
    // Without a public port the signal is the host registering with Session Manager, which the tunnels need.
    for (let attempt = 0; attempt < attempts; attempt++) {
      const info = await aws(['ssm', 'describe-instance-information', ...region(deployment), '--filters', `Key=InstanceIds,Values=${deployment.aws.instanceId}`]);
      if (info.InstanceInformationList?.[0]?.PingStatus === 'Online') {
        // The agent registers before the services start; `probe` (a tunnelled health request) confirms them.
        if (!probe) { log('control plane reachable through Session Manager'); return deployment; }
        try { await probe(deployment); log('coordinator answering through the tunnel'); return deployment; } catch (error) { if (error instanceof DeployError) throw error; }
      }
      await sleep(15_000);
    }
    throw new DeployError('The control plane did not come up in time', `Inspect with: agent-team logs ${deployment.projectId}`);
  }
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

// Tears the deployment down. The data volume holds the project's memory and the roles may be
// referenced by an account's own IAM tooling, so both are only removed when asked for.
export async function destroy(deployment, { aws = defaultAws, log = () => {}, removeRoles = false, removeData = false, removeSecrets = false } = {}) {
  const instances = (await aws(['ec2', 'describe-instances', ...region(deployment), '--filters', `Name=tag:agent-team:project,Values=${deployment.projectId}`, 'Name=instance-state-name,Values=pending,running,stopping,stopped'])).Reservations?.flatMap(r => r.Instances.map(i => i.InstanceId)) ?? [];
  if (instances.length) { await aws(['ec2', 'terminate-instances', ...region(deployment), '--instance-ids', ...instances]); await aws(['ec2', 'wait', 'instance-terminated', ...region(deployment), '--instance-ids', ...instances], { timeoutMs: 600_000 }); log(`terminated ${instances.join(', ')}`); }
  const images = (await aws(['ec2', 'describe-images', ...region(deployment), '--owners', 'self', '--filters', `Name=tag:agent-team:project,Values=${deployment.projectId}`])).Images ?? [];
  for (const stale of images) { await aws(['ec2', 'deregister-image', ...region(deployment), '--image-id', stale.ImageId]); const snapshot = stale.BlockDeviceMappings?.[0]?.Ebs?.SnapshotId; if (snapshot) await aws(['ec2', 'delete-snapshot', ...region(deployment), '--snapshot-id', snapshot]); }
  if (images.length) log(`removed ${images.length} worker image(s)`);
  if (deployment.worker.amiParameter) { try { await aws(['ssm', 'delete-parameter', ...region(deployment), '--name', deployment.worker.amiParameter]); } catch (error) { if (!isNotFound(error)) throw error; } }
  if (removeData && deployment.aws.dataVolumeId) { await aws(['ec2', 'delete-volume', ...region(deployment), '--volume-id', deployment.aws.dataVolumeId]); log(`deleted data volume ${deployment.aws.dataVolumeId}`); deployment.aws.dataVolumeId = null; }
  if (deployment.aws.securityGroupId) { try { await aws(['ec2', 'delete-security-group', ...region(deployment), '--group-id', deployment.aws.securityGroupId]); log('security group removed'); } catch (error) { if (!isNotFound(error)) throw error; } }
  if (deployment.aws.network === 'dedicated' && deployment.aws.vpcId) {
    const gateways = (await aws(['ec2', 'describe-internet-gateways', ...region(deployment), '--filters', `Name=attachment.vpc-id,Values=${deployment.aws.vpcId}`])).InternetGateways ?? [];
    for (const gateway of gateways) { await aws(['ec2', 'detach-internet-gateway', ...region(deployment), '--internet-gateway-id', gateway.InternetGatewayId, '--vpc-id', deployment.aws.vpcId]); await aws(['ec2', 'delete-internet-gateway', ...region(deployment), '--internet-gateway-id', gateway.InternetGatewayId]); }
    if (deployment.aws.subnetId) await aws(['ec2', 'delete-subnet', ...region(deployment), '--subnet-id', deployment.aws.subnetId]);
    await aws(['ec2', 'delete-vpc', ...region(deployment), '--vpc-id', deployment.aws.vpcId]);
    log(`dedicated network ${deployment.aws.vpcId} removed`);
    Object.assign(deployment.aws, { vpcId: null, subnetId: null });
  }
  if (removeSecrets) { for (const secret of deployment.secrets) { try { await aws(['ssm', 'delete-parameter', ...region(deployment), '--name', parameterName(deployment, secret)]); } catch (error) { if (!isNotFound(error)) throw error; } } log('secrets removed'); }
  if (removeRoles) {
    for (const name of Object.values(deployment.aws.roles)) {
      // Each removal stands alone so a role left half-deleted by an earlier failure is still cleared.
      for (const args of [['remove-role-from-instance-profile', '--instance-profile-name', name, '--role-name', name], ['delete-instance-profile', '--instance-profile-name', name],
        ['detach-role-policy', '--role-name', name, '--policy-arn', SSM_CORE], ['delete-role-policy', '--role-name', name, '--policy-name', 'agent-team'], ['delete-role', '--role-name', name]]) {
        try { await aws(['iam', ...args]); } catch (error) { if (!isNotFound(error)) throw error; }
      }
    }
    log('roles removed');
  }
  Object.assign(deployment.aws, { instanceId: null, publicIp: null, privateIp: null, amiId: null, securityGroupId: null });
  return deployment;
}

// Reads one secret value for CLI commands that need it (the coordinator token, the password).
export async function readSecret(deployment, name, { aws = defaultAws } = {}) {
  const secret = deployment.secrets.find(item => item.name === name) ?? { name };
  const result = await aws(['ssm', 'get-parameter', ...region(deployment), '--with-decryption', '--name', parameterName(deployment, secret)]);
  return result.Parameter.Value;
}
