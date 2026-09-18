import { execFile } from 'node:child_process';

// One EC2 instance per job, built from a project AMI that already contains the toolchain and a
// repository clone. The instance claims exactly its job, uploads artifacts and powers off; the
// coordinator's watchdog terminates instances whose job was never claimed. Spot is requested
// first and on-demand is the fallback. The AWS CLI on the control plane is the only dependency;
// credentials come from the instance role or the environment.
export const NAME = 'ec2';

export function aws(args, { env = process.env, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('aws', [...args, '--output', 'json'], { env, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`aws ${args.slice(0, 2).join(' ')}: ${String(stderr).trim().slice(-400) || error.message}`));
      resolve(stdout.trim() ? JSON.parse(stdout) : {});
    });
  });
}

// The worker on the instance reads its configuration from the files the user-data writes. When the
// image has an unprivileged `agent` account (the AMI build script creates one) the worker runs as it.
// With `ssmPrefix`, every parameter under that path (tracker key, SCM token, engine key) is exported
// to the worker through the instance role. The only credential inside the user-data is the token,
// which the coordinator supplies per job (`job.token`) so it is useless for anything but that job.
export function userData({ job, coordinatorUrl, token, checkout, workerConfig = {}, toolkit = '/opt/agent-team', shutdown = true, ssmPrefix = null, region = null }) {
  const config = JSON.stringify({ workerId: `ec2-${job.id.slice(0, 8)}`, coordinatorUrl, projects: { [job.projectId]: checkout }, stateDir: '/var/lib/agent-team', ...workerConfig });
  const quoted = `'${token.replace(/'/g, `'\\''`)}'`;
  const command = `cd ${toolkit} && node core/worker.mjs --config /etc/agent-team/worker.json --once --job ${job.id}`;
  return ['#!/bin/bash', 'set -uo pipefail', 'mkdir -p /etc/agent-team /var/lib/agent-team', `cat > /etc/agent-team/worker.json <<'JSON'`, config, 'JSON',
    `printf 'AGENT_TEAM_TOKEN=%s\\n' ${quoted} > /etc/agent-team/worker.env`, 'chmod 600 /etc/agent-team/worker.env /etc/agent-team/worker.json',
    'if id agent >/dev/null 2>&1; then chown -R agent:agent /etc/agent-team /var/lib/agent-team; RUN="runuser -u agent --"; else RUN=""; fi',
    ...(ssmPrefix ? [`aws ssm get-parameters-by-path ${region ? `--region ${region} ` : ''}--with-decryption --path '${ssmPrefix.replace(/'/g, '')}' --query 'Parameters[].[Name,Value]' --output text | while IFS=$'\\t' read -r name value; do printf '%s=%s\\n' "\${name##*/}" "$value" >> /etc/agent-team/worker.env; done`, 'set -a; . /etc/agent-team/worker.env; set +a'] : []),
    `export AGENT_TEAM_TOKEN=${quoted}`,
    `$RUN bash -c ${JSON.stringify(command).replace(/\$/g, '\\$')} >> /var/log/agent-team-worker.log 2>&1`,
    ...(shutdown ? ['shutdown -h now'] : [])].join('\n') + '\n';
}

// `ssm:/path` in place of an AMI id resolves the current image from Parameter Store, so nightly
// AMI builds update one parameter instead of every manifest.
async function resolveImage(value, { run, env, region }) {
  if (typeof value !== 'string' || !value.startsWith('ssm:')) return value;
  const result = await run(['ssm', 'get-parameter', ...(region ? ['--region', region] : []), '--name', value.slice(4)], { env });
  const image = result.Parameter?.Value;
  if (typeof image !== 'string' || !/^ami-[0-9a-f]+$/.test(image)) throw new Error(`Parameter ${value.slice(4)} does not hold an AMI id`);
  return image;
}

export function create({ region, ami, instanceType = 't3.large', subnetId, securityGroupId, instanceProfile, coordinatorUrl, token, checkout = '/srv/project', keyName,
  spot = true, volumeGb = 60, tags = {}, toolkit, workerConfig, ssmPrefix = null, env = process.env, run = aws } = {}) {
  const requireOption = (name, value) => { if (typeof value !== 'string' || !value.trim()) throw new Error(`ec2 launcher requires ${name}`); return value; };
  const base = (job, market, image) => {
    const spec = { ImageId: image, InstanceType: job.worker?.instanceType ?? instanceType, MinCount: 1, MaxCount: 1,
      InstanceInitiatedShutdownBehavior: 'terminate',
      UserData: Buffer.from(userData({ job, coordinatorUrl: requireOption('coordinatorUrl', coordinatorUrl), token: requireOption('token', job.token ?? token), checkout, workerConfig, toolkit, ssmPrefix, region })).toString('base64'),
      BlockDeviceMappings: [{ DeviceName: '/dev/xvda', Ebs: { VolumeSize: volumeGb, VolumeType: 'gp3', DeleteOnTermination: true } }],
      TagSpecifications: [{ ResourceType: 'instance', Tags: [{ Key: 'Name', Value: `agent-team-${job.projectId}-${job.id.slice(0, 8)}` }, { Key: 'agent-team:job', Value: job.id }, { Key: 'agent-team:project', Value: job.projectId }, ...Object.entries(tags).map(([Key, Value]) => ({ Key, Value }))] }],
      MetadataOptions: { HttpTokens: 'required', HttpEndpoint: 'enabled', HttpPutResponseHopLimit: 1 } };
    if (subnetId) spec.SubnetId = subnetId;
    if (securityGroupId) spec.SecurityGroupIds = [securityGroupId];
    if (instanceProfile) spec.IamInstanceProfile = { Name: instanceProfile };
    if (keyName) spec.KeyName = keyName;
    if (market === 'spot') spec.InstanceMarketOptions = { MarketType: 'spot', SpotOptions: { SpotInstanceType: 'one-time', InstanceInterruptionBehavior: 'terminate' } };
    return spec;
  };
  const regionArgs = region ? ['--region', region] : [];
  return {
    kind: NAME,
    async start(job) {
      const markets = spot ? ['spot', 'on-demand'] : ['on-demand'];
      const image = await resolveImage(requireOption('ami', job.worker?.ami ?? ami), { run, env, region });
      let lastError;
      for (const market of markets) {
        try {
          const result = await run(['ec2', 'run-instances', ...regionArgs, '--cli-input-json', JSON.stringify(base(job, market, image))], { env });
          const instanceId = result.Instances?.[0]?.InstanceId;
          if (!instanceId) throw new Error('RunInstances returned no instance');
          return { kind: NAME, jobId: job.id, instanceId, market, region: region ?? null, startedAt: Date.now() };
        } catch (error) { lastError = error; }
      }
      throw lastError ?? new Error('ec2 launcher could not start an instance');
    },
    async stop(handle) {
      if (!handle?.instanceId) return { stopped: false };
      await run(['ec2', 'terminate-instances', ...regionArgs, '--instance-ids', handle.instanceId], { env });
      return { stopped: true };
    },
    async status(handle) {
      if (!handle?.instanceId) return { state: 'unknown' };
      const result = await run(['ec2', 'describe-instances', ...regionArgs, '--instance-ids', handle.instanceId], { env });
      const state = result.Reservations?.[0]?.Instances?.[0]?.State?.Name ?? 'unknown';
      return { state };
    },
  };
}
