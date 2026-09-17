import test from 'node:test';
import assert from 'node:assert/strict';
import { newDeployment, deriveFromManifest } from '../../../core/deployment.mjs';
import { deploy, destroy, controlPlaneUserData, bakeScript, secrets, DeployError, STEPS } from './deploy.mjs';

const manifest = { version: 2, name: 'Example', queueProjectId: 'example', instructions: [], scm: { kind: 'gitlab', repository: 'group/project', baseBranch: 'main' },
  tracker: { kind: 'linear', workspaceId: 'w', workspaceUrl: 'https://t/w', teamId: 't', projectId: 'p', projectUrl: 'https://t/p', readyLabel: 'r' },
  engine: { default: 'claude', billing: 'bedrock' }, worker: { launcher: 'ec2', setup: 'npm ci' } };
const fresh = () => newDeployment(deriveFromManifest('/nonexistent', manifest), { region: 'eu-central-1' });
const notFound = name => Object.assign(new Error(`aws x y: An error occurred (${name})`), {});

// A fake AWS account: remembers what was created so a second run finds it.
function fakeAws(state = {}) {
  const calls = [];
  state.parameters ??= {}; state.roles ??= new Set(); state.profiles ??= new Set(); state.groups ??= {}; state.instances ??= {}; state.images ??= []; state.launched ??= 0;
  const run = async args => {
    calls.push(args);
    const [service, action] = args;
    const flag = name => { const index = args.indexOf(name); return index === -1 ? undefined : args[index + 1]; };
    if (service === 'sts') return { Account: '123456789012' };
    if (service === 'ec2' && action === 'describe-vpcs') return { Vpcs: [{ VpcId: 'vpc-1' }] };
    if (service === 'ec2' && action === 'describe-subnets') return { Subnets: [{ SubnetId: 'subnet-1', VpcId: 'vpc-1' }] };
    if (service === 'ssm' && action === 'get-parameter') {
      const name = flag('--name');
      if (name.startsWith('/aws/service/')) return { Parameter: { Value: 'ami-base' } };
      if (!(name in state.parameters)) throw notFound('ParameterNotFound');
      return { Parameter: { Value: state.parameters[name] } };
    }
    if (service === 'ssm' && action === 'put-parameter') { state.parameters[flag('--name')] = flag('--value'); return {}; }
    if (service === 'ssm' && action === 'delete-parameter') { delete state.parameters[flag('--name')]; return {}; }
    if (service === 'iam') {
      const name = flag('--role-name') ?? flag('--instance-profile-name');
      if (action === 'get-role') { if (!state.roles.has(name)) throw notFound('NoSuchEntity'); return {}; }
      if (action === 'create-role') { state.roles.add(name); return {}; }
      if (action === 'get-instance-profile') { if (!state.profiles.has(name)) throw notFound('NoSuchEntity'); return {}; }
      if (action === 'create-instance-profile') { state.profiles.add(name); return {}; }
      return {};
    }
    if (service === 'ec2' && action === 'describe-security-groups') { const name = /Values=(.*)/.exec(flag('--filters'))[1]; return { SecurityGroups: state.groups[name] ? [{ GroupId: state.groups[name] }] : [] }; }
    if (service === 'ec2' && action === 'create-security-group') { state.groups[flag('--group-name')] = 'sg-1'; return { GroupId: 'sg-1' }; }
    if (service === 'ec2' && action === 'authorize-security-group-ingress') { if (state.authorized?.has(flag('--port'))) throw new Error('Duplicate rule'); (state.authorized ??= new Set()).add(flag('--port')); return {}; }
    if (service === 'ec2' && action === 'run-instances') {
      const id = `i-${++state.launched}`;
      state.instances[id] = { InstanceId: id, State: { Name: 'running' }, PublicIpAddress: '203.0.113.7', PrivateIpAddress: '10.0.0.7', BlockDeviceMappings: [{ DeviceName: '/dev/xvdf', Ebs: { VolumeId: 'vol-data' } }], userData: flag('--user-data'), tags: flag('--tag-specifications') };
      return { Instances: [{ InstanceId: id }] };
    }
    if (service === 'ec2' && action === 'describe-instances') {
      const ids = flag('--instance-ids'); if (ids && !state.instances[ids]) throw notFound('InvalidInstanceID.NotFound');
      const list = ids ? [state.instances[ids]] : Object.values(state.instances);
      return { Reservations: [{ Instances: list }] };
    }
    if (service === 'ec2' && action === 'wait') return {};
    if (service === 'ec2' && action === 'create-image') { const id = `ami-${state.images.length + 1}`; state.images.push({ ImageId: id, CreationDate: String(state.images.length), BlockDeviceMappings: [{ Ebs: { SnapshotId: `snap-${id}` } }] }); return { ImageId: id }; }
    if (service === 'ec2' && action === 'describe-images') return { Images: [...state.images] };
    if (service === 'ec2' && action === 'deregister-image') { state.images = state.images.filter(image => image.ImageId !== flag('--image-id')); return {}; }
    if (service === 'ec2' && action === 'terminate-instances') { for (const id of args.slice(args.indexOf('--instance-ids') + 1).filter(a => a.startsWith('i-'))) delete state.instances[id]; return {}; }
    return {};
  };
  return { run, calls, state };
}

