import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main, prompter } from './agent-team.mjs';
import { readDeployment } from '../core/deployment.mjs';

const manifest = { version: 2, name: 'Example', queueProjectId: 'example', instructions: [], scm: { kind: 'gitlab', repository: 'group/project', baseBranch: 'main' },
  tracker: { kind: 'linear', workspaceId: 'w', workspaceUrl: 'https://t/w', teamId: 't', projectId: 'p', projectUrl: 'https://t/p', readyLabel: 'r' },
  engine: { default: 'claude', billing: 'bedrock' }, worker: { launcher: 'ec2' } };

// Enough of AWS for init: identity, default network, and a parameter store.
function fakeAws(parameters = {}) {
  const calls = [];
  const run = async args => {
    calls.push(args);
    const flag = name => args[args.indexOf(name) + 1];
    if (args[0] === 'sts') return { Account: '123456789012' };
    if (args[1] === 'describe-vpcs') return { Vpcs: [{ VpcId: 'vpc-1' }] };
    if (args[1] === 'describe-subnets') return { Subnets: [{ SubnetId: 'subnet-1', VpcId: 'vpc-1' }] };
    if (args[1] === 'get-parameter') { if (!(flag('--name') in parameters)) throw new Error('ParameterNotFound'); return { Parameter: { Value: parameters[flag('--name')] } }; }
    if (args[1] === 'put-parameter') { parameters[flag('--name')] = flag('--value'); return {}; }
    return {};
  };
  return { run, calls, parameters };
}

test('init derives the project from its manifest, asks only for the credentials, and stores them once', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cli-config-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const checkout = mkdtempSync(path.join(os.tmpdir(), 'cli-checkout-')); t.after(() => rmSync(checkout, { recursive: true, force: true }));
  writeFileSync(path.join(checkout, '.agent-team.json'), JSON.stringify(manifest));
  const aws = fakeAws();
  const answers = ['eu-north-1', 'lin_api_secret', 'glpat-secret'];
  const log = [];
  assert.equal(await main(['init', checkout, '--config-dir', dir], { ask: prompter({ answers }), log: line => log.push(line), awsRun: aws.run, region: async () => 'eu-central-1' }), 0);
  assert.deepEqual(answers, [], 'every scripted answer was consumed: region, tracker key, SCM token');
  const deployment = readDeployment('example', dir);
  assert.equal(deployment.aws.region, 'eu-north-1'); assert.equal(deployment.aws.accountId, '123456789012');
  // Safe defaults: a network of its own (created by deploy, not init), a tunnelled dashboard, roles named for the project.
  assert.deepEqual([deployment.aws.network, deployment.aws.dashboard, deployment.aws.subnetId, deployment.aws.permissionsBoundary], ['dedicated', 'tunnel', null, null]);
  assert.deepEqual(deployment.aws.roles, { control: 'agent-team-example-control', worker: 'agent-team-example-worker' });
  assert.ok(!aws.calls.some(call => /^(create|run|authorize|put-role)/.test(call[1])), 'init creates nothing but parameters');
  assert.equal(aws.parameters['/agent-team/example/LINEAR_API_KEY'], 'lin_api_secret'); assert.equal(aws.parameters['/agent-team/example/GITLAB_TOKEN'], 'glpat-secret');
  assert.ok(aws.parameters['/agent-team/example/control/AGENT_TEAM_TOKEN']?.length >= 30, 'the coordinator token is generated, out of the workers\' reach');
  assert.ok(aws.parameters['/agent-team/example/control/AGENT_TEAM_DASHBOARD_PASSWORD'] && !aws.parameters['/agent-team/example/AGENT_TEAM_TOKEN']);
  const everything = JSON.stringify(log) + JSON.stringify(deployment);
  assert.ok(!everything.includes('lin_api_secret') && !everything.includes('glpat-secret'));
  assert.match(log.at(-1), /agent-team deploy example/);
  // A second init with --yes keeps stored credentials and asks nothing.
  const before = { ...aws.parameters };
  assert.equal(await main(['init', checkout, '--config-dir', dir, '--yes'], { ask: prompter({ answers: [] }), log: () => {}, awsRun: aws.run }), 0);
  assert.deepEqual(aws.parameters, before);
});

