import test from 'node:test';
import assert from 'node:assert/strict';
import { deploy, destroy, controlPlaneUserData, bakeScript, secrets, iam, network, verify, rolePolicies, newDeployment, DeployError, STEPS, type DeploymentFacts } from './deploy.ts';
import { fakeAws, type State } from './fakeAws.ts';

const facts = (): DeploymentFacts => ({ projectId: 'example', name: 'Example', checkout: '/nonexistent', scm: { kind: 'gitlab', repository: 'group/project', host: 'gitlab.com' },
  worker: { launcher: 'ec2', instanceType: 'c6i.2xlarge', setup: 'npm ci', amiParameter: '/agent-team/example/worker-ami' }, ssmPrefix: '/agent-team/example',
  secrets: [{ name: 'AGENT_TEAM_TOKEN', generated: true, scope: 'control', purpose: 'machine token' }, { name: 'LINEAR_API_KEY', generated: false, purpose: 'linear API key', adapter: 'linear' }, { name: 'GITLAB_TOKEN', generated: false, purpose: 'gitlab token', adapter: 'gitlab' }] });
const fresh = () => newDeployment(facts(), { region: 'eu-central-1' });
const hinted = (pattern: RegExp) => (error: unknown) => error instanceof DeployError && pattern.test(error.hint);
const provided = { LINEAR_API_KEY: 'k', GITLAB_TOKEN: 't' };
const noSleep = async () => {};

test('deploy creates every resource once, records ids, and a rerun only verifies what exists', async () => {
  const aws = fakeAws();
  const deployment = fresh();
  const saves: unknown[] = [];
  const log: string[] = [];
  await deploy(deployment, { aws: aws.run, save: current => saves.push(structuredClone(current)), log: line => log.push(line), generate: () => 'generated-secret-value', values: { LINEAR_API_KEY: 'lin_api_secret', GITLAB_TOKEN: 'glpat-secret' }, myIp: '198.51.100.9', sleep: noSleep, now: () => new Date('2026-09-17T20:00:00Z') });
  assert.deepEqual(Object.keys(aws.state.parameters).sort(), ['/agent-team/example/GITLAB_TOKEN', '/agent-team/example/LINEAR_API_KEY', '/agent-team/example/control/AGENT_TEAM_TOKEN', '/agent-team/example/worker-ami']);
  assert.equal(aws.state.parameters['/agent-team/example/worker-ami'], 'ami-1');
  assert.deepEqual([...aws.state.roles].sort(), ['agent-team-example-control', 'agent-team-example-worker']);
  assert.equal(deployment.aws.securityGroupId, 'sg-1'); assert.equal(deployment.aws.instanceId, 'i-1'); assert.equal(deployment.aws.publicIp, '203.0.113.7'); assert.equal(deployment.aws.amiId, 'ami-1'); assert.equal(deployment.aws.dataVolumeId, 'vol-data');
  assert.ok(saves.length >= STEPS.length + 1, 'saved after discovery and every step');
  // Secret values never appear in log lines or in the deployment file.
  const everything = JSON.stringify(log) + JSON.stringify(deployment);
  for (const secret of ['lin_api_secret', 'glpat-secret', 'generated-secret-value']) assert.ok(!everything.includes(secret), secret);
  // The control plane host reads secrets from the same prefix and runs the one entrypoint on the one port.
  const host = aws.state.instances['i-1'];
  assert.match(host.userData, /SSM_PREFIX='\/agent-team\/example'/); assert.match(host.userData, /ExecStart=\/usr\/bin\/node adapters\/hosting\/aws\/entrypoint\.ts/);
  assert.match(host.userData, /systemctl enable --now agent-team\.service/); assert.doesNotMatch(host.userData, /4311|\.mjs/);
  // The builder was terminated after the snapshot; only the control plane remains.
  assert.deepEqual(Object.keys(aws.state.instances), ['i-1']);
  const before = aws.calls.length;
  await deploy(deployment, { aws: aws.run, generate: () => 'x', myIp: '198.51.100.9', sleep: noSleep, skip: ['image'] });
  const rerun = aws.calls.slice(before).map(call => `${call[0]} ${call[1]}`);
  assert.ok(!rerun.includes('ec2 run-instances') && !rerun.includes('ssm put-parameter') && !rerun.includes('iam create-role') && !rerun.includes('ec2 create-security-group'), rerun.join(', '));
  assert.equal(deployment.aws.instanceId, 'i-1');
});