test('deploy creates every resource once, records ids, and a rerun only verifies what exists', async () => {
  const aws = fakeAws();
  const deployment = fresh();
  const saves = [];
  const log = [];
  const fetchImpl = async () => ({ ok: false, status: 401 });
  await deploy(deployment, { aws: aws.run, save: current => saves.push(structuredClone(current)), log: line => log.push(line), generate: () => 'generated-secret-value', values: { LINEAR_API_KEY: 'lin_api_secret', GITLAB_TOKEN: 'glpat-secret' }, myIp: '198.51.100.9', fetchImpl, sleep: async () => {}, now: () => new Date('2026-09-17T20:00:00Z') });
  assert.deepEqual(Object.keys(aws.state.parameters).sort(), ['/agent-team/example/AGENT_TEAM_DASHBOARD_PASSWORD', '/agent-team/example/AGENT_TEAM_TOKEN', '/agent-team/example/GITLAB_TOKEN', '/agent-team/example/LINEAR_API_KEY', '/agent-team/example/worker-ami']);
  assert.equal(aws.state.parameters['/agent-team/example/worker-ami'], 'ami-1');
  assert.deepEqual([...aws.state.roles].sort(), ['agent-team-control', 'agent-team-worker']);
  assert.equal(deployment.aws.securityGroupId, 'sg-1'); assert.equal(deployment.aws.instanceId, 'i-1'); assert.equal(deployment.aws.publicIp, '203.0.113.7'); assert.equal(deployment.aws.amiId, 'ami-1'); assert.equal(deployment.aws.dataVolumeId, 'vol-data');
  assert.ok(saves.length >= STEPS.length + 1, 'saved after discovery and every step');
  // Secret values never appear in log lines or in the deployment file.
  const everything = JSON.stringify(log) + JSON.stringify(deployment);
  for (const secret of ['lin_api_secret', 'glpat-secret', 'generated-secret-value']) assert.ok(!everything.includes(secret), secret);
  // The control plane host reads secrets from the same prefix and launches workers into the same group and subnet.
  const host = aws.state.instances['i-1'];
  assert.match(host.userData, /SSM_PREFIX='\/agent-team\/example'/); assert.match(host.userData, /"securityGroupId":"sg-1"/); assert.match(host.userData, /"instanceProfile":"agent-team-worker"/); assert.match(host.userData, /PROJECTS_JSON='\{"example":\{"repository":"group\/project"\}\}'/);
  assert.match(host.userData, /systemctl enable --now agent-team\.service/);
  // The builder was terminated after the snapshot; only the control plane remains.
  assert.deepEqual(Object.keys(aws.state.instances), ['i-1']);
  const before = aws.calls.length;
  await deploy(deployment, { aws: aws.run, save: () => {}, generate: () => 'x', myIp: '198.51.100.9', fetchImpl, sleep: async () => {}, skip: ['image'] });
  const rerun = aws.calls.slice(before).map(call => `${call[0]} ${call[1]}`);
  assert.ok(!rerun.includes('ec2 run-instances') && !rerun.includes('ssm put-parameter') && !rerun.includes('iam create-role') && !rerun.includes('ec2 create-security-group'), rerun.join(', '));
  assert.equal(deployment.aws.instanceId, 'i-1');
});

