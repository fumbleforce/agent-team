import test from 'node:test';
import assert from 'node:assert/strict';
import { create, refusal, userData, type AwsResult } from './ec2.ts';
import { createLauncher, LAUNCHER_KINDS } from './index.ts';

const job = { id: '0f6b4c2e-1111-4222-8333-444455556666', projectId: 'manti', worker: { instanceType: 'c6i.2xlarge' } };
const specOf = (args: string[]) => JSON.parse(args[args.indexOf('--cli-input-json') + 1]!);

const ALLOWED = { manifest: { publishAuthorized: true }, publish: { scm: 'gitlab', repository: 'group/manti', base: 'main' }, ssmPrefix: '/agent-team/manti' };

test('user data writes worker.json and worker.env before it runs exactly one job and powers off', () => {
  const script = userData({ job, coordinatorUrl: 'http://10.97.0.5:4310', tokenParameter: '/agent-team/manti/jobs/' + job.id, ssmPrefix: '/agent-team/manti', region: 'eu-north-1', publish: ALLOWED.publish });
  assert.match(script, /^#!\/bin\/bash/);
  // Exactly the fields packages/worker/src/main.ts reads (FileConfig), with a worker id no other launch shares.
  const config = JSON.parse(/worker\.json <<'JSON'\n(.*)\nJSON/.exec(script)![1]!);
  assert.deepEqual(config, { coordinatorUrl: 'http://10.97.0.5:4310', workerId: 'ec2-' + job.id, stateDir: '/var/lib/agent-team', engine: 'claude', projects: { manti: '/srv/project' }, worktrees: { branchPrefix: 'agents/', base: 'HEAD' }, publish: ALLOWED.publish });
  assert.ok(script.includes("aws ssm get-parameters-by-path --region eu-north-1 --with-decryption --path '/agent-team/manti'"));
  assert.ok(script.includes("aws ssm get-parameters --region eu-north-1 --with-decryption --names '/agent-team/manti/jobs/" + job.id + "'"));
  assert.ok(script.includes('"AGENT_TEAM_TOKEN=\\(.Value | @sh)"'), 'values are shell-quoted on the instance');
  assert.ok(script.includes('chmod 600 /etc/agent-team/worker.env /etc/agent-team/worker.json')); assert.ok(script.includes('umask 077')); assert.ok(script.includes('chown -R agent:agent /etc/agent-team'));
  const order = ['worker.json <<', 'get-parameters-by-path', 'get-parameters --region', 'chmod 600', 'chown -R', 'node packages/worker/src/main.ts'].map(part => script.indexOf(part));
  assert.deepEqual(order, [...order].sort((x, y) => x - y)); assert.ok(order.every(index => index >= 0), 'both files are complete and owned before the worker starts');
  assert.ok(script.includes('node packages/worker/src/main.ts --config /etc/agent-team/worker.json --once --job ' + job.id));
  assert.ok(script.includes('. /etc/agent-team/worker.env'));
  assert.ok(script.trimEnd().endsWith('shutdown -h now'));
  assert.ok(!userData({ job, coordinatorUrl: 'u', tokenParameter: '/t', shutdown: false }).includes('shutdown'));
  assert.throws(() => userData({ job, coordinatorUrl: 'u', tokenParameter: "/t'; curl evil" }), /not a Parameter Store name/);
});

test('an ephemeral worker is refused unless publishing is authorized, turns run in packet mode and the branch is pushed', async () => {
  const calls: string[][] = [], run = async (args: string[]): Promise<AwsResult> => { calls.push(args); return { Instances: [{ InstanceId: 'i-1' }] }; };
  const common = { ami: 'ami-123', coordinatorUrl: 'u', token: 't', run };
  await assert.rejects(create({ ...common, ...ALLOWED, manifest: {} }).start(job), /refused: the project manifest does not authorize publishing/);
  await assert.rejects(create({ ...common, ...ALLOWED, sessions: 'resume' }).start(job), /refused: turns must run in packet mode/);
  await assert.rejects(create({ ...common, ...ALLOWED, publish: null }).start(job), /refused: no publish target .* pushed at the end of each turn/);
  assert.equal(calls.length, 0, 'a refused launch reaches nothing in the account');
  assert.equal(refusal(ALLOWED), null);
  await assert.rejects(create({ ...common, ...ALLOWED, ssmPrefix: null }).start(job), /requires ssmPrefix/);
});

test('start tries spot then on-demand, tags the instance, and stop and status address it by id', async () => {
  const calls: string[][] = [];
  let spotFails = true;
  const run = async (args: string[]): Promise<AwsResult> => {
    calls.push(args);
    if (args[1] === 'run-instances') {
      if (specOf(args).InstanceMarketOptions?.MarketType === 'spot' && spotFails) throw new Error('InsufficientInstanceCapacity');
      return { Instances: [{ InstanceId: 'i-abc' }] };
    }
    if (args[1] === 'describe-instances') return { Reservations: [{ Instances: [{ State: { Name: 'running' } }] }] };
    return {};
  };
  const launcher = create({ ...ALLOWED, region: 'eu-north-1', ami: 'ami-123', coordinatorUrl: 'https://control.example', token: 'tok', subnetId: 'subnet-1', securityGroupId: 'sg-1', instanceProfile: 'agent-worker', tags: { team: 'devs' }, run });
  const handle = await launcher.start(job);
  assert.deepEqual([handle.instanceId, handle.market, handle.region], ['i-abc', 'on-demand', 'eu-north-1']);
  assert.equal(calls.filter(args => args[1] === 'run-instances').length, 2);
  const spec = specOf(calls[2]!);
  assert.equal(spec.ImageId, 'ami-123'); assert.equal(spec.InstanceType, 'c6i.2xlarge', 'the job may override the instance type');
  assert.equal(spec.InstanceInitiatedShutdownBehavior, 'terminate');
  assert.deepEqual(spec.SubnetId, 'subnet-1'); assert.deepEqual(spec.SecurityGroupIds, ['sg-1']); assert.deepEqual(spec.IamInstanceProfile, { Name: 'agent-worker' });
  assert.equal(spec.InstanceMarketOptions, undefined);
  const tags = spec.TagSpecifications[0].Tags as { Key: string; Value: string }[];
  assert.ok(tags.some(tag => tag.Key === 'agent-team:job' && tag.Value === job.id));
  assert.ok(tags.some(tag => tag.Key === 'team' && tag.Value === 'devs'));
  assert.equal(Buffer.from(spec.UserData, 'base64').toString().includes('--job'), true);
  assert.deepEqual(calls[2]!.slice(0, 4), ['ec2', 'run-instances', '--region', 'eu-north-1']);

  spotFails = false;
  assert.equal((await launcher.start(job)).market, 'spot');
  assert.deepEqual(await launcher.stop(handle), { stopped: true });
  assert.deepEqual(calls.at(-2), ['ec2', 'terminate-instances', '--region', 'eu-north-1', '--instance-ids', 'i-abc']);
  assert.deepEqual(calls.at(-1), ['ssm', 'delete-parameter', '--region', 'eu-north-1', '--name', `/agent-team/manti/jobs/${job.id}`], 'the job token is removed with the instance');
  assert.deepEqual(await launcher.status(handle), { state: 'running' });
  assert.deepEqual(await launcher.stop({}), { stopped: false });
  await assert.rejects(create({ ...ALLOWED, coordinatorUrl: 'u', token: 't', run }).start({ ...job, worker: {} }), /requires ami/);
});

test('an ssm: image reference resolves through Parameter Store and must hold an AMI id', async () => {
  let value = 'ami-0abc';
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<AwsResult> => { calls.push(args); return args[0] === 'ssm' ? { Parameter: { Value: value } } : { Instances: [{ InstanceId: 'i-1' }] }; };
  const launcher = create({ ...ALLOWED, ami: 'ssm:/agent-team/ami', coordinatorUrl: 'u', token: 't', spot: false, run });
  await launcher.start(job);
  assert.deepEqual(calls[0], ['ssm', 'get-parameter', '--name', '/agent-team/ami']);
  assert.equal(specOf(calls[2]!).ImageId, 'ami-0abc');
  value = 'not-an-image';
  await assert.rejects(launcher.start(job), /does not hold an AMI id/);
});

test('the index creates launchers by kind and rejects unknown kinds', async () => {
  assert.deepEqual(LAUNCHER_KINDS, ['local', 'ec2', 'fargate', 'sprite']);
  const local = createLauncher('local');
  assert.equal((await local.start(job)).jobId, job.id);
  assert.deepEqual(await local.status({}), { state: 'external' });
  assert.deepEqual(await local.stop({}), { stopped: false });
  await assert.rejects(createLauncher('fargate').start(job), /not implemented yet/);
  assert.throws(() => createLauncher('balloon'), /Unknown launcher/);
});

test('the job token reaches the instance through Parameter Store: no secret value is in the launch request', async () => {
  const calls: string[][] = [];
  const launcher = create({ ...ALLOWED, ami: 'ami-0123456789abcdef0', coordinatorUrl: 'http://10.0.0.1:4310', token: 'shared-token-that-must-not-travel', spot: false, run: async args => { calls.push(args); return { Instances: [{ InstanceId: 'i-1' }] }; } });
  const token = 'job.' + job.id + '.mac', name = '/agent-team/manti/jobs/' + job.id;
  await launcher.start({ ...job, token });
  assert.deepEqual(calls[0], ['ssm', 'put-parameter', '--name', name, '--type', 'SecureString', '--overwrite', '--value', token]);
  const spec = specOf(calls[1]!), script = Buffer.from(spec.UserData, 'base64').toString();
  assert.ok(script.includes("--names '" + name + "'"), 'the user data names the parameter');
  for (const text of [script, calls[1]!.join(' ')]) { assert.ok(!text.includes(token)); assert.ok(!text.includes('shared-token-that-must-not-travel')); }
  assert.deepEqual(spec.MetadataOptions, { HttpTokens: 'required', HttpEndpoint: 'enabled', HttpPutResponseHopLimit: 1 });
  // A parameter the operator manages is used as it is: nothing is stored or removed.
  calls.length = 0;
  const fixed = create({ ...ALLOWED, ami: 'ami-1', coordinatorUrl: 'u', tokenParameter: '/agent-team/manti/worker-token', spot: false, run: async args => { calls.push(args); return { Instances: [{ InstanceId: 'i-2' }] }; } });
  await fixed.stop(await fixed.start(job));
  assert.deepEqual(calls.map(args => args[1]), ['run-instances', 'terminate-instances']);
  // When no market has capacity the stored token does not stay behind.
  calls.length = 0;
  await assert.rejects(create({ ...ALLOWED, ami: 'ami-1', coordinatorUrl: 'u', token: 't', run: async args => { calls.push(args); if (args[1] === 'run-instances') throw new Error('InsufficientInstanceCapacity'); return {}; } }).start(job), /Insufficient/);
  assert.equal(calls.at(-1)![1], 'delete-parameter');
});
