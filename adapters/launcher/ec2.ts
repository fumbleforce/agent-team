import { execFile } from 'node:child_process';
import type { LaunchJob, Launcher } from './contract.ts';

// One EC2 instance per job, built from a project AMI that already contains the toolchain and a
// repository clone. The instance claims exactly its job, uploads artifacts and powers off; the
// coordinator's watchdog terminates instances whose job was never claimed. Spot is requested
// first and on-demand is the fallback. The AWS CLI on the control plane is the only dependency;
// credentials come from the instance role or the environment.
export const NAME = 'ec2';
// The parts of the AWS CLI's JSON answers this launcher reads.
export interface AwsResult { Parameter?: { Value?: unknown }; Instances?: { InstanceId?: string }[]; Reservations?: { Instances?: { State?: { Name?: string } }[] }[] }
export type AwsRun = (args: string[], options: { env: NodeJS.ProcessEnv }) => Promise<AwsResult>;
export interface PublishTarget { scm: string; repository: string; base: string }
export interface UserDataInput { job: LaunchJob; coordinatorUrl: string; tokenParameter: string; checkout?: string; engine?: string; worktrees?: { branchPrefix: string; base: string }; publish?: PublishTarget | null;
  workerConfig?: Record<string, unknown>; toolkit?: string; shutdown?: boolean; ssmPrefix?: string | null; region?: string | null }
export interface Ec2Options { region?: string; ami?: string; instanceType?: string; subnetId?: string; securityGroupId?: string; instanceProfile?: string; coordinatorUrl?: string; token?: string; checkout?: string; keyName?: string;
  spot?: boolean; volumeGb?: number; tags?: Record<string, string>; toolkit?: string; workerConfig?: Record<string, unknown>; ssmPrefix?: string | null; env?: NodeJS.ProcessEnv; run?: AwsRun;
  // What spec 9.9 asks of a disposable worker: the committed manifest authorizes publishing, turns run in packet mode, and the branch is pushed (to 'publish') at the end of each turn.
  engine?: string; manifest?: { publishAuthorized?: boolean }; sessions?: 'packet' | 'resume'; publish?: PublishTarget | null;
  // The parameter holding AGENT_TEAM_TOKEN for the instance. Left out, the launcher stores each job's token at <ssmPrefix>/jobs/<job id> and removes it on stop.
  tokenParameter?: string }

export const aws: AwsRun = (args, { env }) => new Promise((resolve, reject) => {
  execFile('aws', [...args, '--output', 'json'], { env, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) return reject(new Error(`aws ${args.slice(0, 2).join(' ')}: ${String(stderr).trim().slice(-400) || error.message}`));
    resolve(stdout.trim() ? JSON.parse(stdout) as AwsResult : {});
  });
});

// A launched host keeps neither a session nor a worktree between turns, so work that is not pushed is lost with it.
export function refusal({ manifest, sessions = 'packet', publish }: Pick<Ec2Options, 'manifest' | 'sessions' | 'publish'>): string | null {
  const missing = [...(manifest?.publishAuthorized === true ? [] : ['the project manifest does not authorize publishing (publishAuthorized)']), ...(sessions === 'packet' ? [] : ['turns must run in packet mode, without session resume']),
    ...(publish?.scm && publish.repository && publish.base ? [] : ['no publish target (scm, repository, base) is configured, so the branch cannot be pushed at the end of each turn'])];
  return missing.length ? `An ephemeral ec2 worker is refused: ${missing.join('; ')}` : null;
}