test('a terminated control plane is relaunched with the previous data volume re-attached', async () => {
  const aws = fakeAws();
  const deployment = fresh();
  const options = { aws: aws.run, save: () => {}, generate: () => 'x', values: { LINEAR_API_KEY: 'k', GITLAB_TOKEN: 't' }, fetchImpl: async () => ({ ok: true }), sleep: async () => {}, skip: ['image'] };
  await deploy(deployment, options);
  delete aws.state.instances['i-1'];
  await deploy(deployment, options);
  assert.equal(deployment.aws.instanceId, 'i-2');
  const attach = aws.calls.find(call => call[1] === 'attach-volume');
  assert.ok(attach && attach.includes('vol-data') && attach.includes('i-2'));
  const launch = aws.calls.filter(call => call[1] === 'run-instances').at(-1);
  assert.ok(!JSON.parse(launch[launch.indexOf('--block-device-mappings') + 1]).some(mapping => mapping.DeviceName === '/dev/xvdf'), 'no second data volume is created');
});

test('missing provided secrets and expired credentials fail with actionable hints', async () => {
  const deployment = fresh();
  await assert.rejects(secrets(deployment, { aws: fakeAws().run, values: {}, generate: () => 'x' }), error => error instanceof DeployError && /LINEAR_API_KEY is missing/.test(error.message) && /agent-team init example/.test(error.hint));
  await assert.rejects(deploy(fresh(), { aws: async () => { throw new Error('ExpiredToken'); }, save: () => {} }), error => /credentials are missing or expired/.test(error.message) && /aws login/.test(error.hint));
});

test('templates are filled from the deployment and refuse unknown placeholders', () => {
  const deployment = fresh(); deployment.aws.subnetId = 'subnet-1'; deployment.aws.securityGroupId = 'sg-1';
  const userData = controlPlaneUserData(deployment, { template: '#!/bin/bash\necho "$PROJECTS_JSON" "$LAUNCHER_JSON"\n' });
  assert.match(userData, /^#!\/bin\/bash\nexport SSM_PREFIX=/); assert.match(userData, /"coordinatorUrl":"http:\/\/COORDINATOR_HOST:4310"/); assert.match(userData, /local-ipv4/);
  const bake = bakeScript(deployment, { template: 'clone __PROJECT_HOST__/__PROJECT_REPO__ with __TOKEN_VARIABLE__ then __PROJECT_SETUP__ from __TOOLKIT_REPO__@__TOOLKIT_REF__ in __REGION__ __SSM_PREFIX__' });
  assert.equal(bake, 'clone gitlab.com/group/project with GITLAB_TOKEN then npm ci from https://github.com/fumbleforce/agent-team.git@main in eu-central-1 /agent-team/example');
  assert.throws(() => bakeScript(deployment, { template: '__NOPE__' }), /no value for NOPE/);
  assert.match(bakeScript(deployment), /shutdown -h now/);
});

test('destroy removes instances, images, the group and optionally data, secrets and roles', async () => {
  const aws = fakeAws();
  const deployment = fresh();
  await deploy(deployment, { aws: aws.run, save: () => {}, generate: () => 'x', values: { LINEAR_API_KEY: 'k', GITLAB_TOKEN: 't' }, fetchImpl: async () => ({ ok: true }), sleep: async () => {}, now: () => new Date() });
  await destroy(deployment, { aws: aws.run, removeData: true, removeSecrets: true });
  assert.deepEqual(Object.keys(aws.state.instances), []); assert.deepEqual(aws.state.images, []);
  assert.deepEqual(Object.keys(aws.state.parameters), []);
  assert.ok(aws.calls.some(call => call[1] === 'delete-volume' && call.includes('vol-data')));
  assert.ok(!aws.calls.some(call => call[1] === 'delete-role'), 'roles are kept unless asked');
  assert.equal(deployment.aws.instanceId, null); assert.equal(deployment.aws.dataVolumeId, null);
  await destroy(deployment, { aws: aws.run, removeRoles: true });
  assert.equal(aws.calls.filter(call => call[1] === 'delete-role').length, 2);
});