test('a terminated control plane is relaunched with the previous data volume re-attached', async () => {
  const aws = fakeAws();
  const deployment = fresh();
  const options = { aws: aws.run, generate: () => 'x', values: provided, sleep: noSleep, skip: ['image' as const] };
  await deploy(deployment, options);
  delete aws.state.instances['i-1'];
  await deploy(deployment, options);
  assert.equal(deployment.aws.instanceId, 'i-2');
  const attach = aws.calls.find(call => call[1] === 'attach-volume');
  assert.ok(attach?.includes('vol-data') && attach.includes('i-2'));
  const launch = aws.calls.filter(call => call[1] === 'run-instances').at(-1) ?? [];
  assert.ok(!JSON.parse(launch[launch.indexOf('--block-device-mappings') + 1] ?? '[]').some((mapping: State) => mapping.DeviceName === '/dev/xvdf'), 'no second data volume is created');
});

test('missing provided secrets and expired credentials fail with actionable hints', async () => {
  await assert.rejects(secrets(fresh(), { aws: fakeAws().run, values: {}, generate: () => 'x' }), error => error instanceof DeployError && /LINEAR_API_KEY is missing/.test(error.message) && /agent-team deploy aws --apply/.test(error.hint));
  await assert.rejects(deploy(fresh(), { aws: async () => { throw new Error('ExpiredToken'); } }), error => error instanceof DeployError && /credentials are missing or expired/.test(error.message) && /aws login/.test(error.hint));
  // An optional secret nobody provided is skipped, not invented.
  const aws = fakeAws(); const deployment = fresh(); deployment.secrets.push({ name: 'SLACK_TOKEN', generated: false, optional: true, purpose: 'chat token' });
  await secrets(deployment, { aws: aws.run, values: provided, generate: () => 'x' });
  assert.ok(!('/agent-team/example/SLACK_TOKEN' in aws.state.parameters));
});

test('templates are filled from the deployment and refuse unknown placeholders', () => {
  const deployment = fresh();
  assert.equal(controlPlaneUserData(deployment, { template: '#!/bin/bash\necho "$SSM_PREFIX"\n' }), `#!/bin/bash\nexport TOOLKIT_REPO='https://github.com/fumbleforce/agent-team.git' TOOLKIT_REF='main' SSM_PREFIX='/agent-team/example'\necho "$SSM_PREFIX"\n`);
  deployment.toolkit = { repo: 'https://example.test/toolkit.git', ref: '0123456789abcdef0123456789abcdef01234567' };
  assert.match(controlPlaneUserData(deployment, { template: '' }), /TOOLKIT_REPO='https:\/\/example\.test\/toolkit\.git' TOOLKIT_REF='0123456789abcdef0123456789abcdef01234567'/);
  assert.match(bakeScript(deployment), /TOOLKIT_REF="0123456789abcdef0123456789abcdef01234567"/); assert.match(bakeScript(deployment), /set \+x\nTOKEN=/);
  deployment.toolkit = null;
  const bake = bakeScript(deployment, { template: 'clone __PROJECT_HOST__/__PROJECT_REPO__ with __TOKEN_VARIABLE__ then __PROJECT_SETUP__ from __TOOLKIT_REPO__@__TOOLKIT_REF__ in __REGION__ __SSM_PREFIX__' });
  assert.equal(bake, 'clone gitlab.com/group/project with GITLAB_TOKEN then npm ci from https://github.com/fumbleforce/agent-team.git@main in eu-central-1 /agent-team/example');
  assert.throws(() => bakeScript(deployment, { template: '__NOPE__' }), /no value for NOPE/);
  // The real templates: Node 24, the two TypeScript entrypoints, one port, nothing of the old processes.
  // The `\r` guard is not cosmetic: these go to a Linux host, where a CRLF shebang line fails to run.
  const real = bakeScript(deployment);
  assert.match(real, /shutdown -h now/); assert.match(real, /setup_24\.x/); assert.match(real, /ExecStart=\/usr\/bin\/node packages\/worker\/src\/main\.ts /);
  for (const text of [real, controlPlaneUserData(deployment)]) assert.doesNotMatch(text, /4311|\.mjs|DASHBOARD_PASSWORD|__[A-Z_]+__|\r/);
  // Templates handed in by a caller are made LF too: whatever the checkout looks like, what is handed
  // to cloud-init is a Linux script.
  assert.equal(controlPlaneUserData(deployment, { template: '#!/bin/bash\r\necho hi\r\n' }).split('\n').at(-2), 'echo hi');
  assert.equal(bakeScript(deployment, { template: 'set +x\r\nTOKEN=__TOKEN_VARIABLE__\r\n' }), 'set +x\nTOKEN=GITLAB_TOKEN\n');
  deployment.secrets = deployment.secrets.filter(secret => secret.adapter !== 'gitlab');
  assert.throws(() => bakeScript(deployment), hinted(/agent-team status aws/));
});

