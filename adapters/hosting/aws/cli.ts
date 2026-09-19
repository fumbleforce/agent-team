import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { configDir } from '@agent-team/protocol';
import { BOUNDARY_ARN, defaultAws, deploy, DeployError, destroy, discover, newDeployment, parameterName, STEPS, type Aws, type DeployOptions, type Deployment, type DeploymentFacts, type Step } from './deploy.ts';

// The `deploy aws`, `status aws` and `destroy aws` commands. The deployment description is one JSON file
// in the config directory: the owner writes the facts (DeploymentFacts plus an optional `region`,
// `permissionsBoundary` and `toolkit`), and an applied deploy rewrites it with the ids of what it created.
// Secret values never reach that file: they are read from the environment by name when a deploy stores them.
// Nothing in the account changes without `--apply` (deploy) or `--yes` (destroy).
export const deploymentFile = (env: NodeJS.ProcessEnv = process.env) => path.join(configDir(env), 'aws-deployment.json');
export interface CliIo { aws?: Aws; env?: NodeJS.ProcessEnv; log?: (line: string) => void; file?: string; options?: DeployOptions }
type Facts = DeploymentFacts & { region?: string; permissionsBoundary?: string; toolkit?: Deployment['toolkit'] };

const WHAT: Record<Step, (deployment: Deployment) => string> = {
  secrets: d => `store in Parameter Store: ${d.secrets.map(secret => parameterName(d, secret)).join(', ') || 'nothing'}`,
  network: d => d.aws.securityGroupId ? `complete the rules of security group ${d.aws.securityGroupId}` : `create ${d.aws.network === 'dedicated' ? 'a dedicated VPC, subnet, internet gateway and ' : ''}security group agent-team-${d.projectId}`,
  iam: d => `create or update the roles and instance profiles ${d.aws.roles.control} and ${d.aws.roles.worker}`,
  controlPlane: d => d.aws.instanceId ? `reuse control plane ${d.aws.instanceId} when it is running, otherwise launch a replacement` : `launch the control-plane instance${d.aws.dataVolumeId ? ` and re-attach data volume ${d.aws.dataVolumeId}` : ' with a new data volume'}`,
  image: d => d.worker.launcher === 'ec2' && d.worker.amiParameter ? `bake a worker image on a ${d.worker.instanceType} builder and publish it to ${d.worker.amiParameter}` : 'nothing (this launcher needs no image)',
  verify: () => 'wait for the control plane to answer (creates nothing)',
};

function load(file: string, env: NodeJS.ProcessEnv): Deployment {
  if (!existsSync(file)) throw new DeployError(`No deployment description at ${file}`, 'Write the project facts there as JSON (projectId, name, checkout, scm, worker, ssmPrefix, secrets, region); adapters/hosting/aws/README.md has an example.');
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Deployment | Facts;
  if ('version' in parsed) return parsed;
  const { region, permissionsBoundary, toolkit, ...facts } = parsed;
  for (const key of ['projectId', 'ssmPrefix', 'scm', 'worker', 'secrets'] as const) if (!facts[key]) throw new DeployError(`${file} has no ${key}`, 'See the example in adapters/hosting/aws/README.md.');
  return newDeployment(facts, { region: region ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? null, permissionsBoundary: permissionsBoundary ?? null, ...(toolkit ? { toolkit } : {}) });
}
const save = (file: string) => (deployment: Deployment) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, `${JSON.stringify(deployment, null, 2)}\n`, { mode: 0o600 }); };

function steps(args: string[], name: string): Step[] {
  const found = args.flatMap((item, index) => item === name ? (args[index + 1] ?? '').split(',') : []);
  for (const step of found) if (!(STEPS as readonly string[]).includes(step)) throw new DeployError(`${name} ${step || '(empty)'} is not a step`, `Steps: ${STEPS.join(', ')}`);
  return found as Step[];
}

