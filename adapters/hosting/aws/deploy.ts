import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Idempotent AWS deployment of one project's control plane and worker image. Every step looks for
// the resource it would create (by recorded id, then by name or tag) before creating it, records
// what it finds in the deployment object, and calls `save` so a rerun after any failure continues
// where it stopped. The `aws` runner is injectable so the whole plan is testable without an account.
const HERE = import.meta.dirname;
// The shell templates run on a Linux host, so they are read with LF endings whatever the checkout
// did to them: a CRLF `#!/bin/bash` would fail on the instance long after the deploy looked fine.
// Templates handed in by a caller are made LF too, so nothing this file ships carries a carriage return.
const lf = (text: string) => text.replace(/\r\n?/g, '\n');
const shellTemplate = (name: string) => lf(readFileSync(path.join(HERE, name), 'utf8'));
const PORT = 4310;
// The network comes before the roles because the control role is limited to the deployment's subnet.
export const STEPS = ['secrets', 'network', 'iam', 'controlPlane', 'image', 'verify'] as const;
export type Step = typeof STEPS[number];
const TRUST = JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }] });
const SSM_CORE = 'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore';
const VPC_CIDR = '10.97.0.0/24';
export const EGRESS_PORTS = [80, 443];
export const BOUNDARY_ARN = /^arn:aws[a-z-]*:iam::\d{12}:policy\/[\w+=,.@/-]{1,512}$/;
const AL2023 = '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64';
const UBUNTU = '/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id';
export const TOOLKIT_REPO = 'https://github.com/fumbleforce/agent-team.git';

// `scope: 'control'` marks secrets only the control plane may read. A deployment never holds a secret value.
export interface SecretSpec { name: string; generated: boolean; purpose: string; scope?: 'control'; adapter?: string; optional?: boolean }
// What is known about the project before anything exists in the account.
export interface DeploymentFacts {
  projectId: string; name: string; checkout: string | null;
  scm: { kind: string; repository: string; host: string };
  // `lanes` is how much one launched worker runs at once. The default is one working agent per machine: agents share a machine
  // only when a deployment says so, with the cost and isolation figures to justify it.
  worker: { launcher: string; instanceType: string; setup: string; amiParameter: string | null; provisioning?: { packages: string[]; setup: string[] }; lanes?: { work: number; bounded: number; deliver: number } };
  ssmPrefix: string; secrets: SecretSpec[];
}
// `aws` holds account facts and the ids of created resources, filled in as deploy progresses. `network: 'dedicated'`
// keeps the hosts in a VPC of their own; `access: 'tunnel'` keeps the port off the internet.
export interface Deployment extends DeploymentFacts {
  version: 1; hosting: 'aws'; createdAt: string; toolkit: { repo: string; ref: string } | null;
  aws: { region: string | null; accountId: string | null; vpcId: string | null; subnetId: string | null; securityGroupId: string | null; instanceId: string | null; publicIp: string | null; privateIp: string | null;
    amiId: string | null; dataVolumeId: string | null; network: 'dedicated' | 'default'; access: 'tunnel' | 'public'; permissionsBoundary: string | null; egressPorts?: number[]; /* The AWS CLI profile of the account this project deploys into. */ profile?: string | null; roles: { control: string; worker: string } };
}
type AwsResult = any; // The CLI's JSON output, a different shape per command.
export type Aws = (args: string[], options?: { timeoutMs?: number }) => Promise<AwsResult>;
type Log = (line: string) => void;
type Sleep = (ms: number) => Promise<void>;
type Statement = { Effect: 'Allow' | 'Deny'; Action: string | string[]; Resource?: string | string[]; NotResource?: string[]; Condition?: Record<string, Record<string, string>> };
export interface DeployOptions {
  aws?: Aws; log?: Log; sleep?: Sleep; prompt?: ((question: string) => Promise<string>) | null;
  values?: Record<string, string>; generate?: () => string; replace?: string[]; myIp?: string;
  instanceType?: string; dataGb?: number; keep?: number; now?: () => Date; volumeGb?: number; toolkitRef?: string;
  probe?: ((deployment: Deployment) => Promise<void>) | null; fetchImpl?: (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean }>; attempts?: number;
}

// Errors a person can act on: the CLI shows `hint` beneath the message.
export class DeployError extends Error { hint: string; constructor(message: string, hint: string) { super(message); this.hint = hint; } }

export const defaultAws: Aws = (args, { timeoutMs = 60_000 } = {}) => new Promise((resolve, reject) => {
  execFile('aws', [...args, '--output', 'json'], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) return reject(new Error(`aws ${args.slice(0, 2).join(' ')}: ${String(stderr).trim().slice(-400) || error.message}`));
    resolve(stdout.trim() ? JSON.parse(stdout) : {});
  });
});
const defaultSleep: Sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const quiet: Log = () => {};