test('commands resolve the only deployment without a name and fail plainly when nothing is set up', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cli-config-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(main(['status', '--config-dir', dir], { ask: prompter({ answers: [] }), log: () => {} }), error => /No deployments yet/.test(error.message) && /agent-team init/.test(error.hint));
  const checkout = mkdtempSync(path.join(os.tmpdir(), 'cli-checkout-')); t.after(() => rmSync(checkout, { recursive: true, force: true }));
  writeFileSync(path.join(checkout, '.agent-team.json'), JSON.stringify(manifest));
  const aws = fakeAws();
  await main(['init', checkout, '--config-dir', dir, '--yes'], { ask: prompter({ answers: ['k', 't'] }), log: () => {}, awsRun: aws.run, region: async () => 'eu-central-1' });
  const log = [];
  assert.equal(await main(['status', '--config-dir', dir], { ask: prompter({ answers: [] }), log: line => log.push(line), awsRun: aws.run }), 0);
  assert.match(log.join('\n'), /control plane\s+not launched/); assert.match(log.join('\n'), /worker image\s+not built/);
  await assert.rejects(main(['open', '--config-dir', dir], { ask: prompter({ answers: [] }), log: () => {}, awsRun: aws.run }), /not deployed/);
  await assert.rejects(main(['status', 'nope', '--config-dir', dir], { ask: prompter({ answers: [] }), log: () => {} }), /No deployment named nope/);
  await assert.rejects(main(['bogus', '--config-dir', dir], { ask: prompter({ answers: [] }), log: () => {} }), /Unknown command/);
  // Without a terminal and without scripted answers, prompting fails instead of hanging.
  await assert.rejects(prompter({ input: { isTTY: false } })('Question'), /without a terminal/);
});

test('init records a permissions boundary and the opt-outs from the dedicated network and the tunnelled dashboard', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cli-config-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const checkout = mkdtempSync(path.join(os.tmpdir(), 'cli-checkout-')); t.after(() => rmSync(checkout, { recursive: true, force: true }));
  writeFileSync(path.join(checkout, '.agent-team.json'), JSON.stringify(manifest));
  const boundary = 'arn:aws:iam::123456789012:policy/WorkloadBoundary';
  const log = [];
  const run = (options, revision = async () => null) => main(['init', checkout, '--config-dir', dir, '--yes', ...options], { ask: prompter({ answers: ['k', 't'] }), log: line => log.push(line), awsRun: fakeAws().run, region: async () => 'eu-central-1', revision });
  await assert.rejects(run(['--permissions-boundary', 'WorkloadBoundary']), error => /not a policy ARN/.test(error.message));
  await run(['--permissions-boundary', boundary, '--default-vpc', '--public-dashboard']);
  const deployment = readDeployment('example', dir);
  assert.deepEqual([deployment.aws.permissionsBoundary, deployment.aws.network, deployment.aws.dashboard, deployment.aws.subnetId], [boundary, 'default', 'public', 'subnet-1']);
  // Without a published commit the hosts follow main, and init says so; a published commit or an explicit ref pins them.
  assert.equal(deployment.toolkit, null); assert.match(log.join('\n'), /follow the toolkit's main branch/);
  const sha = '0123456789abcdef0123456789abcdef01234567';
  await run([], async () => sha);
  assert.deepEqual(readDeployment('example', dir).toolkit, { repo: 'https://github.com/fumbleforce/agent-team.git', ref: sha });
  await run([], async () => 'f'.repeat(40));
  assert.equal(readDeployment('example', dir).toolkit.ref, sha, 'a pin is kept until it is changed on purpose');
  await run(['--toolkit-ref', 'v1.2.0']);
  assert.equal(readDeployment('example', dir).toolkit.ref, 'v1.2.0');
  await assert.rejects(run(['--toolkit-ref', '$(reboot)']), /not a branch, tag or commit/);
});

test('the owner\'s checkout is the source of the manifest the coordinator holds', async t => {
  const checkout = mkdtempSync(path.join(os.tmpdir(), 'cli-checkout-')); t.after(() => rmSync(checkout, { recursive: true, force: true }));
  const { registerManifest } = await import('./agent-team.mjs');
  const sent = [];
  assert.equal(await registerManifest({ checkout, projectId: 'example' }, async (...args) => sent.push(args)), false);
  writeFileSync(path.join(checkout, '.agent-team.json'), JSON.stringify(manifest));
  assert.equal(await registerManifest({ checkout, projectId: 'example' }, async (...args) => sent.push(args)), true);
  assert.equal(sent.length, 1); assert.equal(sent[0][0], '/projects/example/manifest'); assert.equal(sent[0][1].workerId, 'owner'); assert.equal(sent[0][1].manifest.worker.launcher, 'ec2');
});