test('destroy removes instances, images, the group and optionally data, secrets and roles', async () => {
  const aws = fakeAws();
  const deployment = fresh();
  await deploy(deployment, { aws: aws.run, generate: () => 'x', values: provided, sleep: noSleep });
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
  await assert.rejects(iam(deployment, { aws: aws.run, sleep: noSleep }), hinted(/--permissions-boundary/));
  deployment.aws.permissionsBoundary = 'WorkloadBoundary';
  await assert.rejects(iam(deployment, { aws: aws.run, sleep: noSleep }), /not a policy ARN/);
  deployment.aws.permissionsBoundary = 'arn:aws:iam::123456789012:policy/Boundary';
  await iam(deployment, { aws: aws.run, sleep: noSleep });
  const creates = aws.calls.filter(call => call[1] === 'create-role' && call.includes('--permissions-boundary'));
  assert.equal(creates.length, 2); for (const call of creates) assert.equal(call[call.indexOf('--permissions-boundary') + 1], deployment.aws.permissionsBoundary);
  assert.ok(!aws.calls.some(call => call[1] === 'attach-role-policy'));
  assert.deepEqual(aws.calls.filter(call => call[1] === 'detach-role-policy').map(call => call[call.indexOf('--role-name') + 1]), ['agent-team-example-worker'], 'a managed policy from an earlier version is removed, once');
  // A rerun accepts roles that carry the boundary and refuses ones that do not.
  await iam(deployment, { aws: aws.run, sleep: noSleep });
  aws.state.roleDetails[deployment.aws.roles.worker] = {};
  await assert.rejects(iam(deployment, { aws: aws.run, sleep: noSleep }), error => error instanceof DeployError && /without the permissions boundary/.test(error.message));

  const { worker, control } = rolePolicies(deployment);
  const prefix = 'arn:aws:ssm:eu-central-1:123456789012:parameter/agent-team/example';
  assert.ok(!/"ec2:|"iam:|ssmmessages|PutParameter"\]?,"Resource/.test(JSON.stringify(worker.filter(statement => statement.Effect === 'Allow'))), 'workers cannot touch instances, roles, sessions or parameters');
  for (const policy of [worker, control]) {
    assert.deepEqual(policy.find(statement => statement.Effect === 'Deny' && statement.NotResource)?.NotResource, [prefix, `${prefix}/*`]);
    const decrypt = policy.find(statement => statement.Action === 'kms:Decrypt');
    assert.equal(decrypt?.Condition?.StringEquals?.['kms:ViaService'], 'ssm.eu-central-1.amazonaws.com'); assert.equal(decrypt?.Condition?.StringLike?.['kms:EncryptionContext:PARAMETER_ARN'], `${prefix}/*`);
  }
  assert.deepEqual(worker.find(statement => statement.Effect === 'Deny' && statement.Resource)?.Resource, [`${prefix}/control`, `${prefix}/control/*`]);
  assert.ok(!control.some(statement => statement.Effect === 'Deny' && statement.Resource), 'the control plane reads its own secrets');
  const tagged = { StringEquals: { 'aws:ResourceTag/agent-team:project': 'example' } };
  assert.deepEqual(control.find(statement => statement.Action === 'ec2:TerminateInstances')?.Condition, tagged);
  const runs = control.filter(statement => statement.Action === 'ec2:RunInstances');
  assert.deepEqual(runs.find(statement => String(statement.Resource).includes(':instance/'))?.Condition, { StringEquals: { 'aws:RequestTag/agent-team:project': 'example' } });
  assert.deepEqual(runs.find(statement => String(statement.Resource).includes('::image/'))?.Condition, { StringEquals: { 'ec2:ResourceTag/agent-team:project': 'example' } });
  assert.ok(runs.some(statement => Array.isArray(statement.Resource) && statement.Resource.includes('arn:aws:ec2:eu-central-1:123456789012:subnet/subnet-own')));
  assert.ok(!JSON.stringify(runs).includes('subnet/*'), 'no other subnet is launchable');
  assert.deepEqual(control.find(statement => statement.Action === 'ec2:CreateTags')?.Condition, { StringEquals: { 'ec2:CreateAction': 'RunInstances' } });
  assert.deepEqual(control.find(statement => statement.Action === 'iam:PassRole')?.Resource, 'arn:aws:iam::123456789012:role/agent-team-example-worker');
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
  assert.deepEqual(aws.state.egress.map((rule: State) => [rule.FromPort, rule.IpRanges?.[0]?.CidrIp ?? rule.UserIdGroupPairs[0].GroupId]), [[80, '0.0.0.0/0'], [443, '0.0.0.0/0'], [4310, 'sg-1']]);
  // After a destroy that kept the data volume, the new subnet lands in the volume's zone.
  deployment.aws.dataVolumeId = 'vol-data';
  await destroy(deployment, { aws: aws.run });
  assert.equal(deployment.aws.vpcId, null); assert.equal(aws.state.vpc, null);
  await network(deployment, { aws: aws.run });
  assert.equal(aws.state.subnet.zone, 'eu-central-1b');
  assert.equal(aws.state.egress.length, 3, 'rules already present are left alone');
});