export function newDeployment(facts: DeploymentFacts, options: { region?: string | null; permissionsBoundary?: string | null; toolkit?: Deployment['toolkit'] } = {}): Deployment {
  const role = (kind: string) => `agent-team-${facts.projectId.slice(0, 44)}-${kind}`;
  return { version: 1, hosting: 'aws', createdAt: new Date().toISOString(), ...facts, toolkit: options.toolkit ?? null,
    aws: { region: options.region ?? null, accountId: null, vpcId: null, subnetId: null, securityGroupId: null, instanceId: null, publicIp: null, privateIp: null, amiId: null, dataVolumeId: null,
      network: 'dedicated', access: 'tunnel', permissionsBoundary: options.permissionsBoundary ?? null, roles: { control: role('control'), worker: role('worker') } } };
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const isNotFound = (error: unknown) => /NoSuchEntity|NotFound|does not exist|InvalidGroup\.NotFound|ParameterNotFound|InvalidInstanceID/i.test(message(error));
const region = (deployment: Deployment) => ['--region', deployment.aws.region ?? ''];
// Control-plane secrets sit one level below the prefix, where the worker role is denied and the
// workers' non-recursive read of the prefix never reaches.
export const parameterName = (deployment: Deployment, secret: Pick<SecretSpec, 'name' | 'scope'>) => `${deployment.ssmPrefix}/${secret.scope === 'control' ? 'control/' : ''}${secret.name}`;
const tagSpec = (type: string, tags: Record<string, string>) => `ResourceType=${type},Tags=[${Object.entries(tags).map(([k, v]) => `{Key=${k},Value=${v}}`).join(',')}]`;
const IMDS = 'HttpTokens=required,HttpEndpoint=enabled,HttpPutResponseHopLimit=1';

// A VPC of the deployment's own with one public subnet, so agents that run shell commands share no
// network with anything else in the account. Each piece is looked up by the project tag before it
// is created, so a rerun completes a half-built network. The subnet is placed in the data volume's
// zone when one survives from an earlier deployment, because a volume only attaches within its zone.
async function dedicatedNetwork(deployment: Deployment, aws: Aws, log: Log) {
  const name = `agent-team-${deployment.projectId}`;
  const tags = (type: string) => tagSpec(type, { Name: name, 'agent-team:project': deployment.projectId });
  const mine = `Name=tag:agent-team:project,Values=${deployment.projectId}`;
  let created = false;
  let vpc: string | null = (await aws(['ec2', 'describe-vpcs', ...region(deployment), '--filters', mine])).Vpcs?.[0]?.VpcId ?? null;
  if (!vpc) { vpc = (await aws(['ec2', 'create-vpc', ...region(deployment), '--cidr-block', VPC_CIDR, '--tag-specifications', tags('vpc')])).Vpc.VpcId as string; created = true; }
  let subnet: string | null = (await aws(['ec2', 'describe-subnets', ...region(deployment), '--filters', `Name=vpc-id,Values=${vpc}`, mine])).Subnets?.[0]?.SubnetId ?? null;
  if (!subnet) {
    let zone: string | null = null;
    if (deployment.aws.dataVolumeId) { try { zone = (await aws(['ec2', 'describe-volumes', ...region(deployment), '--volume-ids', deployment.aws.dataVolumeId])).Volumes?.[0]?.AvailabilityZone ?? null; } catch (error) { if (!isNotFound(error)) throw error; deployment.aws.dataVolumeId = null; } }
    subnet = (await aws(['ec2', 'create-subnet', ...region(deployment), '--vpc-id', vpc, '--cidr-block', VPC_CIDR, ...(zone ? ['--availability-zone', zone] : []), '--tag-specifications', tags('subnet')])).Subnet.SubnetId as string;
    created = true;
  }
  await aws(['ec2', 'modify-subnet-attribute', ...region(deployment), '--subnet-id', subnet, '--map-public-ip-on-launch']);
  let gateway = (await aws(['ec2', 'describe-internet-gateways', ...region(deployment), '--filters', mine])).InternetGateways?.[0] ?? null;
  if (!gateway) { gateway = (await aws(['ec2', 'create-internet-gateway', ...region(deployment), '--tag-specifications', tags('internet-gateway')])).InternetGateway; created = true; }
  if (!gateway.Attachments?.some((attachment: { VpcId: string }) => attachment.VpcId === vpc)) await aws(['ec2', 'attach-internet-gateway', ...region(deployment), '--internet-gateway-id', gateway.InternetGatewayId, '--vpc-id', vpc]);
  const table = (await aws(['ec2', 'describe-route-tables', ...region(deployment), '--filters', `Name=vpc-id,Values=${vpc}`, 'Name=association.main,Values=true'])).RouteTables[0];
  if (!table.Routes?.some((route: { DestinationCidrBlock?: string }) => route.DestinationCidrBlock === '0.0.0.0/0')) await aws(['ec2', 'create-route', ...region(deployment), '--route-table-id', table.RouteTableId, '--destination-cidr-block', '0.0.0.0/0', '--gateway-id', gateway.InternetGatewayId]);
  Object.assign(deployment.aws, { vpcId: vpc, subnetId: subnet });
  log(`dedicated network ${vpc} ${created ? 'created' : 'present'}`);
}

// Account facts: caller identity and region, and for `network: 'default'` the default VPC and
// subnet. Asks through `prompt` only when there is no default VPC to fall back on.
// The customer-managed policies this account already attaches to something as a permissions boundary. An account that
// refuses roles without a boundary has one in use, so this finds it without anybody knowing its ARN. Only reads, and an
// account that does not let the caller list policies simply yields none.
export async function boundariesInUse(aws: Aws = defaultAws): Promise<string[]> {
  try { return ((await aws(['iam', 'list-policies', '--scope', 'Local', '--policy-usage-filter', 'PermissionsBoundary'])).Policies ?? []).map((policy: { Arn: string }) => policy.Arn); }
  catch { return []; }
}

export async function discover(deployment: Deployment, { aws = defaultAws, prompt = null, log = quiet }: DeployOptions = {}) {
  let identity: { Account: string };
  try { identity = await aws(['sts', 'get-caller-identity']); } catch { throw new DeployError('AWS credentials are missing or expired', 'Run `aws login` (or `aws sso login`) and try again.'); }
  deployment.aws.accountId = identity.Account;
  if (!deployment.aws.region) throw new DeployError('No AWS region configured', 'Run `aws configure set region eu-central-1` (or your region) and try again.');
  // A dedicated network is created by the network step; discovery only looks, so `init` creates nothing.
  if (deployment.aws.network === 'dedicated') { log(`account ${deployment.aws.accountId}, region ${deployment.aws.region}, dedicated network`); return deployment; }
  if (!deployment.aws.vpcId) deployment.aws.vpcId = (await aws(['ec2', 'describe-vpcs', ...region(deployment), '--filters', 'Name=is-default,Values=true'])).Vpcs?.[0]?.VpcId ?? null;
  if (!deployment.aws.subnetId && deployment.aws.vpcId) deployment.aws.subnetId = (await aws(['ec2', 'describe-subnets', ...region(deployment), '--filters', `Name=vpc-id,Values=${deployment.aws.vpcId}`, 'Name=default-for-az,Values=true'])).Subnets?.[0]?.SubnetId ?? null;
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
export async function secrets(deployment: Deployment, { aws = defaultAws, values = {}, generate, replace = [], log = quiet }: DeployOptions = {}) {
  for (const secret of deployment.secrets) {
    const name = parameterName(deployment, secret);
    let exists = false;
    try { await aws(['ssm', 'get-parameter', ...region(deployment), '--name', name]); exists = true; } catch (error) { if (!isNotFound(error)) throw error; }
    if (exists && !replace.includes(secret.name)) { log(`secret ${secret.name} present`); continue; }
    const value = values[secret.name] ?? (secret.generated && generate ? generate() : null);
    if (!value && secret.optional) { log(`secret ${secret.name} not provided`); continue; }
    if (!value) throw new DeployError(`Secret ${secret.name} is missing`, `Set ${secret.name} (the ${secret.purpose}) in the environment and run: agent-team deploy aws --apply`);
    await aws(['ssm', 'put-parameter', ...region(deployment), '--name', name, '--type', 'SecureString', '--overwrite', '--value', value]);
    log(`secret ${secret.name} stored`);
  }
  return deployment;
}

async function ensureRole(aws: Aws, deployment: Deployment, name: string, statements: Statement[], log: Log) {
  const boundary = deployment.aws.permissionsBoundary;
  let role: { PermissionsBoundary?: { PermissionsBoundaryArn?: string } } | null = null;
  try { role = (await aws(['iam', 'get-role', '--role-name', name])).Role ?? {}; } catch (error) { if (!isNotFound(error)) throw error; }
  if (boundary && !BOUNDARY_ARN.test(boundary)) throw new DeployError(`${boundary} is not a policy ARN`, 'Pass the boundary as arn:aws:iam::<account>:policy/<name>.');
  if (!role) {
    try { await aws(['iam', 'create-role', '--role-name', name, '--assume-role-policy-document', TRUST, ...(boundary ? ['--permissions-boundary', boundary] : [])]); }
    catch (error) {
      if (!boundary && /AccessDenied|not authorized/i.test(message(error))) throw new DeployError(`Creating the role ${name} was denied`, `If this account requires a permissions boundary on new roles, record it with: agent-team deploy aws --apply --permissions-boundary arn:aws:iam::<account>:policy/<name>`);
      throw error;
    }
  }
  else if (boundary && role.PermissionsBoundary?.PermissionsBoundaryArn !== boundary) throw new DeployError(`Role ${name} exists without the permissions boundary ${boundary}`, 'Delete the role (agent-team destroy aws --yes --roles) or attach the boundary as an administrator, then deploy again.');
  await aws(['iam', 'put-role-policy', '--role-name', name, '--policy-name', 'agent-team', '--policy-document', JSON.stringify({ Version: '2012-10-17', Statement: statements })]);
  // Earlier versions attached the managed Session Manager policy, which also reads every parameter in the account.
  const attached: { PolicyArn: string }[] = (await aws(['iam', 'list-attached-role-policies', '--role-name', name])).AttachedPolicies ?? [];
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
// only what a turn needs: this project's parameters (never the control plane's), model calls and
// artifact upload. The control plane adds Session Manager for the owner's tunnels and may start
// instances only from this project's images, in this deployment's subnet, carrying this project's
// tag, and stop only instances with that tag. Both deny every parameter outside the prefix outright.
export function rolePolicies(deployment: Deployment): { worker: Statement[]; control: Statement[] } {
  const { accountId, region: reg, roles, subnetId } = deployment.aws;
  if (!accountId || !reg || !subnetId) throw new DeployError('The account, region and subnet must be known before roles are written', 'Run: agent-team deploy aws --apply');
  const own = `arn:aws:ssm:${reg}:${accountId}:parameter${deployment.ssmPrefix}`;
  const ec2 = (type: string, owner: string = accountId) => `arn:aws:ec2:${reg}:${owner}:${type}/*`;
  const projectTag = (key: string) => ({ StringEquals: { [`${key}/agent-team:project`]: deployment.projectId } });
  const shared: Statement[] = [
    { Effect: 'Allow', Action: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'], Resource: [own, `${own}/*`] },
    { Effect: 'Deny', Action: ['ssm:GetParameter*', 'ssm:PutParameter', 'ssm:DeleteParameter*', 'ssm:LabelParameterVersion'], NotResource: [own, `${own}/*`] },
    { Effect: 'Allow', Action: 'kms:Decrypt', Resource: '*', Condition: { StringEquals: { 'kms:ViaService': `ssm.${reg}.amazonaws.com` }, StringLike: { 'kms:EncryptionContext:PARAMETER_ARN': `${own}/*` } } },
    { Effect: 'Allow', Action: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'], Resource: '*' },
    { Effect: 'Allow', Action: 's3:PutObject', Resource: 'arn:aws:s3:::agent-team-*/*', Condition: { StringEquals: { 's3:ResourceAccount': accountId } } }];
  const worker: Statement[] = [...shared, { Effect: 'Deny', Action: 'ssm:*', Resource: [`${own}/control`, `${own}/control/*`] }];
  const control: Statement[] = [...shared,
    { Effect: 'Allow', Action: ['ssm:UpdateInstanceInformation', 'ssmmessages:CreateControlChannel', 'ssmmessages:CreateDataChannel', 'ssmmessages:OpenControlChannel', 'ssmmessages:OpenDataChannel'], Resource: '*' },
    { Effect: 'Allow', Action: ['ec2:DescribeInstances', 'ec2:DescribeImages', 'ec2:DescribeSpotPriceHistory'], Resource: '*' },
    { Effect: 'Allow', Action: 'ec2:RunInstances', Resource: ec2('instance'), Condition: projectTag('aws:RequestTag') },
    { Effect: 'Allow', Action: 'ec2:RunInstances', Resource: ec2('image', ''), Condition: projectTag('ec2:ResourceTag') },
    { Effect: 'Allow', Action: 'ec2:RunInstances', Resource: [`arn:aws:ec2:${reg}:${accountId}:subnet/${subnetId}`, ec2('snapshot', ''), ...['volume', 'network-interface', 'security-group', 'key-pair', 'spot-instances-request'].map(type => ec2(type))] },
    { Effect: 'Allow', Action: 'ec2:CreateTags', Resource: ec2('instance'), Condition: { StringEquals: { 'ec2:CreateAction': 'RunInstances' } } },
    { Effect: 'Allow', Action: 'ec2:TerminateInstances', Resource: ec2('instance'), Condition: projectTag('aws:ResourceTag') },
    // The EC2 launcher hands each job's token to its instance through a parameter, never through user data.
    { Effect: 'Allow', Action: ['ssm:PutParameter', 'ssm:DeleteParameter'], Resource: `${own}/jobs/*` },
    { Effect: 'Allow', Action: 'iam:PassRole', Resource: `arn:aws:iam::${accountId}:role/${roles.worker}`, Condition: { StringEquals: { 'iam:PassedToService': 'ec2.amazonaws.com' } } }];
  return { worker, control };
}

export async function iam(deployment: Deployment, { aws = defaultAws, log = quiet, sleep = defaultSleep }: DeployOptions = {}) {
  const policies = rolePolicies(deployment);
  const workerCreated = await ensureRole(aws, deployment, deployment.aws.roles.worker, policies.worker, log);
  const controlCreated = await ensureRole(aws, deployment, deployment.aws.roles.control, policies.control, log);
  // A new instance profile takes a few seconds to become usable by RunInstances.
  if (workerCreated || controlCreated) await sleep(10_000);
  return deployment;
}

// One security group for the control plane and the workers: the coordinator's port from inside the group.
// An owner reaches it through a Session Manager tunnel; only `access: 'public'` admits the owner's address
// to the plain-HTTP port.
export async function network(deployment: Deployment, { aws = defaultAws, myIp, log = quiet }: DeployOptions = {}) {
  if (deployment.aws.network === 'dedicated') await dedicatedNetwork(deployment, aws, log);
  if (!deployment.aws.vpcId || !deployment.aws.subnetId) throw new DeployError('No network to deploy into', 'Run: agent-team deploy aws --apply');
  const name = `agent-team-${deployment.projectId}`;
  let sg = deployment.aws.securityGroupId;
  if (!sg) sg = (await aws(['ec2', 'describe-security-groups', ...region(deployment), '--filters', `Name=group-name,Values=${name}`, `Name=vpc-id,Values=${deployment.aws.vpcId}`])).SecurityGroups?.[0]?.GroupId ?? null;
  if (!sg) { sg = (await aws(['ec2', 'create-security-group', ...region(deployment), '--group-name', name, '--description', 'agent-team control plane and workers', '--vpc-id', deployment.aws.vpcId, '--tag-specifications', tagSpec('security-group', { Name: name, 'agent-team:project': deployment.projectId })])).GroupId as string; log(`security group ${sg} created`); }
  else log(`security group ${sg} present`);
  const group = sg;
  // Rules are applied on every run so a group left half-configured by a failure is completed.
  const rule = async (action: string, ...args: string[]) => { try { await aws(['ec2', action, ...region(deployment), '--group-id', group, ...args]); } catch (error) { if (!/Duplicate|InvalidPermission\.NotFound/i.test(message(error))) throw error; } };
  await rule('authorize-security-group-ingress', '--protocol', 'tcp', '--port', String(PORT), '--source-group', group);
  // Outbound: web ports (package registries, the SCM, the tracker, model and cloud APIs) and the
  // coordinator inside the group, instead of the default allow-all.
  await rule('revoke-security-group-egress', '--ip-permissions', JSON.stringify([{ IpProtocol: '-1', IpRanges: [{ CidrIp: '0.0.0.0/0' }] }]));
  for (const port of deployment.aws.egressPorts ?? EGRESS_PORTS) await rule('authorize-security-group-egress', '--ip-permissions', JSON.stringify([{ IpProtocol: 'tcp', FromPort: port, ToPort: port, IpRanges: [{ CidrIp: '0.0.0.0/0' }] }]));
  await rule('authorize-security-group-egress', '--ip-permissions', JSON.stringify([{ IpProtocol: 'tcp', FromPort: PORT, ToPort: PORT, UserIdGroupPairs: [{ GroupId: group }] }]));
  if (myIp && deployment.aws.access === 'public') { await rule('authorize-security-group-ingress', '--protocol', 'tcp', '--port', String(PORT), '--cidr', `${myIp}/32`); log(`port ${PORT} admitted from ${myIp}`); }
  deployment.aws.securityGroupId = group;
  return deployment;
}

// What the control plane needs to start a worker for queued work: where, from which image, as whom. Known once the network,
// the roles and the image parameter exist; null for a deployment whose workers are not launched by the control plane.
export function launcherSettings(deployment: Deployment): Record<string, unknown> | null {
  if (deployment.worker.launcher !== 'ec2' || !deployment.worker.amiParameter) return null;
  return {
    region: deployment.aws.region, subnetId: deployment.aws.subnetId, securityGroupId: deployment.aws.securityGroupId,
    instanceProfile: deployment.aws.roles.worker, instanceType: deployment.worker.instanceType,
    ami: `ssm:${deployment.worker.amiParameter}`, ssmPrefix: deployment.ssmPrefix, tags: { 'agent-team:project': deployment.projectId },
    workerConfig: { lanes: deployment.worker.lanes ?? { work: 1, bounded: 2, deliver: 1 } },
  };
}

// User data for the control-plane host: the shared script with this deployment's values exported ahead of it.
export function controlPlaneUserData(deployment: Deployment, { template = shellTemplate('control-plane-user-data.sh') }: { template?: string } = {}) {
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  const launcher = launcherSettings(deployment);
  const head = ['#!/bin/bash', `export TOOLKIT_REPO=${quote(deployment.toolkit?.repo ?? TOOLKIT_REPO)} TOOLKIT_REF=${quote(deployment.toolkit?.ref ?? 'main')} SSM_PREFIX=${quote(deployment.ssmPrefix)} LAUNCHER_B64=${quote(launcher ? Buffer.from(JSON.stringify(launcher)).toString('base64') : '')}`];
  return `${head.join('\n')}\n${lf(template).replace(/^#!.*\n/, '')}`;
}

interface Instance { State?: { Name?: string }; PublicIpAddress?: string; PrivateIpAddress?: string; BlockDeviceMappings?: { DeviceName?: string; Ebs?: { VolumeId?: string } }[] }
async function instanceState(aws: Aws, deployment: Deployment, id: string): Promise<Instance | null> {
  try { return (await aws(['ec2', 'describe-instances', ...region(deployment), '--instance-ids', id])).Reservations?.[0]?.Instances?.[0] ?? null; }
  catch (error) { if (isNotFound(error)) return null; throw error; }
}
const dataVolume = (instance: Instance | null) => instance?.BlockDeviceMappings?.find(mapping => mapping.DeviceName === '/dev/xvdf')?.Ebs?.VolumeId;

// The single control-plane host with a persistent data volume. Reuses a running instance when the
// recorded id is still alive; otherwise launches a new one, re-attaching the previous data volume.
export async function controlPlane(deployment: Deployment, { aws = defaultAws, log = quiet, instanceType = 't3.small', dataGb = 20 }: DeployOptions = {}) {
  if (!deployment.aws.subnetId || !deployment.aws.securityGroupId) throw new DeployError('The network must exist before the control plane', 'Run: agent-team deploy aws --apply');
  let instance = deployment.aws.instanceId ? await instanceState(aws, deployment, deployment.aws.instanceId) : null;
  if (instance && ['running', 'pending'].includes(instance.State?.Name ?? '')) log(`control plane ${deployment.aws.instanceId} running`);
  else {
    const previous = dataVolume(instance);
    if (previous) deployment.aws.dataVolumeId = previous;
    const ami: string = (await aws(['ssm', 'get-parameter', ...region(deployment), '--name', AL2023])).Parameter.Value;
    const mappings: object[] = [{ DeviceName: '/dev/xvda', Ebs: { VolumeSize: 16, VolumeType: 'gp3' } }];
    if (!deployment.aws.dataVolumeId) mappings.push({ DeviceName: '/dev/xvdf', Ebs: { VolumeSize: dataGb, VolumeType: 'gp3', DeleteOnTermination: false } });
    const result = await aws(['ec2', 'run-instances', ...region(deployment), '--image-id', ami, '--instance-type', instanceType, '--subnet-id', deployment.aws.subnetId, '--security-group-ids', deployment.aws.securityGroupId,
      '--iam-instance-profile', `Name=${deployment.aws.roles.control}`, '--associate-public-ip-address', '--user-data', controlPlaneUserData(deployment),
      '--block-device-mappings', JSON.stringify(mappings), '--metadata-options', IMDS, '--tag-specifications', tagSpec('instance', { Name: `agent-team-${deployment.projectId}`, 'agent-team:project': deployment.projectId, 'agent-team:role': 'control' })]);
    const id: string = result.Instances[0].InstanceId;
    deployment.aws.instanceId = id;
    log(`control plane ${id} launched`);
    await aws(['ec2', 'wait', 'instance-running', ...region(deployment), '--instance-ids', id], { timeoutMs: 600_000 });
    if (deployment.aws.dataVolumeId) {
      await aws(['ec2', 'attach-volume', ...region(deployment), '--volume-id', deployment.aws.dataVolumeId, '--instance-id', id, '--device', '/dev/xvdf']);
      log(`data volume ${deployment.aws.dataVolumeId} re-attached`);
    }
    instance = await instanceState(aws, deployment, id);
  }
  deployment.aws.publicIp = instance?.PublicIpAddress ?? deployment.aws.publicIp;
  deployment.aws.privateIp = instance?.PrivateIpAddress ?? deployment.aws.privateIp;
  const volume = dataVolume(instance);
  if (volume) deployment.aws.dataVolumeId = volume;
  return deployment;
}

export function bakeScript(deployment: Deployment, { template = shellTemplate('worker-bake.sh'), toolkitRepo = deployment.toolkit?.repo ?? TOOLKIT_REPO, toolkitRef = deployment.toolkit?.ref ?? 'main' }: { template?: string; toolkitRepo?: string; toolkitRef?: string } = {}) {
  const tokenVariable = deployment.secrets.find(secret => secret.adapter === deployment.scm.kind)?.name;
  if (!tokenVariable) throw new DeployError(`No secret holds the ${deployment.scm.kind} token`, `Add a secret with adapter "${deployment.scm.kind}" to the deployment file (agent-team status aws prints its path).`);
  const provisioning = deployment.worker.provisioning ?? { packages: [], setup: [] };
  const values: Record<string, string> = { REGION: deployment.aws.region ?? '', SSM_PREFIX: deployment.ssmPrefix, TOOLKIT_REPO: toolkitRepo, TOOLKIT_REF: toolkitRef, PROJECT_HOST: deployment.scm.host, PROJECT_REPO: deployment.scm.repository, TOKEN_VARIABLE: tokenVariable, PROJECT_SETUP: deployment.worker.setup,
    ENVIRONMENT_PACKAGES: provisioning.packages.join(' '), ENVIRONMENT_SETUP: provisioning.setup.length ? provisioning.setup.join(' && ') : 'true' };
  return lf(template).replace(/__([A-Z_]+)__/g, (_match, key: string) => { const value = values[key]; if (value === undefined) throw new Error(`Bake template has no value for ${key}`); return value; });
}

interface Image { ImageId: string; CreationDate: string; BlockDeviceMappings?: { Ebs?: { SnapshotId?: string } }[] }
const projectImages = async (aws: Aws, deployment: Deployment): Promise<Image[]> => (await aws(['ec2', 'describe-images', ...region(deployment), '--owners', 'self', '--filters', `Name=tag:agent-team:project,Values=${deployment.projectId}`])).Images ?? [];
async function removeImage(aws: Aws, deployment: Deployment, stale: Image) {
  await aws(['ec2', 'deregister-image', ...region(deployment), '--image-id', stale.ImageId]);
  const snapshot = stale.BlockDeviceMappings?.[0]?.Ebs?.SnapshotId;
  if (snapshot) await aws(['ec2', 'delete-snapshot', ...region(deployment), '--snapshot-id', snapshot]);
}

// Bakes a worker image: launch a builder from the current Ubuntu LTS, let the bake script run and
// power off, snapshot it, publish the id to Parameter Store and prune older images.
export async function image(deployment: Deployment, { aws = defaultAws, log = quiet, keep = 3, now = () => new Date(), volumeGb = 60, toolkitRef = deployment.toolkit?.ref ?? 'main' }: DeployOptions = {}) {
  if (deployment.worker.launcher !== 'ec2' || !deployment.worker.amiParameter) { log('worker image not needed for this launcher'); return deployment; }
  if (!deployment.aws.subnetId || !deployment.aws.securityGroupId) throw new DeployError('The network must exist before an image is baked', 'Run: agent-team deploy aws --apply');
  const stamp = now().toISOString().replace(/[-:]/g, '').slice(0, 13).replace('T', '-');
  const base: string = (await aws(['ssm', 'get-parameter', ...region(deployment), '--name', UBUNTU])).Parameter.Value;
  const builder: string = (await aws(['ec2', 'run-instances', ...region(deployment), '--image-id', base, '--instance-type', deployment.worker.instanceType, '--subnet-id', deployment.aws.subnetId, '--security-group-ids', deployment.aws.securityGroupId,
    '--iam-instance-profile', `Name=${deployment.aws.roles.worker}`, '--associate-public-ip-address', '--block-device-mappings', JSON.stringify([{ DeviceName: '/dev/sda1', Ebs: { VolumeSize: volumeGb, VolumeType: 'gp3', DeleteOnTermination: true } }]),
    '--metadata-options', IMDS, '--instance-initiated-shutdown-behavior', 'stop', '--user-data', bakeScript(deployment, { toolkitRef }),
    '--tag-specifications', tagSpec('instance', { Name: `agent-team-builder-${deployment.projectId}`, 'agent-team:project': deployment.projectId, 'agent-team:role': 'builder' })])).Instances[0].InstanceId;
  log(`builder ${builder} baking (this takes 10-20 minutes)`);
  await aws(['ec2', 'wait', 'instance-stopped', ...region(deployment), '--instance-ids', builder], { timeoutMs: 3_600_000 });
  const ami: string = (await aws(['ec2', 'create-image', ...region(deployment), '--instance-id', builder, '--name', `agent-team-worker-${deployment.projectId}-${stamp}`, '--description', `agent-team worker for ${deployment.projectId} built ${stamp}`,
    '--tag-specifications', tagSpec('image', { 'agent-team:project': deployment.projectId, 'agent-team:built': stamp })])).ImageId;
  await aws(['ec2', 'wait', 'image-available', ...region(deployment), '--image-ids', ami], { timeoutMs: 1_800_000 });
  await aws(['ec2', 'terminate-instances', ...region(deployment), '--instance-ids', builder]);
  await aws(['ssm', 'put-parameter', ...region(deployment), '--name', deployment.worker.amiParameter, '--type', 'String', '--overwrite', '--value', ami]);
  deployment.aws.amiId = ami;
  log(`worker image ${ami} published to ${deployment.worker.amiParameter}`);
  const images = await projectImages(aws, deployment);
  for (const stale of images.sort((a, b) => a.CreationDate.localeCompare(b.CreationDate)).slice(0, Math.max(0, images.length - keep))) { await removeImage(aws, deployment, stale); log(`pruned ${stale.ImageId}`); }
  return deployment;
}

// Waits until the control plane answers on its one port.
export async function verify(deployment: Deployment, { aws = defaultAws, probe = null, fetchImpl = fetch, log = quiet, attempts = 40, sleep = defaultSleep }: DeployOptions = {}) {
  const late = new DeployError('The control plane did not come up in time', `Check agent-team status aws, then read journalctl -u agent-team.service in a Session Manager session on ${deployment.aws.instanceId ?? 'the host'}.`);
  if (deployment.aws.access !== 'public') {
    // Without a public port the signal is the host registering with Session Manager, which the tunnels need.
    for (let attempt = 0; attempt < attempts; attempt++) {
      const info = await aws(['ssm', 'describe-instance-information', ...region(deployment), '--filters', `Key=InstanceIds,Values=${deployment.aws.instanceId}`]);
      if (info.InstanceInformationList?.[0]?.PingStatus === 'Online') {
        // The agent registers before the service starts; `probe` (a tunnelled health request) confirms it.
        if (!probe) { log('control plane reachable through Session Manager'); return deployment; }
        try { await probe(deployment); log('coordinator answering through the tunnel'); return deployment; } catch (error) { if (error instanceof DeployError) throw error; }
      }
      await sleep(15_000);
    }
    throw late;
  }
  if (!deployment.aws.publicIp) throw new DeployError('Control plane has no public address', 'Check the instance in the EC2 console.');
  const url = `http://${deployment.aws.publicIp}:${PORT}/health`;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { if ((await fetchImpl(url, { signal: AbortSignal.timeout(5000) })).ok) { log('coordinator answering'); return deployment; } } catch { /* not up yet */ }
    await sleep(15_000);
  }
  throw late;
}

// Runs the requested steps in order, saving after each.
export async function deploy(deployment: Deployment, { only = null, skip = [], save = () => {}, ...options }: DeployOptions & { only?: Step[] | null; skip?: Step[]; save?: (deployment: Deployment) => void } = {}) {
  const steps: Record<Step, (deployment: Deployment, options: DeployOptions) => Promise<Deployment>> = { secrets, iam, network, controlPlane, image, verify };
  const log = options.log ?? quiet;
  await discover(deployment, options);
  save(deployment);
  for (const name of STEPS) {
    if ((only && !only.includes(name)) || skip.includes(name)) continue;
    log(`== ${name}`);
    await steps[name](deployment, options);
    save(deployment);
  }
  return deployment;
}

// Tears the deployment down. The data volume holds the project's database and the roles may be
// referenced by an account's own IAM tooling, so both are only removed when asked for.
export async function destroy(deployment: Deployment, { aws = defaultAws, log = quiet, removeRoles = false, removeData = false, removeSecrets = false }: { aws?: Aws; log?: Log; removeRoles?: boolean; removeData?: boolean; removeSecrets?: boolean } = {}) {
  const ignoreMissing = async (args: string[]) => { try { await aws(args); return true; } catch (error) { if (!isNotFound(error)) throw error; return false; } };
  const reservations: { Instances: { InstanceId: string }[] }[] = (await aws(['ec2', 'describe-instances', ...region(deployment), '--filters', `Name=tag:agent-team:project,Values=${deployment.projectId}`, 'Name=instance-state-name,Values=pending,running,stopping,stopped'])).Reservations ?? [];
  const instances = reservations.flatMap(reservation => reservation.Instances.map(instance => instance.InstanceId));
  if (instances.length) { await aws(['ec2', 'terminate-instances', ...region(deployment), '--instance-ids', ...instances]); await aws(['ec2', 'wait', 'instance-terminated', ...region(deployment), '--instance-ids', ...instances], { timeoutMs: 600_000 }); log(`terminated ${instances.join(', ')}`); }
  const images = await projectImages(aws, deployment);
  for (const stale of images) await removeImage(aws, deployment, stale);
  if (images.length) log(`removed ${images.length} worker image(s)`);
  if (deployment.worker.amiParameter) await ignoreMissing(['ssm', 'delete-parameter', ...region(deployment), '--name', deployment.worker.amiParameter]);
  if (removeData && deployment.aws.dataVolumeId) { await aws(['ec2', 'delete-volume', ...region(deployment), '--volume-id', deployment.aws.dataVolumeId]); log(`deleted data volume ${deployment.aws.dataVolumeId}`); deployment.aws.dataVolumeId = null; }
  if (deployment.aws.securityGroupId && await ignoreMissing(['ec2', 'delete-security-group', ...region(deployment), '--group-id', deployment.aws.securityGroupId])) log('security group removed');
  if (deployment.aws.network === 'dedicated' && deployment.aws.vpcId) {
    const gateways: { InternetGatewayId: string }[] = (await aws(['ec2', 'describe-internet-gateways', ...region(deployment), '--filters', `Name=attachment.vpc-id,Values=${deployment.aws.vpcId}`])).InternetGateways ?? [];
    for (const gateway of gateways) { await aws(['ec2', 'detach-internet-gateway', ...region(deployment), '--internet-gateway-id', gateway.InternetGatewayId, '--vpc-id', deployment.aws.vpcId]); await aws(['ec2', 'delete-internet-gateway', ...region(deployment), '--internet-gateway-id', gateway.InternetGatewayId]); }
    if (deployment.aws.subnetId) await aws(['ec2', 'delete-subnet', ...region(deployment), '--subnet-id', deployment.aws.subnetId]);
    await aws(['ec2', 'delete-vpc', ...region(deployment), '--vpc-id', deployment.aws.vpcId]);
    log(`dedicated network ${deployment.aws.vpcId} removed`);
    Object.assign(deployment.aws, { vpcId: null, subnetId: null });
  }
  if (removeSecrets) { for (const secret of deployment.secrets) await ignoreMissing(['ssm', 'delete-parameter', ...region(deployment), '--name', parameterName(deployment, secret)]); log('secrets removed'); }
  if (removeRoles) {
    for (const name of Object.values(deployment.aws.roles)) {
      // Each removal stands alone so a role left half-deleted by an earlier failure is still cleared.
      for (const args of [['remove-role-from-instance-profile', '--instance-profile-name', name, '--role-name', name], ['delete-instance-profile', '--instance-profile-name', name],
        ['detach-role-policy', '--role-name', name, '--policy-arn', SSM_CORE], ['delete-role-policy', '--role-name', name, '--policy-name', 'agent-team'], ['delete-role', '--role-name', name]]) await ignoreMissing(['iam', ...args]);
    }
    log('roles removed');
  }
  Object.assign(deployment.aws, { instanceId: null, publicIp: null, privateIp: null, amiId: null, securityGroupId: null });
  return deployment;
}

// Reads one secret value for CLI commands that need it (the machine token).
export async function readSecret(deployment: Deployment, name: string, { aws = defaultAws }: { aws?: Aws } = {}): Promise<string> {
  const secret = deployment.secrets.find(item => item.name === name) ?? { name };
  return (await aws(['ssm', 'get-parameter', ...region(deployment), '--with-decryption', '--name', parameterName(deployment, secret)])).Parameter.Value;
}
