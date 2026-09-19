import test from 'node:test';
import assert from 'node:assert/strict';
import { create, userData, type AwsResult } from './ec2.ts';
import { createLauncher, LAUNCHER_KINDS } from './index.ts';

const job = { id: '0f6b4c2e-1111-4222-8333-444455556666', projectId: 'manti', worker: { instanceType: 'c6i.2xlarge' } };
const specOf = (args: string[]) => JSON.parse(args[args.indexOf('--cli-input-json') + 1]!);

test('user data writes the worker configuration, runs exactly one job and powers off', () => {
  const script = userData({ job, coordinatorUrl: 'https://control.example:8443', token: "it's-secret", checkout: '/srv/project' });
  assert.match(script, /^#!\/bin\/bash/);
  const config = JSON.parse(/<<'JSON'\n(.*)\nJSON/.exec(script)![1]!);
  assert.deepEqual(config, { workerId: 'ec2-0f6b4c2e', coordinatorUrl: 'https://control.example:8443', projects: { manti: '/srv/project' }, stateDir: '/var/lib/agent-team' });
  assert.ok(script.includes(`export AGENT_TEAM_TOKEN='it'\\''s-secret'`), 'single quotes inside the token are escaped for the shell');
  assert.ok(script.includes(`node packages/worker/src/main.ts --config /etc/agent-team/worker.json --once --job ${job.id}`));
  assert.ok(script.trimEnd().endsWith('shutdown -h now'));
  assert.ok(!userData({ job, coordinatorUrl: 'u', token: 't', shutdown: false }).includes('shutdown'));
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
  const launcher = create({ region: 'eu-north-1', ami: 'ami-123', coordinatorUrl: 'https://control.example', token: 'tok', subnetId: 'subnet-1', securityGroupId: 'sg-1', instanceProfile: 'agent-worker', tags: { team: 'devs' }, run });
  const handle = await launcher.start(job);
  assert.deepEqual([handle.instanceId, handle.market, handle.region], ['i-abc', 'on-demand', 'eu-north-1']);
  assert.equal(calls.filter(args => args[1] === 'run-instances').length, 2);
  const spec = specOf(calls[1]!);
  assert.equal(spec.ImageId, 'ami-123'); assert.equal(spec.InstanceType, 'c6i.2xlarge', 'the job may override the instance type');
  assert.equal(spec.InstanceInitiatedShutdownBehavior, 'terminate');
  assert.deepEqual(spec.SubnetId, 'subnet-1'); assert.deepEqual(spec.SecurityGroupIds, ['sg-1']); assert.deepEqual(spec.IamInstanceProfile, { Name: 'agent-worker' });
  assert.equal(spec.InstanceMarketOptions, undefined);
  const tags = spec.TagSpecifications[0].Tags as { Key: string; Value: string }[];
  assert.ok(tags.some(tag => tag.Key === 'agent-team:job' && tag.Value === job.id));
  assert.ok(tags.some(tag => tag.Key === 'team' && tag.Value === 'devs'));
  assert.equal(Buffer.from(spec.UserData, 'base64').toString().includes('--job'), true);
  assert.deepEqual(calls[1]!.slice(0, 4), ['ec2', 'run-instances', '--region', 'eu-north-1']);

  spotFails = false;
  assert.equal((await launcher.start(job)).market, 'spot');
  assert.deepEqual(await launcher.stop(handle), { stopped: true });
  assert.deepEqual(calls.at(-1), ['ec2', 'terminate-instances', '--region', 'eu-north-1', '--instance-ids', 'i-abc']);
  assert.deepEqual(await launcher.status(handle), { state: 'running' });
  assert.deepEqual(await launcher.stop({}), { stopped: false });
  await assert.rejects(create({ coordinatorUrl: 'u', token: 't', run }).start({ ...job, worker: {} }), /requires ami/);
});

test('an ssm: image reference resolves through Parameter Store and must hold an AMI id', async () => {
  let value = 'ami-0abc';
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<AwsResult> => { calls.push(args); return args[0] === 'ssm' ? { Parameter: { Value: value } } : { Instances: [{ InstanceId: 'i-1' }] }; };
  const launcher = create({ ami: 'ssm:/agent-team/ami', coordinatorUrl: 'u', token: 't', spot: false, run });
  await launcher.start(job);
  assert.deepEqual(calls[0], ['ssm', 'get-parameter', '--name', '/agent-team/ami']);
  assert.equal(specOf(calls[1]!).ImageId, 'ami-0abc');
  value = 'not-an-image';
  await assert.rejects(launcher.start(job), /does not hold an AMI id/);
});

test('the index creates launchers by kind and rejects unknown kinds', async () => {
  assert.deepEqual(LAUNCHER_KINDS, ['local', 'ec2', 'fargate', 'fly-machine']);
  const local = createLauncher('local');
  assert.equal((await local.start(job)).jobId, job.id);
  assert.deepEqual(await local.status({}), { state: 'external' });
  assert.deepEqual(await local.stop({}), { stopped: false });
  for (const kind of ['fargate', 'fly-machine']) await assert.rejects(createLauncher(kind).start(job), /not implemented yet/);
  assert.throws(() => createLauncher('balloon'), /Unknown launcher/);
});

test('the token the coordinator issues for the job travels in the user data, never the shared one', async () => {
  const calls: string[][] = [];
  const launcher = create({ ami: 'ami-0123456789abcdef0', coordinatorUrl: 'http://10.0.0.1:4310', token: 'shared-token-that-must-not-travel', run: async args => { calls.push(args); return { Instances: [{ InstanceId: 'i-1' }] }; } });
  await launcher.start({ ...job, token: `job.${job.id}.mac` });
  const spec = specOf(calls[0]!);
  const script = Buffer.from(spec.UserData, 'base64').toString();
  assert.ok(script.includes(`job.${job.id}.mac`)); assert.ok(!script.includes('shared-token-that-must-not-travel'));
  assert.deepEqual(spec.MetadataOptions, { HttpTokens: 'required', HttpEndpoint: 'enabled', HttpPutResponseHopLimit: 1 });
});
