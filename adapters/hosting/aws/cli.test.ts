import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { awsCli, deploymentFile } from './cli.ts';
import { fakeAws } from './fakeAws.ts';

const FACTS = { projectId: 'example', name: 'Example', checkout: null, region: 'eu-central-1', scm: { kind: 'gitlab', repository: 'group/project', host: 'gitlab.com' },
  worker: { launcher: 'ec2', instanceType: 'c6i.2xlarge', setup: 'npm ci', amiParameter: '/agent-team/example/worker-ami' }, ssmPrefix: '/agent-team/example',
  secrets: [{ name: 'AGENT_TEAM_TOKEN', generated: true, scope: 'control', purpose: 'machine token' }, { name: 'GITLAB_TOKEN', generated: false, purpose: 'gitlab token', adapter: 'gitlab' }] };
const READS = /^(get-|describe-|list-)/;
function setup(facts: object | null = FACTS) {
  const env = { AGENT_TEAM_CONFIG_DIR: mkdtempSync(path.join(os.tmpdir(), 'agent-team-cli-')), GITLAB_TOKEN: 'glpat-value' }, file = deploymentFile(env), lines: string[] = [], account = fakeAws();
  if (facts) writeFileSync(file, JSON.stringify(facts));
  const run = (command: string, ...args: string[]) => awsCli(command, args, { aws: account.run, env, log: line => lines.push(line), options: { sleep: async () => {} } });
  return { env, file, lines, account, run, text: () => lines.join('\n') };
}

test('the deployment file lives in the config directory', () => {
  assert.equal(deploymentFile({ AGENT_TEAM_CONFIG_DIR: '/x' }), path.join('/x', 'aws-deployment.json'));
});

test('deploy without --apply plans: it only reads the account and leaves the file alone', async () => {
  for (const flags of [[], ['--plan'], ['--plan', '--only', 'network,iam']]) {
    const cli = setup();
    assert.equal(await cli.run('deploy', ...flags), 0);
    assert.ok(cli.account.calls.length > 0 && cli.account.calls.every(args => READS.test(args[1]!)), 'only read calls');
    assert.deepEqual(JSON.parse(readFileSync(cli.file, 'utf8')), FACTS);
    assert.match(cli.text(), /Nothing was created or changed\. Apply with: agent-team deploy aws --apply/);
    assert.match(cli.text(), /network: create a dedicated VPC/);
    assert.equal(/secrets:/.test(cli.text()), !flags.includes('--only'));
    assert.ok(!cli.text().includes('glpat-value'));
  }
});

test('deploy --apply runs the steps, takes secret values from the environment and records ids without them', async () => {
  const cli = setup();
  assert.equal(await cli.run('deploy', '--apply', '--skip', 'image'), 0, cli.text());
  assert.equal(cli.account.state.parameters['/agent-team/example/GITLAB_TOKEN'], 'glpat-value');
  assert.ok(cli.account.state.parameters['/agent-team/example/control/AGENT_TEAM_TOKEN'].length >= 32);
  assert.equal(cli.account.state.images.length, 0, '--skip image');
  const saved = readFileSync(cli.file, 'utf8');
  assert.equal(JSON.parse(saved).aws.instanceId, 'i-1'); assert.equal(JSON.parse(saved).version, 1);
  assert.ok(!saved.includes('glpat-value') && !saved.includes(cli.account.state.parameters['/agent-team/example/control/AGENT_TEAM_TOKEN']));
  assert.equal(await cli.run('status'), 0);
  assert.match(cli.text(), /instanceId: i-1/); assert.match(cli.text(), /control plane state: running/);
});

test('errors print their hint, and the hints name commands that exist', async () => {
  const missing = setup(null);
  assert.equal(await missing.run('deploy'), 1);
  assert.match(missing.text(), /No deployment description at .*aws-deployment\.json/);
  const cli = setup(); delete (cli.env as Record<string, string>).GITLAB_TOKEN;
  assert.equal(await cli.run('deploy', '--apply'), 1);
  assert.match(cli.text(), /Secret GITLAB_TOKEN is missing\n\s+Set GITLAB_TOKEN .* agent-team deploy aws --apply/);
  for (const flags of [['--only', 'balloon'], ['--plan', '--apply'], ['--apply', '--permissions-boundary', 'nope']]) { const bad = setup(); assert.equal(await bad.run('deploy', ...flags), 1); assert.equal(bad.account.calls.length, 0); }
});

test('destroy refuses without --yes, lists what it would delete, and with --yes deletes it', async () => {
  const cli = setup();
  await cli.run('deploy', '--apply', '--skip', 'image');
  const before = cli.account.calls.length; cli.lines.length = 0;
  assert.equal(await cli.run('destroy', '--roles'), 1);
  assert.equal(cli.account.calls.length, before, 'no call reaches the account');
  assert.match(cli.text(), /Would delete/); assert.match(cli.text(), /control plane i-1/); assert.match(cli.text(), /security group sg-1/); assert.match(cli.text(), /dedicated network vpc-own/);
  assert.match(cli.text(), /role and instance profile agent-team-example-worker/); assert.match(cli.text(), /Kept: the data volume \(--data\), the secrets \(--secrets\)/);
  assert.match(cli.text(), /agent-team destroy aws --yes/);
  assert.equal(await cli.run('destroy', '--yes'), 0, cli.text());
  assert.deepEqual(cli.account.state.instances, {});
  const saved = JSON.parse(readFileSync(cli.file, 'utf8'));
  assert.equal(saved.aws.instanceId, null); assert.equal(saved.aws.dataVolumeId, 'vol-data', 'the database volume is kept');
  assert.ok(existsSync(cli.file));
});
