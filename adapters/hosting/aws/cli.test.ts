import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Ask } from '../shared/ask.ts';
import { awsCli, deploymentFile, parseRemote } from './cli.ts';
import { fakeAws } from './fakeAws.ts';

const FACTS = { projectId: 'example', name: 'Example', checkout: null, region: 'eu-central-1', scm: { kind: 'gitlab', repository: 'group/project', host: 'gitlab.com' },
  worker: { launcher: 'ec2', instanceType: 'c6i.2xlarge', setup: 'npm ci', amiParameter: '/agent-team/example/worker-ami' }, ssmPrefix: '/agent-team/example',
  secrets: [{ name: 'AGENT_TEAM_TOKEN', generated: true, scope: 'control', purpose: 'machine token' }, { name: 'GITLAB_TOKEN', generated: false, purpose: 'gitlab token', adapter: 'gitlab' }] };
const READS = /^(get-|describe-|list-)/;
function setup(facts: object | null = FACTS, answers: Record<string, string | string[]> | null = null, state: Record<string, unknown> = {}) {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'agent-team-cli-'));
  const env: NodeJS.ProcessEnv = { AGENT_TEAM_CONFIG_DIR: mkdtempSync(path.join(os.tmpdir(), 'agent-team-config-')), GITLAB_TOKEN: 'glpat-value' }, file = path.join(folder, 'aws-deployment.json'), lines: string[] = [], account = fakeAws(state);
  if (facts) writeFileSync(file, JSON.stringify(facts));
  // Answers are matched by a piece of the question, a list giving one answer per time it is asked; a question nobody answered takes its fallback.
  const asked: string[] = [];
  const ask: Ask | null = answers && (async (question, { fallback = '' } = {}) => { asked.push(question); const key = Object.keys(answers).find(piece => question.includes(piece)); const answer = key ? answers[key]! : fallback; return (Array.isArray(answer) ? answer.shift() : answer) ?? fallback; });
  const run = (command: string, ...args: string[]) => awsCli(command, args, { aws: account.run, env, log: line => lines.push(line), options: { sleep: async () => {} }, ask, folder, file });
  return { env, folder, file, lines, account, run, asked, text: () => lines.join('\n') };
}

test('a deployment is described inside its project, found from anywhere within it, and two projects never share one', () => {
  const site = repositoryWith('git@github.com:owner/site.git', {}), shop = repositoryWith('git@github.com:owner/shop.git', {});
  assert.equal(deploymentFile(site), path.join(site, '.agent-team', 'aws-deployment.json'));
  mkdirSync(path.join(site, 'src', 'deep'), { recursive: true });
  assert.equal(deploymentFile(path.join(site, 'src', 'deep')), path.join(site, '.agent-team', 'aws-deployment.json'));
  assert.notEqual(deploymentFile(site), deploymentFile(shop));
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
  const cli = setup(); delete cli.env.GITLAB_TOKEN;
  assert.equal(await cli.run('deploy', '--apply'), 1);
  assert.match(cli.text(), /Secret GITLAB_TOKEN is missing\n\s+Set GITLAB_TOKEN .* agent-team deploy aws --apply/);
  for (const flags of [['--only', 'balloon'], ['--plan', '--apply'], ['--apply', '--permissions-boundary', 'nope']]) { const bad = setup(); assert.equal(await bad.run('deploy', ...flags), 1); assert.equal(bad.account.calls.length, 0); }
});

test('destroy refuses without --yes, lists what it would delete, and with --yes deletes it', async () => {
  const cli = setup();
  await cli.run('deploy', '--apply', '--skip', 'image');
  const before = cli.account.calls.length; cli.lines.length = 0;
  assert.equal(await cli.run('destroy', '--roles'), 1);
  assert.deepEqual(cli.account.calls.slice(before).map(call => call[1]), ['get-caller-identity'], 'only the check of whose account this is reaches it');
  assert.match(cli.text(), /Would delete/); assert.match(cli.text(), /control plane i-1/); assert.match(cli.text(), /security group sg-1/); assert.match(cli.text(), /dedicated network vpc-own/);
  assert.match(cli.text(), /role and instance profile agent-team-example-worker/); assert.match(cli.text(), /Kept: the data volume \(--data\), the secrets \(--secrets\)/);
  assert.match(cli.text(), /agent-team destroy aws --yes/);
  assert.equal(await cli.run('destroy', '--yes'), 0, cli.text());
  assert.deepEqual(cli.account.state.instances, {});
  const saved = JSON.parse(readFileSync(cli.file, 'utf8'));
  assert.equal(saved.aws.instanceId, null); assert.equal(saved.aws.dataVolumeId, 'vol-data', 'the database volume is kept');
  assert.ok(existsSync(cli.file));
});