// The user data writes the two files the worker reads, as the image's unprivileged `agent` account when it has
// one (the AMI build script creates it): worker.json from the launch facts, and worker.env from Parameter Store,
// read at boot through the instance role. User data is readable by anything on the instance and by
// ec2:DescribeInstanceAttribute, so it carries parameter NAMES only, never a value: every parameter directly under
// `ssmPrefix` (tracker key, SCM token, engine key) and then AGENT_TEAM_TOKEN from `tokenParameter`.
const NAME_PATTERN = /^\/[\w.\/-]+$/;
export function userData({ job, coordinatorUrl, tokenParameter, checkout = '/srv/project', engine = 'claude', worktrees = { branchPrefix: 'agents/', base: 'HEAD' }, publish = null, workerConfig = {}, toolkit = '/opt/agent-team', shutdown = true, ssmPrefix = null, region = null }: UserDataInput): string {
  for (const name of [tokenParameter, ...(ssmPrefix ? [ssmPrefix] : [])]) if (!NAME_PATTERN.test(name)) throw new Error(`${name} is not a Parameter Store name`);
  const config = JSON.stringify({ coordinatorUrl, workerId: `ec2-${job.id}`, stateDir: '/var/lib/agent-team', engine, projects: { [job.projectId]: checkout }, worktrees, ...(publish ? { publish } : {}), ...workerConfig });
  const ENV = '/etc/agent-team/worker.env', where = region ? ` --region ${region}` : '';
  const command = `set -a; . ${ENV}; set +a; cd ${toolkit} && node packages/worker/src/main.ts --config /etc/agent-team/worker.json --once --job ${job.id}`;
  // jq's @sh single-quotes each value, which both the shell and a systemd EnvironmentFile read back unchanged.
  return ['#!/bin/bash', 'set -uo pipefail', 'umask 077', 'mkdir -p /etc/agent-team /var/lib/agent-team', `cat > /etc/agent-team/worker.json <<'JSON'`, config, 'JSON', `: > ${ENV}`,
    ...(ssmPrefix ? [`aws ssm get-parameters-by-path${where} --with-decryption --path '${ssmPrefix}' --output json | jq -r '.Parameters[] | "\\(.Name | split("/") | last)=\\(.Value | @sh)"' >> ${ENV}`] : []),
    `aws ssm get-parameters${where} --with-decryption --names '${tokenParameter}' --output json | jq -r '.Parameters[] | "AGENT_TEAM_TOKEN=\\(.Value | @sh)"' >> ${ENV}`,
    `chmod 600 ${ENV} /etc/agent-team/worker.json`,
    'if id agent >/dev/null 2>&1; then chown -R agent:agent /etc/agent-team /var/lib/agent-team; RUN="runuser -u agent --"; else RUN=""; fi',
    `if grep -q '^AGENT_TEAM_TOKEN=' ${ENV}; then $RUN bash -c ${JSON.stringify(command)} >> /var/log/agent-team-worker.log 2>&1; else echo 'AGENT_TEAM_TOKEN could not be read from ${tokenParameter}' >> /var/log/agent-team-worker.log; fi`,
    ...(shutdown ? ['shutdown -h now'] : [])].join('\n') + '\n';
}

// `ssm:/path` in place of an AMI id resolves the current image from Parameter Store, so nightly
// AMI builds update one parameter instead of every manifest.
async function resolveImage(value: string, { run, env, region }: { run: AwsRun; env: NodeJS.ProcessEnv; region: string | undefined }): Promise<string> {
  if (!value.startsWith('ssm:')) return value;
  const result = await run(['ssm', 'get-parameter', ...(region ? ['--region', region] : []), '--name', value.slice(4)], { env });
  const image = result.Parameter?.Value;
  if (typeof image !== 'string' || !/^ami-[0-9a-f]+$/.test(image)) throw new Error(`Parameter ${value.slice(4)} does not hold an AMI id`);
  return image;
}

