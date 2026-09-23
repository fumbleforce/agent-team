import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { configDir, packageRoot } from '@agent-team/protocol';
import { SCM_KINDS, scmAdapter } from '../../scm/index.ts';
import { terminalAsk, yes, type Ask } from '../shared/ask.ts';
import { parseRemote } from '../shared/repository.ts';
import { BOUNDARY_ARN, boundariesInUse, defaultAws, deploy, DeployError, destroy, discover, newDeployment, parameterName, STEPS, TOOLKIT_REPO, type Aws, type DeployOptions, type Deployment, type DeploymentFacts, type Step } from './deploy.ts';

// The `init aws`, `deploy aws`, `status aws` and `destroy aws` commands. The deployment description is one JSON file
// in the config directory: `init` derives the facts from a checkout's manifest, or the owner writes them (DeploymentFacts plus an optional `region`,
// `permissionsBoundary` and `toolkit`), and an applied deploy rewrites it with the ids of what it created.
// Secret values never reach that file: they are read from the environment by name when a deploy stores them.
// Nothing in the account changes without `--apply` (deploy) or `--yes` (destroy).
// A deployment belongs to a project, so its description lives in the project's folder: every project has its own, in its own
// account, and a command run in one folder cannot reach another project's resources. The folder is `.agent-team/`, which
// worktrees never carry, so agents do not see it. It holds ids, never a secret; commit it or ignore it as the team prefers.
export function deploymentFile(folder: string = process.cwd()): string {
  const start = path.resolve(folder);
  // From inside a project, its root is meant: the nearest folder that has a deployment, or is a repository.
  for (let at = start; ; at = path.dirname(at)) {
    const candidate = path.join(at, '.agent-team', 'aws-deployment.json');
    if (existsSync(candidate) || existsSync(path.join(at, '.git'))) return candidate;
    if (at === path.dirname(at)) return path.join(start, '.agent-team', 'aws-deployment.json');
  }
}
// Where one deployment per machine used to be kept. It is still read for the project it names, and only from that project's folder.
export const centralFile = (env: NodeJS.ProcessEnv = process.env) => path.join(configDir(env), 'aws-deployment.json');
function resolveFile(folder: string, env: NodeJS.ProcessEnv, log: (line: string) => void): string {
  const own = deploymentFile(folder), central = centralFile(env);
  if (existsSync(own) || !existsSync(central)) return own;
  try {
    const recorded = (JSON.parse(readFileSync(central, 'utf8')) as { checkout?: string | null }).checkout;
    if (recorded && path.resolve(recorded) === path.dirname(path.dirname(own))) { log(`Using ${central}, the older central location. Move it into the project: mkdir -p ${path.dirname(own)} && mv ${central} ${own}`); return central; }
  } catch { /* an unreadable central file is nobody's deployment */ }
  return own;
}

// Every AWS CLI call of a project goes through the profile recorded for it, whatever the shell has exported.
const withProfile = (aws: Aws, profile: string | null | undefined): Aws => profile ? (args, options) => aws([...args, '--profile', profile], options) : aws;
export interface CliIo { aws?: Aws; env?: NodeJS.ProcessEnv; log?: (line: string) => void; folder?: string; file?: string; options?: DeployOptions; ask?: Ask | null }
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
  if (!existsSync(file)) throw new DeployError(`No deployment description at ${file}`, 'Run `agent-team init aws` in the project\'s folder, or write the project facts there as JSON; adapters/hosting/aws/README.md has an example.');
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

// What is known about a project from its checkout: the manifest when there is one, else the git remote and the files it tracks.
// The engine's key is not among the secrets: it is set in the app. The machine token is generated; the rest are read from the
// environment, or asked for, when a deploy stores them.
interface Manifest {
  name?: string; queueProjectId?: string;
  scm?: { kind?: string; repository?: string; host?: string };
  tracker?: { kind?: string };
  delivery?: { repository?: string };
  worker?: { launcher?: string; instanceType?: string; setup?: string };
}
const TRACKER_SECRETS: Record<string, string> = { linear: 'LINEAR_API_KEY' };
const git = (checkout: string, args: string[]) => { const result = spawnSync('git', ['-C', checkout, ...args], { encoding: 'utf8' }); return result.status === 0 ? result.stdout.trim() : ''; };

