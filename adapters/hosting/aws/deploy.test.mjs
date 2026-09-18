import test from 'node:test';
import assert from 'node:assert/strict';
import { newDeployment, deriveFromManifest } from '../../../core/deployment.mjs';
import { deploy, destroy, controlPlaneUserData, bakeScript, secrets, iam, network, verify, rolePolicies, DeployError, STEPS } from './deploy.mjs';

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
    // The default VPC always exists; the dedicated one only after it has been created.
    if (service === 'ec2' && action === 'describe-vpcs') return { Vpcs: flag('--filters').includes('is-default') ? [{ VpcId: 'vpc-default' }] : state.vpc ? [{ VpcId: 'vpc-own' }] : [] };
    if (service === 'ec2' && action === 'create-vpc') { state.vpc = { tags: flag('--tag-specifications') }; return { Vpc: { VpcId: 'vpc-own' } }; }
    if (service === 'ec2' && action === 'describe-subnets') return { Subnets: args.includes('Name=vpc-id,Values=vpc-default') ? [{ SubnetId: 'subnet-default', VpcId: 'vpc-default' }] : state.subnet ? [{ SubnetId: 'subnet-own', VpcId: 'vpc-own' }] : [] };
    if (service === 'ec2' && action === 'create-subnet') { state.subnet = { zone: flag('--availability-zone') ?? null }; return { Subnet: { SubnetId: 'subnet-own' } }; }
    if (service === 'ec2' && action === 'describe-volumes') return { Volumes: [{ AvailabilityZone: 'eu-central-1b' }] };
    if (service === 'ec2' && action === 'describe-internet-gateways') return { InternetGateways: state.gateway ? [{ InternetGatewayId: 'igw-1', Attachments: state.gateway.attached ? [{ VpcId: 'vpc-own' }] : [] }] : [] };
    if (service === 'ec2' && action === 'create-internet-gateway') { state.gateway = { attached: false }; return { InternetGateway: { InternetGatewayId: 'igw-1' } }; }
    if (service === 'ec2' && action === 'attach-internet-gateway') { if (state.failAttach) { state.failAttach = false; throw new Error('RequestLimitExceeded'); } state.gateway.attached = true; return {}; }
    if (service === 'ec2' && action === 'detach-internet-gateway') { state.gateway.attached = false; return {}; }
    if (service === 'ec2' && action === 'delete-internet-gateway') { state.gateway = null; return {}; }
    if (service === 'ec2' && action === 'describe-route-tables') return { RouteTables: [{ RouteTableId: 'rtb-1', Routes: state.route ? [{ DestinationCidrBlock: '0.0.0.0/0' }] : [] }] };
    if (service === 'ec2' && action === 'create-route') { state.route = true; return {}; }
    if (service === 'ec2' && action === 'delete-subnet') { state.subnet = null; return {}; }
    if (service === 'ec2' && action === 'delete-vpc') { state.vpc = null; state.route = false; return {}; }
    if (service === 'ssm' && action === 'get-parameter') {
      const name = flag('--name');
      if (name.startsWith('/aws/service/')) return { Parameter: { Value: 'ami-base' } };
      if (!(name in state.parameters)) throw notFound('ParameterNotFound');
      return { Parameter: { Value: state.parameters[name] } };
    }
    if (service === 'ssm' && action === 'describe-instance-information') return { InstanceInformationList: [{ PingStatus: 'Online' }] };
    if (service === 'ssm' && action === 'put-parameter') { state.parameters[flag('--name')] = flag('--value'); return {}; }
    if (service === 'ssm' && action === 'delete-parameter') { delete state.parameters[flag('--name')]; return {}; }
    if (service === 'iam') {
      const name = flag('--role-name') ?? flag('--instance-profile-name');
      if (action === 'get-role') { if (!state.roles.has(name)) throw notFound('NoSuchEntity'); return { Role: state.roleDetails?.[name] ?? {} }; }
      if (action === 'create-role') { if (state.requireBoundary && !args.includes('--permissions-boundary')) throw new Error('AccessDenied: not authorized to perform iam:CreateRole'); state.roles.add(name); (state.roleDetails ??= {})[name] = args.includes('--permissions-boundary') ? { PermissionsBoundary: { PermissionsBoundaryArn: flag('--permissions-boundary') } } : {}; return {}; }
      if (action === 'list-attached-role-policies') return { AttachedPolicies: state.legacyPolicy?.has(name) ? [{ PolicyArn: 'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore' }] : [] };
      if (action === 'detach-role-policy') { state.legacyPolicy?.delete(name); return {}; }
      if (action === 'get-instance-profile') { if (!state.profiles.has(name)) throw notFound('NoSuchEntity'); return {}; }
      if (action === 'create-instance-profile') { state.profiles.add(name); return {}; }
      return {};
    }
    if (service === 'ec2' && action === 'describe-security-groups') { const name = /Values=(.*)/.exec(flag('--filters'))[1]; return { SecurityGroups: state.groups[name] ? [{ GroupId: state.groups[name] }] : [] }; }
    if (service === 'ec2' && action === 'create-security-group') { state.groups[flag('--group-name')] = 'sg-1'; return { GroupId: 'sg-1' }; }
    if (service === 'ec2' && action === 'revoke-security-group-egress') { state.egressRevoked = true; return {}; }
    if (service === 'ec2' && action === 'authorize-security-group-egress') { const rule = JSON.parse(flag('--ip-permissions'))[0]; const key = JSON.stringify(rule); if ((state.egress ??= []).some(item => JSON.stringify(item) === key)) throw new Error('InvalidPermission.Duplicate'); state.egress.push(rule); return {}; }
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
  assert.deepEqual(Object.keys(aws.state.parameters).sort(), ['/agent-team/example/GITLAB_TOKEN', '/agent-team/example/LINEAR_API_KEY', '/agent-team/example/control/AGENT_TEAM_DASHBOARD_PASSWORD', '/agent-team/example/control/AGENT_TEAM_TOKEN', '/agent-team/example/worker-ami']);
  assert.equal(aws.state.parameters['/agent-team/example/worker-ami'], 'ami-1');
  assert.deepEqual([...aws.state.roles].sort(), ['agent-team-example-control', 'agent-team-example-worker']);
  assert.equal(deployment.aws.securityGroupId, 'sg-1'); assert.equal(deployment.aws.instanceId, 'i-1'); assert.equal(deployment.aws.publicIp, '203.0.113.7'); assert.equal(deployment.aws.amiId, 'ami-1'); assert.equal(deployment.aws.dataVolumeId, 'vol-data');
  assert.ok(saves.length >= STEPS.length + 1, 'saved after discovery and every step');
  // Secret values never appear in log lines or in the deployment file.
  const everything = JSON.stringify(log) + JSON.stringify(deployment);
  for (const secret of ['lin_api_secret', 'glpat-secret', 'generated-secret-value']) assert.ok(!everything.includes(secret), secret);
  // The control plane host reads secrets from the same prefix and launches workers into the same group and subnet.
  const host = aws.state.instances['i-1'];
  assert.match(host.userData, /SSM_PREFIX='\/agent-team\/example'/); assert.match(host.userData, /"securityGroupId":"sg-1"/); assert.match(host.userData, /"instanceProfile":"agent-team-example-worker"/); assert.match(host.userData, /PROJECTS_JSON='\{"example":\{"repository":"group\/project"\}\}'/);
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
  assert.match(userData, /^#!\/bin\/bash\nexport TOOLKIT_REPO=.* TOOLKIT_REF='main' SSM_PREFIX=/); assert.match(userData, /X-aws-ec2-metadata-token/);
  deployment.toolkit = { repo: 'https://example.test/toolkit.git', ref: '0123456789abcdef0123456789abcdef01234567' };
  assert.match(controlPlaneUserData(deployment, { template: '' }), /TOOLKIT_REPO='https:\/\/example\.test\/toolkit\.git' TOOLKIT_REF='0123456789abcdef0123456789abcdef01234567'/);
  assert.match(bakeScript(deployment), /TOOLKIT_REF="0123456789abcdef0123456789abcdef01234567"/); assert.match(bakeScript(deployment), /set \+x\nTOKEN=/);
  deployment.toolkit = null; assert.match(userData, /"coordinatorUrl":"http:\/\/COORDINATOR_HOST:4310"/); assert.match(userData, /local-ipv4/);
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

test('roles carry the boundary, reach only this project and never the managed Session Manager policy', async () => {
  const aws = fakeAws({ requireBoundary: true, legacyPolicy: new Set(['agent-team-example-worker']) });
  const deployment = fresh(); deployment.aws.accountId = '123456789012'; deployment.aws.subnetId = 'subnet-own';
  // An account that insists on a boundary explains how to record one instead of a bare AccessDenied.
  await assert.rejects(iam(deployment, { aws: aws.run, sleep: async () => {} }), error => error instanceof DeployError && /--permissions-boundary/.test(error.hint));
  deployment.aws.permissionsBoundary = 'WorkloadBoundary';
  await assert.rejects(iam(deployment, { aws: aws.run, sleep: async () => {} }), /not a policy ARN/);
  deployment.aws.permissionsBoundary = 'arn:aws:iam::123456789012:policy/Boundary';
  await iam(deployment, { aws: aws.run, sleep: async () => {} });
  const creates = aws.calls.filter(call => call[1] === 'create-role' && call.includes('--permissions-boundary'));
  assert.equal(creates.length, 2); for (const call of creates) assert.equal(call[call.indexOf('--permissions-boundary') + 1], deployment.aws.permissionsBoundary);
  assert.ok(!aws.calls.some(call => call[1] === 'attach-role-policy'));
  assert.deepEqual(aws.calls.filter(call => call[1] === 'detach-role-policy').map(call => call[call.indexOf('--role-name') + 1]), ['agent-team-example-worker'], 'a managed policy from an earlier version is removed, once');
  // A rerun accepts roles that carry the boundary and refuses ones that do not.
  await iam(deployment, { aws: aws.run, sleep: async () => {} });
  aws.state.roleDetails[deployment.aws.roles.worker] = {};
  await assert.rejects(iam(deployment, { aws: aws.run, sleep: async () => {} }), error => error instanceof DeployError && /without the permissions boundary/.test(error.message));

  const { worker, control } = rolePolicies(deployment);
  const prefix = 'arn:aws:ssm:eu-central-1:123456789012:parameter/agent-team/example';
  assert.ok(!/"ec2:|"iam:|ssmmessages|PutParameter"\]?,"Resource/.test(JSON.stringify(worker.filter(statement => statement.Effect === 'Allow'))), 'workers cannot touch instances, roles, sessions or parameters');
  for (const policy of [worker, control]) {
    assert.deepEqual(policy.find(statement => statement.Effect === 'Deny' && statement.NotResource).NotResource, [prefix, `${prefix}/*`]);
    const decrypt = policy.find(statement => statement.Action === 'kms:Decrypt');
    assert.equal(decrypt.Condition.StringEquals['kms:ViaService'], 'ssm.eu-central-1.amazonaws.com'); assert.equal(decrypt.Condition.StringLike['kms:EncryptionContext:PARAMETER_ARN'], `${prefix}/*`);
  }
  assert.deepEqual(worker.find(statement => statement.Effect === 'Deny' && statement.Resource).Resource, [`${prefix}/control`, `${prefix}/control/*`]);
  assert.ok(!control.some(statement => statement.Effect === 'Deny' && statement.Resource), 'the control plane reads its own secrets');
  const tagged = { StringEquals: { 'aws:ResourceTag/agent-team:project': 'example' } };
  assert.deepEqual(control.find(statement => statement.Action === 'ec2:TerminateInstances').Condition, tagged);
  const runs = control.filter(statement => statement.Action === 'ec2:RunInstances');
  assert.deepEqual(runs.find(statement => String(statement.Resource).includes(':instance/')).Condition, { StringEquals: { 'aws:RequestTag/agent-team:project': 'example' } });
  assert.deepEqual(runs.find(statement => String(statement.Resource).includes('::image/')).Condition, { StringEquals: { 'ec2:ResourceTag/agent-team:project': 'example' } });
  assert.ok(runs.some(statement => Array.isArray(statement.Resource) && statement.Resource.includes('arn:aws:ec2:eu-central-1:123456789012:subnet/subnet-own')));
  assert.ok(!JSON.stringify(runs).includes('subnet/*'), 'no other subnet is launchable');
  assert.deepEqual(control.find(statement => statement.Action === 'ec2:CreateTags').Condition, { StringEquals: { 'ec2:CreateAction': 'RunInstances' } });
  assert.deepEqual(control.find(statement => statement.Action === 'iam:PassRole').Resource, 'arn:aws:iam::123456789012:role/agent-team-example-worker');
  for (const statement of control.filter(item => typeof item.Action === 'string' && /^(ec2|iam):/.test(item.Action))) assert.notEqual(statement.Resource, '*');
  assert.throws(() => rolePolicies(fresh()), /must be known before roles are written/);
});

test('a dedicated network is built once, completed after a failure, and placed beside a surviving data volume', async () => {
  const aws = fakeAws({ failAttach: true });
  const deployment = fresh(); deployment.aws.accountId = '123456789012';
  await assert.rejects(network(deployment, { aws: aws.run }), /RequestLimitExceeded/);
  await network(deployment, { aws: aws.run });
  assert.equal(deployment.aws.vpcId, 'vpc-own'); assert.equal(deployment.aws.subnetId, 'subnet-own');
  for (const action of ['create-vpc', 'create-subnet', 'create-internet-gateway', 'create-route', 'create-security-group']) assert.equal(aws.calls.filter(call => call[1] === action).length, 1, action);
  assert.ok(aws.state.gateway.attached && aws.state.route);
  assert.match(aws.state.vpc.tags, /Key=agent-team:project,Value=example/);
  assert.ok(!aws.calls.some(call => call.includes('Name=is-default,Values=true')), 'the default network is never consulted');
  // Outbound is web ports plus the coordinator inside the group, not allow-all.
  assert.ok(aws.state.egressRevoked);
  assert.deepEqual(aws.state.egress.map(rule => [rule.FromPort, rule.IpRanges?.[0]?.CidrIp ?? rule.UserIdGroupPairs[0].GroupId]), [[80, '0.0.0.0/0'], [443, '0.0.0.0/0'], [4310, 'sg-1']]);
  // After a destroy that kept the data volume, the new subnet lands in the volume's zone.
  deployment.aws.dataVolumeId = 'vol-data';
  await destroy(deployment, { aws: aws.run });
  assert.equal(deployment.aws.vpcId, null); assert.equal(aws.state.vpc, null);
  await network(deployment, { aws: aws.run });
  assert.equal(aws.state.subnet.zone, 'eu-central-1b');
  assert.equal(aws.state.egress.length, 3, 'rules already present are left alone');
});

test('the default network is an explicit choice, the dashboard port opens only when public, and hosts require IMDSv2', async () => {
  const shared = fakeAws(); const onDefault = fresh(); onDefault.aws.network = 'default'; onDefault.aws.dashboard = 'public';
  await deploy(onDefault, { aws: shared.run, save: () => {}, generate: () => 'x', values: { LINEAR_API_KEY: 'k', GITLAB_TOKEN: 't' }, myIp: '198.51.100.9', fetchImpl: async () => ({ ok: true }), sleep: async () => {}, skip: ['image'] });
  assert.equal(onDefault.aws.vpcId, 'vpc-default'); assert.equal(onDefault.aws.subnetId, 'subnet-default');
  assert.ok(!shared.calls.some(call => call[1] === 'create-vpc'));
  assert.deepEqual([...shared.state.authorized], ['4310', '4311']);
  const aws = fakeAws();
  await deploy(fresh(), { aws: aws.run, save: () => {}, generate: () => 'x', values: { LINEAR_API_KEY: 'k', GITLAB_TOKEN: 't' }, myIp: '198.51.100.9', fetchImpl: async () => { throw new Error('the public address must not be probed'); }, sleep: async () => {}, now: () => new Date() });
  assert.deepEqual([...aws.state.authorized], ['4310']);
  const launches = aws.calls.filter(item => item[1] === 'run-instances');
  assert.equal(launches.length, 2);
  for (const call of launches) assert.match(call[call.indexOf('--metadata-options') + 1], /HttpTokens=required.*HttpPutResponseHopLimit=1/);
});

test('verify waits for the tunnelled coordinator, and stops at once when the tunnel cannot work', async () => {
  const aws = fakeAws(); const deployment = fresh(); deployment.aws.instanceId = 'i-1';
  let probes = 0; const log = [];
  await verify(deployment, { aws: aws.run, sleep: async () => {}, log: line => log.push(line), probe: async () => { if (++probes < 3) throw new Error('connection refused'); } });
  assert.equal(probes, 3); assert.match(log.at(-1), /answering through the tunnel/);
  await assert.rejects(verify(deployment, { aws: aws.run, sleep: async () => {}, probe: async () => { throw new DeployError('Session Manager port-forward failed', 'Install the Session Manager plugin for the AWS CLI.'); } }), error => /plugin/.test(error.hint));
  await assert.rejects(verify(deployment, { aws: aws.run, sleep: async () => {}, attempts: 2, probe: async () => { throw new Error('never'); } }), error => error instanceof DeployError && /agent-team logs example/.test(error.hint));
});