export function create({ region, ami, instanceType = 't3.large', subnetId, securityGroupId, instanceProfile, coordinatorUrl, token, checkout = '/srv/project', keyName,
  spot = true, volumeGb = 60, tags = {}, toolkit, workerConfig, ssmPrefix = null, env = process.env, run = aws, engine, manifest, sessions, publish = null, tokenParameter }: Ec2Options = {}): Launcher {
  const requireOption = (name: string, value: unknown): string => { if (typeof value !== 'string' || !value.trim()) throw new Error(`ec2 launcher requires ${name}`); return value; };
  const base = (job: LaunchJob, market: string, image: string, tokenName: string): Record<string, unknown> => ({
    ImageId: image, InstanceType: job.worker?.instanceType ?? instanceType, MinCount: 1, MaxCount: 1,
    InstanceInitiatedShutdownBehavior: 'terminate',
    UserData: Buffer.from(userData({ job, coordinatorUrl: requireOption('coordinatorUrl', coordinatorUrl), tokenParameter: tokenName, checkout, ssmPrefix, region: region ?? null, publish, ...(engine ? { engine } : {}),
      ...(workerConfig ? { workerConfig } : {}), ...(toolkit ? { toolkit } : {}) })).toString('base64'),
    BlockDeviceMappings: [{ DeviceName: '/dev/xvda', Ebs: { VolumeSize: volumeGb, VolumeType: 'gp3', DeleteOnTermination: true } }],
    TagSpecifications: [{ ResourceType: 'instance', Tags: [{ Key: 'Name', Value: `agent-team-${job.projectId}-${job.id.slice(0, 8)}` }, { Key: 'agent-team:job', Value: job.id }, { Key: 'agent-team:project', Value: job.projectId }, ...Object.entries(tags).map(([Key, Value]) => ({ Key, Value }))] }],
    MetadataOptions: { HttpTokens: 'required', HttpEndpoint: 'enabled', HttpPutResponseHopLimit: 1 },
    ...(subnetId ? { SubnetId: subnetId } : {}), ...(securityGroupId ? { SecurityGroupIds: [securityGroupId] } : {}),
    ...(instanceProfile ? { IamInstanceProfile: { Name: instanceProfile } } : {}), ...(keyName ? { KeyName: keyName } : {}),
    ...(market === 'spot' ? { InstanceMarketOptions: { MarketType: 'spot', SpotOptions: { SpotInstanceType: 'one-time', InstanceInterruptionBehavior: 'terminate' } } } : {}),
  });
  const regionArgs = region ? ['--region', region] : [];
  const jobParameter = (jobId: string) => `${requireOption('ssmPrefix (or tokenParameter)', ssmPrefix)}/jobs/${jobId}`;
  const forget = async (jobId: string | undefined) => { if (!tokenParameter && ssmPrefix && jobId) await run(['ssm', 'delete-parameter', ...regionArgs, '--name', jobParameter(jobId)], { env }).catch(() => {}); };
  return {
    kind: NAME,
    async start(job) {
      const refused = refusal({ ...(manifest ? { manifest } : {}), ...(sessions ? { sessions } : {}), publish });
      if (refused) throw new Error(refused);
      const tokenName = tokenParameter ?? jobParameter(job.id);
      userData({ job, coordinatorUrl: requireOption('coordinatorUrl', coordinatorUrl), tokenParameter: tokenName, ssmPrefix });
      const image = await resolveImage(requireOption('ami', job.worker?.ami ?? ami), { run, env, region });
      // The job's token waits in Parameter Store for the instance role to read; it never enters the launch request.
      if (!tokenParameter) await run(['ssm', 'put-parameter', ...regionArgs, '--name', tokenName, '--type', 'SecureString', '--overwrite', '--value', requireOption('token', job.token ?? token)], { env });
      let lastError: unknown;
      for (const market of spot ? ['spot', 'on-demand'] : ['on-demand']) {
        try {
          const result = await run(['ec2', 'run-instances', ...regionArgs, '--cli-input-json', JSON.stringify(base(job, market, image, tokenName))], { env });
          const instanceId = result.Instances?.[0]?.InstanceId;
          if (!instanceId) throw new Error('RunInstances returned no instance');
          return { kind: NAME, jobId: job.id, instanceId, market, region: region ?? null, startedAt: Date.now() };
        } catch (error) { lastError = error; }
      }
      await forget(job.id);
      throw lastError ?? new Error('ec2 launcher could not start an instance');
    },
    async stop(handle) {
      if (!handle?.instanceId) return { stopped: false };
      await run(['ec2', 'terminate-instances', ...regionArgs, '--instance-ids', handle.instanceId], { env });
      await forget(handle.jobId);
      return { stopped: true };
    },
    async status(handle) {
      if (!handle?.instanceId) return { state: 'unknown' };
      const result = await run(['ec2', 'describe-instances', ...regionArgs, '--instance-ids', handle.instanceId], { env });
      return { state: result.Reservations?.[0]?.Instances?.[0]?.State?.Name ?? 'unknown' };
    },
  };
}