export { parseRemote };

// Workers set a fresh clone up, so only files the repository tracks count.
function guessSetup(checkout: string): string {
  const tracked = new Set(git(checkout, ['ls-files', 'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']).split('\n'));
  if (tracked.has('pnpm-lock.yaml')) return 'pnpm install --frozen-lockfile';
  if (tracked.has('yarn.lock')) return 'yarn install --frozen-lockfile';
  if (tracked.has('package-lock.json')) return 'npm ci';
  return tracked.has('package.json') ? 'npm install' : '';
}

export interface Detected { projectId: string; name: string; kind: string | null; host: string | null; repository: string | null; tracker: string | null; launcher: string; instanceType: string; setup: string; manifest: boolean }
export function detect(checkout: string): Detected {
  if (!existsSync(checkout)) throw new DeployError(`${checkout} does not exist`, 'Give the folder of the project to deploy a team for.');
  const manifestFile = path.join(checkout, '.agent-team.json');
  const manifest = (existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : {}) as Manifest;
  const remote = parseRemote(git(checkout, ['remote', 'get-url', 'origin']));
  const host = manifest.scm?.host ?? remote?.host ?? null;
  const kind = manifest.scm?.kind ?? SCM_KINDS.find(name => host?.includes(name)) ?? null;
  const projectId = (manifest.queueProjectId ?? path.basename(checkout)).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return {
    projectId, name: manifest.name ?? path.basename(checkout), kind,
    host: host ?? (kind && SCM_KINDS.includes(kind) ? new URL(scmAdapter(kind).host({})).host : null),
    repository: manifest.scm?.repository ?? manifest.delivery?.repository ?? remote?.repository ?? null,
    tracker: manifest.tracker?.kind ?? null, launcher: manifest.worker?.launcher ?? 'ec2', instanceType: manifest.worker?.instanceType ?? 'c6i.large',
    setup: manifest.worker?.setup ?? guessSetup(checkout), manifest: existsSync(manifestFile),
  };
}

export function factsFrom(checkout: string, found: Detected): DeploymentFacts {
  if (!found.kind || !SCM_KINDS.includes(found.kind)) throw new DeployError(`Cannot tell where ${checkout} keeps its code`, `It has no manifest naming a source host and no "origin" remote on one of: ${SCM_KINDS.join(', ')}. Add the remote, or write the deployment file by hand; adapters/hosting/aws/README.md has an example.`);
  if (!found.repository || !found.host) throw new DeployError(`Cannot tell which repository ${checkout} is`, 'Add an "origin" remote, or set scm.repository in .agent-team.json.');
  const ssmPrefix = `/agent-team/${found.projectId}`;
  const trackerSecret = TRACKER_SECRETS[found.tracker ?? ''];
  return {
    projectId: found.projectId, name: found.name, checkout,
    scm: { kind: found.kind, repository: found.repository, host: found.host },
    worker: { launcher: found.launcher, instanceType: found.instanceType, setup: found.setup, amiParameter: found.launcher === 'ec2' ? `${ssmPrefix}/worker-ami` : null },
    ssmPrefix,
    secrets: [
      { name: 'AGENT_TEAM_TOKEN', generated: true, scope: 'control', purpose: 'machine token' },
      { name: scmAdapter(found.kind).tokenVariable, generated: false, purpose: `${found.kind} token`, adapter: found.kind },
      ...(trackerSecret ? [{ name: trackerSecret, generated: false, purpose: `${found.tracker} API key`, adapter: found.tracker! }] : []),
    ],
  };
}


const value = (args: string[], name: string) => args.includes(name) ? args[args.indexOf(name) + 1] ?? '' : null;
const INIT_FLAGS = ['--region', '--profile', '--permissions-boundary', '--toolkit-ref', '--instance-type', '--setup'];
const REF = /^[\w][\w./-]{0,199}$/;