// Returns the process exit code.
export async function awsCli(command: string, args: string[], { aws = defaultAws, env = process.env, log = console.log, file = deploymentFile(env), options = {} }: CliIo = {}): Promise<number> {
  try {
    const deployment = load(file, env);
    if (command === 'deploy') {
      if (args.includes('--plan') && args.includes('--apply')) throw new DeployError('--plan and --apply exclude each other', 'Pass one of them.');
      const boundary = args.includes('--permissions-boundary') ? args[args.indexOf('--permissions-boundary') + 1] ?? '' : null;
      if (boundary !== null && !BOUNDARY_ARN.test(boundary)) throw new DeployError(`${boundary || '(empty)'} is not a policy ARN`, 'Pass the boundary as arn:aws:iam::<account>:policy/<name>.');
      if (boundary) deployment.aws.permissionsBoundary = boundary;
      const only = steps(args, '--only'), skip = steps(args, '--skip');
      const selected = STEPS.filter(step => (!only.length || only.includes(step)) && !skip.includes(step));
      if (!args.includes('--apply')) {
        // Discovery only reads (caller identity, and the default network when that is the chosen one).
        await discover(deployment, { aws, log });
        log(`Plan for ${deployment.projectId} in account ${deployment.aws.accountId}, region ${deployment.aws.region} (from ${file}):`);
        for (const step of selected) log(`  ${step}: ${WHAT[step](deployment)}`);
        log('Nothing was created or changed. Apply with: agent-team deploy aws --apply');
        return 0;
      }
      const values = Object.fromEntries(deployment.secrets.flatMap(secret => env[secret.name] ? [[secret.name, env[secret.name]!]] : []));
      await deploy(deployment, { aws, log, values, generate: () => randomBytes(32).toString('base64url'), ...options, only: only.length ? only : null, skip, save: save(file) });
      log(`Deployed. Reach the control plane with: aws ssm start-session --region ${deployment.aws.region} --target ${deployment.aws.instanceId} --document-name AWS-StartPortForwardingSession --parameters portNumber=4310,localPortNumber=4310`);
      return 0;
    }
    if (command === 'status') {
      log(`Deployment ${deployment.projectId} (${file})`);
      const { roles, ...recorded } = deployment.aws;
      for (const [key, value] of Object.entries({ ...recorded, controlRole: roles.control, workerRole: roles.worker })) log(`  ${key}: ${Array.isArray(value) ? value.join(', ') : value ?? 'not created'}`);
      if (deployment.aws.instanceId && deployment.aws.region) {
        const instance = (await aws(['ec2', 'describe-instances', '--region', deployment.aws.region, '--instance-ids', deployment.aws.instanceId]).catch(() => null))?.Reservations?.[0]?.Instances?.[0];
        log(`  control plane state: ${instance?.State?.Name ?? 'not found'}`);
      }
      return 0;
    }
    if (command === 'destroy') {
      const removeRoles = args.includes('--roles'), removeData = args.includes('--data'), removeSecrets = args.includes('--secrets');
      const doomed = [`every instance tagged agent-team:project=${deployment.projectId}${deployment.aws.instanceId ? ` (control plane ${deployment.aws.instanceId})` : ''}`, `every worker image tagged agent-team:project=${deployment.projectId}, with its snapshot`,
        ...(deployment.worker.amiParameter ? [`parameter ${deployment.worker.amiParameter}`] : []), ...(deployment.aws.securityGroupId ? [`security group ${deployment.aws.securityGroupId}`] : []),
        ...(deployment.aws.network === 'dedicated' && deployment.aws.vpcId ? [`dedicated network ${deployment.aws.vpcId} (subnet ${deployment.aws.subnetId}, its internet gateway)`] : []),
        ...(removeData && deployment.aws.dataVolumeId ? [`data volume ${deployment.aws.dataVolumeId}, which holds the database`] : []),
        ...(removeSecrets ? deployment.secrets.map(secret => `secret ${parameterName(deployment, secret)}`) : []), ...(removeRoles ? Object.values(deployment.aws.roles).map(role => `role and instance profile ${role}`) : [])];
      const kept = [...(removeData ? [] : ['the data volume (--data)']), ...(removeSecrets ? [] : ['the secrets (--secrets)']), ...(removeRoles ? [] : ['the roles (--roles)'])];
      log(`${args.includes('--yes') ? 'Deleting' : 'Would delete'} in region ${deployment.aws.region}:`);
      for (const line of doomed) log(`  ${line}`);
      if (kept.length) log(`Kept: ${kept.join(', ')}`);
      if (!args.includes('--yes')) { log('Nothing was deleted. Confirm with: agent-team destroy aws --yes'); return 1; }
      if (!deployment.aws.region) throw new DeployError('No AWS region recorded', `Set "region" in ${file}.`);
      await destroy(deployment, { aws, log, removeRoles, removeData, removeSecrets });
      save(file)(deployment);
      return 0;
    }
    throw new DeployError(`Unknown command ${command} aws`, 'Commands: deploy aws, status aws, destroy aws.');
  } catch (error) {
    log(`Error: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof DeployError) log(`  ${error.hint}`);
    return 1;
  }
}