function checkoutWith(manifest: object | null) {
  const checkout = mkdtempSync(path.join(os.tmpdir(), 'agent-team-checkout-'));
  if (manifest) writeFileSync(path.join(checkout, '.agent-team.json'), JSON.stringify(manifest));
  return checkout;
}
const MANIFEST = { name: 'Example', queueProjectId: 'example', scm: { kind: 'github', repository: 'owner/name' }, tracker: { kind: 'linear' }, worker: { launcher: 'ec2', instanceType: 'c6i.large', setup: 'npm ci' } };

test('init writes the deployment file from a checkout manifest, without reading the account or holding a secret', async () => {
  const cli = setup(null), checkout = checkoutWith(MANIFEST);
  assert.equal(await cli.run('init', checkout, '--region', 'eu-central-1', '--permissions-boundary', 'arn:aws:iam::123456789012:policy/Boundary', '--toolkit-ref', 'abc1234'), 0);
  assert.equal(cli.account.calls.length, 0);
  const written = JSON.parse(readFileSync(cli.file, 'utf8'));
  assert.deepEqual(written.scm, { kind: 'github', repository: 'owner/name', host: 'github.com' });
  assert.deepEqual(written.worker, { launcher: 'ec2', instanceType: 'c6i.large', setup: 'npm ci', amiParameter: '/agent-team/example/worker-ami' });
  assert.deepEqual(written.secrets.map((secret: { name: string }) => secret.name), ['AGENT_TEAM_TOKEN', 'GH_TOKEN', 'LINEAR_API_KEY']);
  assert.equal(written.aws.region, 'eu-central-1');
  assert.equal(written.aws.permissionsBoundary, 'arn:aws:iam::123456789012:policy/Boundary');
  assert.equal(written.toolkit.ref, 'abc1234');
  assert.doesNotMatch(readFileSync(cli.file, 'utf8'), /glpat-value/);
  // What init wrote is what deploy plans from.
  assert.equal(await cli.run('deploy'), 0);
  assert.match(cli.text(), /Plan for example in account/);
});

test('init never writes over a file without being told to, and never over one that records created resources', async () => {
  const checkout = checkoutWith(MANIFEST);
  const cli = setup();
  assert.equal(await cli.run('init', checkout, '--region', 'eu-central-1'), 1);
  assert.match(cli.text(), /already exists\n\s+.*--force/);
  assert.equal(await cli.run('init', checkout, '--region', 'eu-central-1', '--force'), 0);
  const deployed = JSON.parse(readFileSync(cli.file, 'utf8'));
  deployed.aws.instanceId = 'i-0123';
  writeFileSync(cli.file, JSON.stringify(deployed));
  assert.equal(await cli.run('init', checkout, '--region', 'eu-central-1', '--force'), 1);
  assert.match(cli.text(), /records resources that exist in the account\n\s+.*agent-team destroy aws --yes/);
  assert.equal(JSON.parse(readFileSync(cli.file, 'utf8')).aws.instanceId, 'i-0123');
});

test('init says what is missing: a folder, a source host, a region, a valid boundary', async () => {
  for (const [checkout, args, expected] of [
    ['/nonexistent/folder', ['--region', 'eu-central-1'], /does not exist/],
    [checkoutWith({ name: 'X' }), ['--region', 'eu-central-1'], /Cannot tell where .* keeps its code/],
    [checkoutWith(MANIFEST), [], /No AWS region\n\s+Pass --region/],
    [checkoutWith(MANIFEST), ['--region', 'eu-central-1', '--permissions-boundary', 'nope'], /is not a policy ARN/],
  ] as const) {
    const cli = setup(null);
    assert.equal(await cli.run('init', checkout, ...args), 1);
    assert.match(cli.text(), expected);
    assert.equal(existsSync(cli.file), false);
  }
});