// Writes the deployment file from a checkout, asking for what the checkout does not say. A flag answers its question ahead of
// time. Writing reads nothing from the account and stores no secret; the plan and the apply it then offers are `deploy aws`.
async function init(args: string[], io: Required<Pick<CliIo, 'aws' | 'env' | 'log' | 'options'>> & { ask: Ask | null; folder: string; file: string | null }): Promise<number> {
  const { env, log, ask } = io;
  const positional = args.find((item, index) => !item.startsWith('--') && !INIT_FLAGS.includes(args[index - 1] ?? ''));
  const checkout = path.resolve(positional ?? (ask ? await ask('Project folder', { fallback: io.folder }) : io.folder));
  if (!existsSync(checkout)) throw new DeployError(`${checkout} does not exist`, 'Give the folder of the project to deploy a team for.');
  const file = io.file ?? deploymentFile(checkout);
  if (existsSync(file)) {
    const existing = JSON.parse(readFileSync(file, 'utf8')) as Partial<Deployment>;
    const created = existing.aws && [existing.aws.instanceId, existing.aws.vpcId, existing.aws.dataVolumeId, existing.aws.amiId].some(Boolean);
    if (created) throw new DeployError(`${file} records resources that exist in the account`, 'Remove them first with: agent-team destroy aws --yes (the file is what finds them again).');
    const replace = args.includes('--force') || (ask !== null && yes(await ask(`${file} already describes ${existing.projectId ?? 'a deployment'}, not deployed yet. Replace it? (y/N)`)));
    if (!replace) throw new DeployError(`${file} already exists`, 'Nothing has been deployed from it; pass --force to write it again.');
  }
  const found = detect(checkout);
  log(found.manifest ? `Read ${path.join(checkout, '.agent-team.json')}` : `${checkout} has no .agent-team.json; going by its git remote and files`);
  if (ask) {
    found.name = await ask('Project name', { fallback: found.name });
    found.repository = await ask(`Repository on ${found.host ?? 'the source host'}`, { fallback: found.repository ?? '' }) || null;
  }
  const facts = factsFrom(checkout, found);

  const askValid = async (question: string, fallback: string, valid: (answer: string) => boolean, complaint: string) => {
    for (;;) { const answer = await ask!(question, { fallback }); if (!answer || valid(answer)) return answer; log(`  ${complaint}`); }
  };
  const region = value(args, '--region') ?? (ask ? await ask('AWS region', { fallback: env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? 'eu-central-1' }) : env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? null);
  if (!region) throw new DeployError('No AWS region', 'Pass --region, for example --region eu-central-1.');
  // Which account is this project's: the profile is recorded, so a shell that has another project's profile exported cannot deploy this one there.
  const shellProfile = env.AWS_PROFILE ?? '';
  const profileAnswer = value(args, '--profile') ?? (ask ? await ask(`AWS CLI profile of the account this project deploys into${shellProfile ? ' ("default" for the default credentials)' : ' (empty for the default credentials)'}`, { fallback: shellProfile }) : shellProfile);
  const profile = /^default$/i.test(profileAnswer) ? null : profileAnswer || null;
  // Not asked: few accounts need one, and `deploy` finds the one an account uses by looking.
  const boundary = value(args, '--permissions-boundary');
  if (boundary && !BOUNDARY_ARN.test(boundary)) throw new DeployError(`${boundary} is not a policy ARN`, 'Pass the boundary as arn:aws:iam::<account>:policy/<name>.');
  facts.worker.instanceType = value(args, '--instance-type') ?? (ask ? await ask('Worker instance type', { fallback: facts.worker.instanceType }) : facts.worker.instanceType);
  // Enter takes the guess, so doing without a setup command needs a word of its own.
  const setupAnswer = value(args, '--setup') ?? (ask ? await ask(`Command that sets a fresh clone up for work${facts.worker.setup ? ' ("none" for no command)' : ' (empty for none)'}`, { fallback: facts.worker.setup }) : facts.worker.setup);
  facts.worker.setup = /^none$/i.test(setupAnswer) ? '' : setupAnswer;
  // Hosts clone the toolkit; what is published on its main branch is the revision worth pinning.
  const published = git(packageRoot(), ['rev-parse', '--short', 'origin/main']);
  const ref = value(args, '--toolkit-ref') ?? (ask ? await askValid(`Toolkit commit the hosts run${published ? ' ("main" to follow the branch instead)' : ' (empty to follow the main branch)'}`, published, answer => REF.test(answer), 'That is not a branch, tag or commit') : null);
  if (ref && !REF.test(ref)) throw new DeployError(`${ref} is not a branch, tag or commit`, 'Pass --toolkit-ref a commit of the toolkit repository.');

  const deployment = newDeployment(facts, { region, permissionsBoundary: boundary || null, ...(ref ? { toolkit: { repo: TOOLKIT_REPO, ref } } : {}) });
  deployment.aws.profile = profile;
  save(file)(deployment);
  log(`Wrote ${file}`);
  log(`  project   ${deployment.name} (${deployment.projectId}), ${deployment.scm.kind} ${deployment.scm.repository}`);
  log(`  account   ${profile ? `profile ${profile}` : 'the default credentials'}, region ${region}${boundary ? `, roles bounded by ${boundary}` : ''}`);
  log(`  workers   ${deployment.worker.launcher} ${deployment.worker.instanceType}, setup: ${deployment.worker.setup || '(none)'}`);
  log(`  toolkit   ${ref ? `pinned to ${ref}` : 'follows the main branch; pin a commit with --toolkit-ref'} (hosts clone it, so what is not pushed is not deployed)`);
  if (!ask) {
    log(`  secrets   ${deployment.secrets.filter(secret => !secret.generated).map(secret => `${secret.name}${env[secret.name] ? '' : ' (not set in this shell)'}`).join(', ')}: exported when you apply`);
    log('Next: agent-team deploy aws          (a plan; it changes nothing)');
    return 0;
  }

  if (!yes(await ask('Show the plan now? It only reads the account (Y/n)', { fallback: 'y' }))) { log('Next: agent-team deploy aws'); return 0; }
  return awsCli('deploy', [], { ...io, folder: checkout, file });
}

