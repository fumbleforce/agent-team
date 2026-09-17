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
  assert.equal(deployment.aws.region, 'eu-north-1'); assert.equal(deployment.aws.subnetId, 'subnet-1'); assert.equal(deployment.aws.accountId, '123456789012');
  assert.equal(aws.parameters['/agent-team/example/LINEAR_API_KEY'], 'lin_api_secret'); assert.equal(aws.parameters['/agent-team/example/GITLAB_TOKEN'], 'glpat-secret');
  assert.ok(aws.parameters['/agent-team/example/AGENT_TEAM_TOKEN']?.length >= 30, 'the coordinator token is generated');
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