function repositoryWith(remote: string, files: Record<string, string>) {
  const checkout = checkoutWith(null);
  const git = (...args: string[]) => execFileSync('git', ['-C', checkout, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('remote', 'add', 'origin', remote);
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(checkout, name), content);
  git('add', '-A');
  return checkout;
}

test('remotes of either form name the host and the repository', () => {
  assert.deepEqual(parseRemote('git@github.com:owner/name.git'), { host: 'github.com', repository: 'owner/name' });
  assert.deepEqual(parseRemote('https://gitlab.example.com/group/sub/project.git'), { host: 'gitlab.example.com', repository: 'group/sub/project' });
  assert.deepEqual(parseRemote('ssh://git@github.com/owner/name'), { host: 'github.com', repository: 'owner/name' });
  assert.equal(parseRemote(''), null);
});

test('init needs no manifest: the git remote names the source, and the tracked files the setup', async () => {
  // The lock file exists but is ignored, so a fresh clone on a worker would not have it.
  const checkout = repositoryWith('git@github.com:owner/site.git', { 'package.json': '{}', '.gitignore': 'package-lock.json\n', 'package-lock.json': '{}' });
  const cli = setup(null);
  assert.equal(await cli.run('init', checkout, '--region', 'eu-central-1'), 0);
  const written = JSON.parse(readFileSync(cli.file, 'utf8'));
  assert.deepEqual(written.scm, { kind: 'github', repository: 'owner/site', host: 'github.com' });
  assert.equal(written.worker.setup, 'npm install');
  assert.equal(written.projectId, path.basename(checkout).toLowerCase().replace(/[^a-z0-9-]/g, '-'));
  assert.match(cli.text(), /has no \.agent-team\.json; going by its git remote and files/);
});

test('init with a terminal asks instead of demanding flags, asks again after a bad answer, and shows the plan', async () => {
  const checkout = repositoryWith('git@github.com:owner/site.git', { 'package.json': '{}' });
  const cli = setup(null, { 'Project folder': checkout, 'Project name': 'The Site', 'Toolkit commit': ['not a commit!', 'abc1234'], 'Apply it now': 'n' });
  assert.equal(await cli.run('init'), 0);
  const written = JSON.parse(readFileSync(cli.file, 'utf8'));
  assert.equal(written.name, 'The Site');
  assert.equal(written.aws.region, 'eu-central-1');
  assert.equal(written.toolkit.ref, 'abc1234');
  assert.equal(cli.asked.filter(question => question.includes('Toolkit commit')).length, 2);
  assert.match(cli.text(), /That is not a branch, tag or commit/);
  // Nobody is asked for a boundary's ARN: deploy finds the one an account uses.
  assert.ok(!cli.asked.some(question => /boundary/i.test(question)));
  assert.match(cli.text(), /Plan for .* in account/);
  assert.ok(cli.account.calls.every(call => READS.test(call[1]!)));
});

test('a flag answers its question ahead of time', async () => {
  const cli = setup(null, { 'Show the plan': 'n' });
  assert.equal(await cli.run('init', checkoutWith(MANIFEST), '--region', 'eu-west-1', '--instance-type', 'c6i.4xlarge'), 0);
  assert.ok(!cli.asked.some(question => question.includes('AWS region') || question.includes('instance type') || question.includes('Project folder')));
  const written = JSON.parse(readFileSync(cli.file, 'utf8'));
  assert.equal(written.aws.region, 'eu-west-1');
  assert.equal(written.worker.instanceType, 'c6i.4xlarge');
});

test('deploy with a terminal and nothing described sets one up, plans, and applies on a yes, asking for the secret it lacks', async () => {
  const checkout = repositoryWith('git@gitlab.com:group/project.git', { 'package.json': '{}' });
  const cli = setup(null, { 'Set one up now': 'y', 'Project folder': checkout, 'Apply it now': 'y', 'gitlab token': 'typed-token' });
  delete cli.env.GITLAB_TOKEN;
  assert.equal(await cli.run('deploy'), 0);
  assert.match(cli.text(), /Plan for .* in account/);
  assert.match(cli.text(), /secret GITLAB_TOKEN stored/);
  assert.match(cli.text(), /Deployed\./);
  assert.ok(cli.account.calls.some(call => call[1] === 'put-parameter' && call.includes('typed-token')));
  assert.doesNotMatch(readFileSync(cli.file, 'utf8'), /typed-token/);
});

test('a plan in a terminal applies nothing on anything but a yes', async () => {
  const cli = setup(FACTS, {});
  assert.equal(await cli.run('deploy'), 0);
  assert.ok(cli.asked.some(question => question.includes('Apply it now')));
  assert.ok(cli.account.calls.every(call => READS.test(call[1]!)));
});

test('destroy in a terminal deletes on a yes, and the database only when the project is named', async () => {
  const declined = setup(FACTS, { 'Delete these': 'n' });
  assert.equal(await declined.run('destroy'), 1);
  assert.ok(declined.account.calls.every(call => READS.test(call[1]!)));
  const agreed = setup(FACTS, { 'Delete these': 'y' });
  assert.equal(await agreed.run('destroy'), 0);
  const wrongName = setup(FACTS, { 'Type the project id': 'yes' });
  assert.equal(await wrongName.run('destroy', '--data'), 1);
  assert.ok(wrongName.account.calls.every(call => READS.test(call[1]!)));
  const named = setup(FACTS, { 'Type the project id': 'example' });
  assert.equal(await named.run('destroy', '--data'), 0);
});

const BOUNDARY = 'arn:aws:iam::123456789012:policy/WorkloadBoundary';

test('an account that uses a permissions boundary has it found and offered, and the roles then carry it', async () => {
  const cli = setup(FACTS, { 'Apply it now': 'y' }, { boundaries: [BOUNDARY], requireBoundary: true });
  assert.equal(await cli.run('deploy'), 0);
  assert.ok(cli.asked.some(question => question.includes('attaches the policy WorkloadBoundary')));
  assert.equal(JSON.parse(readFileSync(cli.file, 'utf8')).aws.permissionsBoundary, BOUNDARY);
  assert.ok(cli.account.calls.filter(call => call[1] === 'create-role').every(call => call.includes(BOUNDARY)));
  assert.match(cli.text(), /Deployed\./);
});

test('several boundaries in use are chosen between by name, and without a terminal the plan only names them', async () => {
  const other = 'arn:aws:iam::123456789012:policy/OtherBoundary';
  const cli = setup(FACTS, { 'Attach which': 'OtherBoundary', 'Apply it now': 'n' }, { boundaries: [BOUNDARY, other] });
  assert.equal(await cli.run('deploy'), 0);
  assert.equal(JSON.parse(readFileSync(cli.file, 'utf8')).aws.permissionsBoundary, other);
  const scripted = setup(FACTS, null, { boundaries: [BOUNDARY] });
  assert.equal(await scripted.run('deploy'), 0);
  assert.match(scripted.text(), /this account uses permissions boundaries \(.*WorkloadBoundary\).*--permissions-boundary/);
  assert.equal(JSON.parse(readFileSync(scripted.file, 'utf8')).aws, undefined);
});

test('roles refused where the boundary could not be looked up: its ARN is asked for once and the deploy carries on', async () => {
  const cli = setup(FACTS, { 'Apply it now': 'y', 'Creating the role was refused': BOUNDARY }, { denyListPolicies: true, requireBoundary: true });
  assert.equal(await cli.run('deploy'), 0);
  assert.match(cli.text(), /Deployed\./);
  assert.equal(JSON.parse(readFileSync(cli.file, 'utf8')).aws.permissionsBoundary, BOUNDARY);
  const gaveUp = setup(FACTS, { 'Apply it now': 'y', 'Creating the role was refused': '' }, { denyListPolicies: true, requireBoundary: true });
  assert.equal(await gaveUp.run('deploy'), 1);
  assert.match(gaveUp.text(), /Creating the role .* was denied/);
});

test('an account without boundaries is asked nothing about them', async () => {
  const cli = setup(FACTS, { 'Apply it now': 'n' });
  assert.equal(await cli.run('deploy'), 0);
  assert.ok(!cli.asked.some(question => /boundar/i.test(question)));
});

test('a question with a guess says how to decline it, since Enter takes the guess', async () => {
  const checkout = repositoryWith('git@github.com:owner/site.git', { 'package.json': '{}' });
  const kept = setup(null, { 'Project folder': checkout, 'Show the plan': 'n' });
  assert.equal(await kept.run('init'), 0);
  assert.equal(JSON.parse(readFileSync(kept.file, 'utf8')).worker.setup, 'npm install');
  const question = kept.asked.find(item => item.includes('sets a fresh clone up'))!;
  assert.match(question, /"none" for no command/);
  assert.doesNotMatch(question, /empty for none/);
  const declined = setup(null, { 'Project folder': checkout, 'sets a fresh clone up': 'none', 'Show the plan': 'n' });
  assert.equal(await declined.run('init'), 0);
  assert.equal(JSON.parse(readFileSync(declined.file, 'utf8')).worker.setup, '');
  // Nothing to guess from: empty really is none, and the question says so.
  const bare = setup(null, { 'Project folder': repositoryWith('git@github.com:owner/docs.git', { 'README.md': '' }), 'Show the plan': 'n' });
  assert.equal(await bare.run('init'), 0);
  assert.match(bare.asked.find(item => item.includes('sets a fresh clone up'))!, /empty for none/);
});

function run(folder: string, env: NodeJS.ProcessEnv, account: ReturnType<typeof fakeAws>, answers: Record<string, string> = {}) {
  const lines: string[] = [];
  const ask: Ask = async (question, { fallback = '' } = {}) => { const key = Object.keys(answers).find(piece => question.includes(piece)); return key ? answers[key]! : fallback; };
  return { lines, go: (command: string, ...args: string[]) => awsCli(command, args, { aws: account.run, env, log: line => lines.push(line), options: { sleep: async () => {} }, ask, folder }) };
}

test('init writes into the project it was run for and records the profile of its account, which every later call uses', async () => {
  const site = repositoryWith('git@gitlab.com:group/site.git', { 'package.json': '{}' });
  const env: NodeJS.ProcessEnv = { AGENT_TEAM_CONFIG_DIR: mkdtempSync(path.join(os.tmpdir(), 'agent-team-config-')), AWS_PROFILE: 'site-operator', GITLAB_TOKEN: 't' };
  const account = fakeAws(), first = run(site, env, account, { 'Apply it now': 'y' });
  assert.equal(await first.go('init'), 0);
  const written = JSON.parse(readFileSync(path.join(site, '.agent-team', 'aws-deployment.json'), 'utf8'));
  assert.equal(written.aws.profile, 'site-operator');
  assert.equal(existsSync(path.join(env.AGENT_TEAM_CONFIG_DIR!, 'aws-deployment.json')), false);
  assert.ok(account.calls.length > 0 && account.calls.every(call => call.join(' ').includes('--profile site-operator')));
  // Another project's profile exported in the shell changes nothing for this one.
  const later = run(site, { ...env, AWS_PROFILE: 'shop-operator' }, account);
  assert.equal(await later.go('status'), 0);
  assert.match(later.lines.join('\n'), /Using the profile recorded for this project, site-operator, not AWS_PROFILE=shop-operator/);
  // And from another project's folder there is nothing to deploy or destroy.
  const shop = repositoryWith('git@gitlab.com:group/shop.git', {});
  const elsewhere = run(shop, env, fakeAws(), { 'Set one up now': 'n' });
  assert.equal(await elsewhere.go('destroy', '--yes'), 1);
  assert.ok(elsewhere.lines.join('\n').includes(`No deployment description at ${path.join(shop, '.agent-team', 'aws-deployment.json')}`));
});

test('what was created in one account is never touched with another account\'s credentials', async () => {
  const cli = setup({ ...FACTS, version: 1, hosting: 'aws', toolkit: null, aws: { region: 'eu-central-1', accountId: '999999999999', network: 'dedicated', access: 'tunnel', permissionsBoundary: null, roles: { control: 'c', worker: 'w' } } });
  for (const command of [['deploy', '--apply'], ['destroy', '--yes'], ['status']]) {
    assert.equal(await cli.run(command[0]!, ...command.slice(1)), 1);
    assert.match(cli.text(), /is in account 999999999999, but the credentials in use are for account 123456789012/);
  }
  assert.ok(cli.account.calls.every(call => call[1] === 'get-caller-identity'));
});

test('the older central file is still used, from the folder of the project it names and from no other', async () => {
  const site = repositoryWith('git@gitlab.com:group/site.git', {}), shop = repositoryWith('git@gitlab.com:group/shop.git', {});
  const env: NodeJS.ProcessEnv = { AGENT_TEAM_CONFIG_DIR: mkdtempSync(path.join(os.tmpdir(), 'agent-team-config-')) };
  writeFileSync(path.join(env.AGENT_TEAM_CONFIG_DIR!, 'aws-deployment.json'), JSON.stringify({ ...FACTS, checkout: site }));
  const here = run(site, env, fakeAws(), { 'Apply it now': 'n' });
  assert.equal(await here.go('deploy'), 0);
  assert.match(here.lines.join('\n'), /older central location\. Move it into the project/);
  const there = run(shop, env, fakeAws(), { 'Set one up now': 'n' });
  assert.equal(await there.go('deploy'), 1);
});