// Returns the process exit code.
export async function awsCli(command: string, args: string[], { aws: account = defaultAws, env = process.env, log = console.log, folder = process.cwd(), file: given, options = {}, ask = terminalAsk() }: CliIo = {}): Promise<number> {
  try {
    if (command === 'init') return await init(args, { aws: account, env, log, folder, file: given ?? null, options, ask });
    const file = given ?? resolveFile(folder, env, log);
    if (!existsSync(file) && command === 'deploy' && ask && yes(await ask(`Nothing describes a deployment yet (${file}). Set one up now? (Y/n)`, { fallback: 'y' }))) return await init([], { aws: account, env, log, folder, file: given ?? null, options, ask });
    const deployment = load(file, env);
    const aws = withProfile(account, deployment.aws.profile);
    if (deployment.aws.profile && env.AWS_PROFILE && env.AWS_PROFILE !== deployment.aws.profile) log(`Using the profile recorded for this project, ${deployment.aws.profile}, not AWS_PROFILE=${env.AWS_PROFILE}.`);
    // What was created in one account is never looked for, changed or deleted in another.
    if (deployment.aws.accountId) {
      const caller = (await aws(['sts', 'get-caller-identity']).catch(() => null))?.Account as string | undefined;
      if (caller && caller !== deployment.aws.accountId) throw new DeployError(`This deployment is in account ${deployment.aws.accountId}, but the credentials in use are for account ${caller}`, `Sign in to the right account${deployment.aws.profile ? ` (profile ${deployment.aws.profile})` : ', or record its profile as "profile" under "aws" in ' + file}.`);
    }
    if (command === 'deploy') {
      if (args.includes('--plan') && args.includes('--apply')) throw new DeployError('--plan and --apply exclude each other', 'Pass one of them.');
      const boundary = args.includes('--permissions-boundary') ? args[args.indexOf('--permissions-boundary') + 1] ?? '' : null;
      if (boundary !== null && !BOUNDARY_ARN.test(boundary)) throw new DeployError(`${boundary || '(empty)'} is not a policy ARN`, 'Pass the boundary as arn:aws:iam::<account>:policy/<name>.');
      if (boundary) deployment.aws.permissionsBoundary = boundary;
      const only = steps(args, '--only'), skip = steps(args, '--skip');
      const selected = STEPS.filter(step => (!only.length || only.includes(step)) && !skip.includes(step));
      // An account that only allows roles carrying a permissions boundary refuses the iam step without one. The boundary it uses
      // is found by looking, and attached on a yes; without a terminal the plan names it and the flag that records it.
      let boundaryNote: string | null = null;
      if (!deployment.aws.permissionsBoundary && selected.includes('iam')) {
        const inUse = await boundariesInUse(aws);
        const name = (arn: string) => arn.slice(arn.indexOf('/') + 1);
        if (inUse.length && ask) {
          let picked: string | null = null;
          if (inUse.length === 1) {
            const agreed = yes(await ask(`This account attaches the policy ${name(inUse[0]!)} to roles as a permissions boundary, and may refuse roles without it. Attach it to the two roles this creates? (Y/n)`, { fallback: 'y' }));
            picked = agreed ? inUse[0]! : null;
          } else {
            const answer = (await ask(`This account uses permissions boundaries and may refuse roles without one. Attach which to the two roles this creates? (${inUse.map(name).join(', ')}; empty for none)`)).trim();
            picked = inUse.find(arn => name(arn) === answer || arn === answer) ?? null;
          }
          if (picked) { deployment.aws.permissionsBoundary = picked; save(file)(deployment); log(`Roles will carry the permissions boundary ${picked}`); }
        } else if (inUse.length) boundaryNote = `Note: this account uses permissions boundaries (${inUse.join(', ')}). If it refuses roles without one, add --permissions-boundary ARN.`;
      }
      if (!args.includes('--apply')) {
        // Discovery only reads (caller identity, and the default network when that is the chosen one).
        await discover(deployment, { aws, log });
        log(`Plan for ${deployment.projectId} in account ${deployment.aws.accountId}, region ${deployment.aws.region} (from ${file}):`);
        for (const step of selected) log(`  ${step}: ${WHAT[step](deployment)}`);
        if (boundaryNote) log(boundaryNote);
        if (!ask) { log('Nothing was created or changed. Apply with: agent-team deploy aws --apply'); return 0; }
        log('Nothing was created or changed.');
        if (!yes(await ask('Apply it now? This creates what is listed above, which costs money until destroyed (y/N)'))) { log('Apply later with: agent-team deploy aws --apply'); return 0; }
      }
      const values = Object.fromEntries(deployment.secrets.flatMap(secret => env[secret.name] ? [[secret.name, env[secret.name]!]] : []));
      // A secret that is neither stored nor in the environment is asked for, and the deploy carries on from where it stopped.
      for (;;) {
        try { await deploy(deployment, { aws, log, values, generate: () => randomBytes(32).toString('base64url'), ...options, only: only.length ? only : null, skip, save: save(file) }); break; }
        catch (error) {
          // Roles refused for want of a boundary nobody could look up: its ARN is asked for, once.
          if (error instanceof DeployError && /^Creating the role .* was denied$/.test(error.message) && ask && !deployment.aws.permissionsBoundary) {
            const typed = await ask('Creating the role was refused. If this account only allows roles that carry a permissions boundary, paste that policy\'s ARN (arn:aws:iam::<account>:policy/<name>; empty to stop)');
            if (!BOUNDARY_ARN.test(typed)) throw error;
            deployment.aws.permissionsBoundary = typed;
            continue;
          }
          const missing = error instanceof DeployError ? deployment.secrets.find(secret => error.message === `Secret ${secret.name} is missing`) : undefined;
          if (!missing || !ask || values[missing.name]) throw error;
          const typed = await ask(`The ${missing.purpose} (${missing.name}) is not stored yet and not in this shell. Type or paste it; it is not shown`, { secret: true });
          if (!typed) throw error;
          values[missing.name] = typed;
        }
      }
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
      if (!args.includes('--yes')) {
        // Deleting the database is confirmed by name, the rest by a yes.
        const confirmed = ask !== null && (removeData ? await ask(`This deletes the database. Type the project id (${deployment.projectId}) to go ahead`) === deployment.projectId : yes(await ask('Delete these? (y/N)')));
        if (!confirmed) { log('Nothing was deleted. Confirm with: agent-team destroy aws --yes'); return 1; }
      }
      if (!deployment.aws.region) throw new DeployError('No AWS region recorded', `Set "region" in ${file}.`);
      await destroy(deployment, { aws, log, removeRoles, removeData, removeSecrets });
      save(file)(deployment);
      return 0;
    }
    throw new DeployError(`Unknown command ${command} aws`, 'Commands: init aws, deploy aws, status aws, destroy aws.');
  } catch (error) {
    log(`Error: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof DeployError) log(`  ${error.hint}`);
    return 1;
  }
}