test('the default network is an explicit choice, the port opens to the owner only when public, and hosts require IMDSv2', async () => {
  const shared = fakeAws(); const onDefault = fresh(); onDefault.aws.network = 'default'; onDefault.aws.access = 'public';
  const probed: string[] = [];
  await deploy(onDefault, { aws: shared.run, generate: () => 'x', values: provided, myIp: '198.51.100.9', fetchImpl: async url => { probed.push(url); return { ok: true }; }, sleep: noSleep, skip: ['image'] });
  assert.equal(onDefault.aws.vpcId, 'vpc-default'); assert.equal(onDefault.aws.subnetId, 'subnet-default');
  assert.ok(!shared.calls.some(call => call[1] === 'create-vpc'));
  assert.deepEqual([...shared.state.authorized], ['4310 group', '4310 198.51.100.9/32']);
  assert.deepEqual(probed, ['http://203.0.113.7:4310/health']);
  const aws = fakeAws();
  await deploy(fresh(), { aws: aws.run, generate: () => 'x', values: provided, myIp: '198.51.100.9', fetchImpl: async () => { throw new Error('the public address must not be probed'); }, sleep: noSleep });
  assert.deepEqual([...aws.state.authorized], ['4310 group']);
  const launches = aws.calls.filter(item => item[1] === 'run-instances');
  assert.equal(launches.length, 2);
  for (const call of launches) assert.match(call[call.indexOf('--metadata-options') + 1] ?? '', /HttpTokens=required.*HttpPutResponseHopLimit=1/);
});

test('verify waits for the tunnelled coordinator, and stops at once when the tunnel cannot work', async () => {
  const aws = fakeAws(); const deployment = fresh(); deployment.aws.instanceId = 'i-1';
  let probes = 0; const log: string[] = [];
  await verify(deployment, { aws: aws.run, sleep: noSleep, log: line => log.push(line), probe: async () => { if (++probes < 3) throw new Error('connection refused'); } });
  assert.equal(probes, 3); assert.match(log.at(-1) ?? '', /answering through the tunnel/);
  await assert.rejects(verify(deployment, { aws: aws.run, sleep: noSleep, probe: async () => { throw new DeployError('Session Manager port-forward failed', 'Install the Session Manager plugin for the AWS CLI.'); } }), hinted(/plugin/));
  await assert.rejects(verify(deployment, { aws: aws.run, sleep: noSleep, attempts: 2, probe: async () => { throw new Error('never'); } }), hinted(/agent-team status aws/));
});
