#!/usr/bin/env node
import { spawn, execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Writable } from 'node:stream';
import { CONFIG_DIR, deriveFromManifest, generateSecret, listDeployments, newDeployment, readDeployment, writeDeployment } from '../core/deployment.mjs';
import { TOOLKIT_REPO, deploy as awsDeploy, destroy as awsDestroy, image as awsImage, readSecret, secrets as awsSecrets, discover, parameterName, BOUNDARY_ARN, DeployError } from '../adapters/hosting/aws/deploy.mjs';
import { aws } from '../adapters/launcher/ec2.mjs';
import { engineAdapter, validateBilling, validateEngine } from '../adapters/engine/index.mjs';
import { createClient } from '../core/worker.mjs';
import { normalizeManifest, flatTracker } from '../core/manifest.mjs';
import { preflight, renderChecks, blocking } from '../core/preflight.mjs';
import { trackerAdapter, trackerClient } from '../adapters/tracker/index.mjs';
import { readToken as readLocalToken, start as startLocal, writeConfigs as writeLocalConfigs } from '../adapters/hosting/local/up.mjs';
import { parseEnqueueArgs } from '../core/cli.mjs';
import { seedMemory } from '../core/seed-memory.mjs';
import { openInBrowser } from '../core/platform.mjs';

// The owner-facing command. `init` asks for the checkout and the credentials once; everything
// else reads the deployment file it wrote and the project's own manifest.
const USAGE = `Usage: agent-team <command> [project]

  up [checkout]       One command from a checkout to a running team: preflight, tracker labels and
                      inbox, then --target local (this machine, foreground) or --target aws (init,
                      deploy, image, seed). Rerun it any time; every step is idempotent.
  init [checkout]     Register a project: reads its .agent-team.json, asks for credentials once
  deploy [project]    Create or update everything on AWS and print the dashboard address
  image [project]     Rebuild the worker image only (run nightly, or after changing setup)
  status [project]    Show the control plane, image and dashboard address
  open [project]      Open the dashboard in a browser
  password [project]  Show the dashboard password
  logs [project]      Tail the control plane journal over Session Manager
  seed [project]      Seed project memory from the checkout's instruction files
  enqueue <project> --issue KEY-1 [--publish]   Queue a job through the coordinator
  destroy [project]   Remove the AWS resources (asks about roles and the data volume)

Options: --yes (no prompts; fails where one is unavoidable), --config-dir DIR
up only: --target local|aws (default local), --no-pm (skip the resident PM), --no-intake (skip tracker polling),
--engine NAME [--billing MODE] [--model ID] (run on an engine installed here instead of the manifest's default;
stored as a project setting the dashboard shows and can change)
init only: --permissions-boundary ARN (attached to both IAM roles), --toolkit-ref COMMIT (the toolkit
revision the hosts run; defaults to this checkout's commit when it is published), --default-vpc (share the account's
default VPC instead of a dedicated one), --public-dashboard (open port 4311 to your address)`;

// Prompts. Secret input is read with echo off so keys never show in a terminal or scroll-back.
export function prompter({ input = process.stdin, output = process.stdout, answers = null } = {}) {
  const ask = async (question, { secret = false, fallback = null } = {}) => {
    if (answers) { if (!answers.length) throw new Error(`No answer scripted for: ${question}`); return answers.shift(); }
    if (!input.isTTY) throw new DeployError(`Cannot ask "${question}" without a terminal`, 'Run this command interactively, or pass --yes after init has stored everything.');
    const suffix = fallback ? ` [${fallback}]` : '';
    if (!secret) { const rl = createInterface({ input, output }); try { return (await rl.question(`${question}${suffix}: `)).trim() || fallback || ''; } finally { rl.close(); } }
    output.write(`${question}${suffix}: `);
    const muted = new Writable({ write(chunk, encoding, callback) { callback(); } });
    const rl = createInterface({ input, output: muted, terminal: true });
    try { const value = (await rl.question('')).trim(); output.write('\n'); return value; } finally { rl.close(); }
  };
  return ask;
}

// Flags that take a value and pass through to enqueue with it.
const VALUED = ['--issue', '--key', '--base', '--timeout-minutes', '--proposal-limit'];
function parse(argv) {
  const options = { yes: false, configDir: CONFIG_DIR, positional: [], flags: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--yes') options.yes = true;
    else if (arg === '--config-dir' && argv[i + 1]) options.configDir = argv[++i];
    else if (arg === '--permissions-boundary' && argv[i + 1]) options.permissionsBoundary = argv[++i];
    else if (arg === '--toolkit-ref' && argv[i + 1]) options.toolkitRef = argv[++i];
    else if (arg === '--target' && argv[i + 1]) options.target = argv[++i];
    else if (['--engine', '--billing', '--model'].includes(arg) && argv[i + 1]) { options[arg.slice(2)] = argv[i + 1]; options.flags.push(arg, argv[++i]); }
    else if (VALUED.includes(arg) && argv[i + 1]) options.flags.push(arg, argv[++i]);
    else if (arg.startsWith('--')) options.flags.push(arg);
    else options.positional.push(arg);
  }
  return options;
}

function resolveProject(options, name) {
  if (name) { const found = readDeployment(name, options.configDir); if (!found) throw new DeployError(`No deployment named ${name}`, `Run \`agent-team init /path/to/checkout\` first.`); return found; }
  const all = listDeployments(options.configDir);
  if (all.length === 1) return readDeployment(all[0], options.configDir);
  if (!all.length) throw new DeployError('No deployments yet', 'Run `agent-team init /path/to/checkout` first.');
  throw new DeployError(`Several deployments exist (${all.join(', ')})`, 'Name one: agent-team <command> <project>');
}

// The toolkit revision the hosts should run: this checkout's commit when the public repository
// already has it, so what was reviewed locally is what runs and a later push changes nothing.
const TOOLKIT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const git = args => new Promise(resolve => execFile('git', ['-C', TOOLKIT_ROOT, ...args], { timeout: 10_000 }, (error, stdout) => resolve(error ? null : stdout.trim())));
export async function publishedRevision() {
  const head = await git(['rev-parse', 'HEAD']);
  if (!head || !/^[0-9a-f]{40}$/.test(head)) return null;
  const branches = await git(['branch', '-r', '--contains', head]);
  return branches && /^\s*origin\/main$/m.test(branches) ? head : null;
}

const myIp = () => new Promise(resolve => execFile('curl', ['-fsS', 'https://checkip.amazonaws.com'], { timeout: 10_000 }, (error, stdout) => resolve(error ? null : stdout.trim())));
const configuredRegion = () => new Promise(resolve => execFile('aws', ['configure', 'get', 'region'], { timeout: 10_000 }, (error, stdout) => resolve(error ? null : stdout.trim() || null)));

// init: derive everything from the manifest, ask for what cannot be derived, store secrets.
export async function init(options, { ask, log, awsRun = aws, region = configuredRegion, revision = publishedRevision }) {
  const checkoutInput = options.positional[1] ?? await ask('Path to the project checkout', { fallback: process.cwd() });
  const derived = deriveFromManifest(path.resolve(checkoutInput));
  const existing = readDeployment(derived.projectId, options.configDir);
  const deployment = existing ? { ...existing, ...derived, aws: existing.aws } : newDeployment(derived, { region: await region() });
  if (options.permissionsBoundary) { if (!BOUNDARY_ARN.test(options.permissionsBoundary)) throw new DeployError(`${options.permissionsBoundary} is not a policy ARN`, 'Pass the boundary as arn:aws:iam::<account>:policy/<name>.'); deployment.aws.permissionsBoundary = options.permissionsBoundary; }
  if (options.toolkitRef && !/^[\w][\w./-]{0,199}$/.test(options.toolkitRef)) throw new DeployError(`${options.toolkitRef} is not a branch, tag or commit`);
  const ref = options.toolkitRef ?? deployment.toolkit?.ref ?? await revision();
  deployment.toolkit = ref ? { repo: TOOLKIT_REPO, ref } : null;
  log(ref ? `Hosts will run the toolkit at ${ref}` : 'Hosts will follow the toolkit\'s main branch; pin a reviewed commit with --toolkit-ref COMMIT');
  if (options.flags.includes('--default-vpc')) deployment.aws.network = 'default';
  if (options.flags.includes('--public-dashboard')) deployment.aws.dashboard = 'public';
  if (!deployment.aws.region) deployment.aws.region = await ask('AWS region', { fallback: 'eu-central-1' });
  else if (!options.yes && !existing) deployment.aws.region = await ask('AWS region', { fallback: deployment.aws.region });
  log(`Project ${deployment.name} (${deployment.projectId}): ${deployment.scm.kind} ${deployment.scm.repository}, ${deployment.tracker.kind}, ${deployment.engine.default} via ${deployment.engine.billing}, workers on ${deployment.worker.launcher}`);
  await discover(deployment, { aws: awsRun, prompt: options.yes ? null : ask, log });
  const values = {};
  for (const secret of deployment.secrets.filter(secret => !secret.generated)) {
    const name = parameterName(deployment, secret);
    let present = false;
    try { await awsRun(['ssm', 'get-parameter', '--region', deployment.aws.region, '--name', name]); present = true; } catch {}
    if (present && (options.yes || (await ask(`${secret.purpose} is already stored; replace it? (y/N)`)).toLowerCase() !== 'y')) continue;
    values[secret.name] = await ask(`Paste the ${secret.purpose}${secret.optional ? ' (empty to skip; the engine may log in itself)' : ''}`, { secret: true });
    if (!values[secret.name]) { if (secret.optional) { delete values[secret.name]; continue; } throw new DeployError(`${secret.purpose} is required`); }
  }
  await awsSecrets(deployment, { aws: awsRun, values, generate: generateSecret, replace: Object.keys(values), log });
  const file = writeDeployment(deployment, options.configDir);
  log(`Saved ${file}. Next: agent-team deploy ${deployment.projectId}`);
  return deployment;
}

function report(deployment, log) {
  const { aws: a } = deployment;
  log(`${deployment.name} (${deployment.projectId}) in ${a.region}`);
  log(`  control plane  ${a.instanceId ?? 'not launched'}${a.publicIp ? `  ${a.publicIp}` : ''}`);
  const address = a.dashboard === 'public' ? (a.publicIp ? `http://${a.publicIp}:4311` : null) : (a.instanceId ? `agent-team open ${deployment.projectId}  (Session Manager tunnel)` : null);
  log(`  dashboard      ${address ? `${address}  (user: any, password: agent-team password ${deployment.projectId})` : '-'}`);
  log(`  worker image   ${a.amiId ?? (deployment.worker.amiParameter ? 'not built' : 'not needed')}`);
  log(`  data volume    ${a.dataVolumeId ?? '-'}`);
}

// Tracker bootstrap: labels and the owner inbox the roles rely on, created once when the adapter
// can. The inbox issue is stored as a dashboard override so the repository file stays untouched.
export async function bootstrapTracker(manifest, { env = process.env, log, client = null }) {
  const adapter = trackerAdapter(manifest.tracker.kind);
  const tracker = client ?? (adapter.hasCredential ? adapter.hasCredential(env) : env[adapter.API_KEY_VARIABLE]) ? (client ?? trackerClient(manifest.tracker.kind)) : null;
  if (!tracker?.bootstrap) { log(`${adapter.NAME}: create the ready label and an owner inbox issue by hand if they do not exist`); return null; }
  const result = await tracker.bootstrap(flatTracker(manifest), { log });
  log(`${adapter.NAME}: labels in place; owner inbox ${result.ownerInboxIssue}`);
  return result;
}

// The engine this machine runs instead of the manifest's default: the same rule the runner applies
// to a job's engine, so billing and model follow the manifest only while the engine does.
export function engineOverride(manifest, { engine, billing, model } = {}) {
  if (!engine && !billing && !model) return null;
  const name = validateEngine(engine ?? manifest.engine.default);
  const same = name === manifest.engine.default;
  const chosenModel = model ?? (same ? manifest.engine.model : undefined);
  return { default: name, billing: validateBilling(name, billing ?? (same ? manifest.engine.billing : undefined)), ...(chosenModel ? { model: chosenModel } : {}) };
}

// up: from a checkout to a running team, on this machine or on AWS, in one idempotent command.
export async function up(options, { ask, log, awsRun = aws, region = configuredRegion, revision = publishedRevision, env = process.env, run, startLocalImpl = startLocal, seed = seedMemory, open = true, trackerClientImpl = null }) {
  const target = options.target ?? 'local';
  if (!['local', 'aws'].includes(target)) throw new DeployError(`Unknown target ${target}`, 'Use --target local or --target aws');
  const checkout = path.resolve(options.positional[1] ?? process.cwd());
  const file = path.join(checkout, '.agent-team.json');
  let manifest = null;
  if (existsSync(file)) manifest = normalizeManifest(JSON.parse(readFileSync(file, 'utf8')));
  // The checkout's manifest is what the coordinator registers; the engine chosen for this machine
  // travels as a project setting on top of it, like the local launcher does.
  const committed = manifest;
  const engine = manifest ? engineOverride(manifest, options) : null;
  if (engine) manifest = { ...manifest, engine };
  const checks = preflight({ checkout, manifest, target, env, ...(run ? { run } : {}) });
  log(renderChecks(checks));
  const missing = blocking(checks);
  if (missing.length) throw new DeployError(`${missing.length} requirement${missing.length === 1 ? '' : 's'} missing; nothing was created`, 'Fix the items marked MISSING above and rerun agent-team up.');
  const projectId = manifest.queueProjectId ?? manifest.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  let inbox = null;
  try { inbox = await bootstrapTracker(manifest, { env, log, client: trackerClientImpl }); } catch (error) { log(`tracker bootstrap skipped: ${error.message}; create the labels and an owner inbox issue by hand`); }
  const overrides = { ...(inbox?.ownerInboxIssue && !manifest.tracker.ownerInboxIssue ? { tracker: { ownerInboxIssue: inbox.ownerInboxIssue } } : {}), ...(engine ? { engine } : {}) };
  if (target === 'aws') {
    const deployment = await init({ ...options, positional: ['init', checkout] }, { ask, log, awsRun, region, revision });
    const save = current => writeDeployment(current, options.configDir);
    const probe = current => withCoordinator(current, ({ request }) => request('/health'), { attempts: 10 }).catch(error => { throw error instanceof DeployError && !/plugin/i.test(error.hint ?? '') ? new Error(error.message) : error; });
    await awsDeploy(deployment, { aws: awsRun, only: null, save, log, prompt: options.yes ? null : ask, myIp: deployment.aws.dashboard === 'public' ? await myIp() : null, generate: generateSecret, probe });
    await withCoordinator(deployment, async ({ request, url, token }) => {
      await registerManifest(deployment, request, log);
      if (Object.keys(overrides).length) await request(`/projects/${projectId}/settings`, { overrides, author: 'agent-team up', note: 'tracker bootstrap' });
      await seed({ project: checkout, id: projectId, coordinator: url, token, log });
    });
    report(deployment, log);
    log(`
The team is up. Open the dashboard with: agent-team open ${projectId}`);
    return 0;
  }
  // Local: everything on loopback, supervised in the foreground; the worker is this machine.
  const token = readLocalToken(projectId, options.configDir) ?? generateSecret();
  const withPm = !options.flags.includes('--no-pm') && engineAdapterSafe(manifest.engine.default)?.SUPPORTS_ASK !== false;
  const withIntake = !options.flags.includes('--no-intake');
  const local = writeLocalConfigs({ projectId, checkout, manifest, configDir: options.configDir, token, env });
  log(`local control plane in ${local.dir}`);
  const services = startLocalImpl({ files: local.files, token, env, log, withIntake, withPm });
  const request = createClient(local.coordinatorUrl, token);
  for (let attempt = 0; attempt < 40; attempt++) { try { await request('/health'); break; } catch { await new Promise(resolve => setTimeout(resolve, 500)); } if (attempt === 39) { services.stop(); throw new DeployError('The coordinator did not start', 'Check the output above.'); } }
  await request(`/projects/${projectId}/manifest`, { workerId: 'owner', manifest: committed });
  await request(`/projects/${projectId}/settings`, { overrides: { ...overrides, worker: { launcher: 'local' } }, author: 'agent-team up', note: 'local target' });
  try { await seed({ project: checkout, id: projectId, coordinator: local.coordinatorUrl, token, log }); } catch (error) { log(`memory seed skipped: ${error.message}`); }
  log(`
The team is up on this machine. Dashboard: ${local.dashboardUrl}${withPm ? '' : ' (no resident PM: the engine has no bounded sessions or --no-pm was given)'}
Press Ctrl-C to stop everything.`);
  if (open) { try { openInBrowser(local.dashboardUrl); } catch { /* headless */ } }
  const onSignal = () => services.stop();
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  await services.finished;
  process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
  return 0;
}
function engineAdapterSafe(name) { try { return engineAdapter(name); } catch { return null; } }

// A port-forward to the coordinator through Session Manager, for commands run from a laptop.
async function withCoordinator(deployment, fn, { attempts = 30 } = {}) {
  if (!deployment.aws.instanceId) throw new DeployError('Control plane is not deployed', `Run: agent-team deploy ${deployment.projectId}`);
  const port = 14310 + Math.floor(Math.random() * 1000);
  const session = spawn('aws', ['ssm', 'start-session', '--region', deployment.aws.region, '--target', deployment.aws.instanceId, '--document-name', 'AWS-StartPortForwardingSession', '--parameters', JSON.stringify({ portNumber: ['4310'], localPortNumber: [String(port)] })], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  session.stderr.on('data', chunk => { stderr += chunk; });
  try {
    const token = await readSecret(deployment, 'AGENT_TEAM_TOKEN');
    const request = createClient(`http://127.0.0.1:${port}`, token);
    for (let attempt = 0; attempt < attempts; attempt++) {
      try { await request('/health'); break; } catch { if (session.exitCode !== null) throw new DeployError('Session Manager port-forward failed', stderr.includes('SessionManagerPlugin') ? 'Install the Session Manager plugin for the AWS CLI.' : stderr.trim().slice(-300)); await new Promise(resolve => setTimeout(resolve, 1000)); }
    }
    return await fn({ request, url: `http://127.0.0.1:${port}`, token });
  } finally { session.kill(); }
}

// The coordinator learns the project's manifest from the owner's checkout. Launched workers hold a
// job token that may not register one, so a job cannot grant itself autonomy or delivery rights.
export async function registerManifest(deployment, request, log = () => {}) {
  const file = path.join(deployment.checkout, '.agent-team.json');
  if (!existsSync(file)) { log(`No manifest at ${file}; the coordinator keeps the one it has`); return false; }
  await request(`/projects/${deployment.projectId}/manifest`, { workerId: 'owner', manifest: normalizeManifest(JSON.parse(readFileSync(file, 'utf8'))) });
  log(`manifest registered from ${file}`);
  return true;
}

export async function main(argv = process.argv.slice(2), { ask = prompter(), log = console.log, awsRun = aws, region = configuredRegion, revision = publishedRevision, ...extra } = {}) {
  const options = parse(argv);
  const [command, name] = options.positional;
  if (!command || command === 'help' || command === '--help') { log(USAGE); return 0; }
  if (command === 'init') { await init(options, { ask, log, awsRun, region, revision }); return 0; }
  if (command === 'up') return up(options, { ask, log, awsRun, region, revision, ...extra });
  const deployment = resolveProject(options, name);
  const save = current => writeDeployment(current, options.configDir);
  if (command === 'deploy' || command === 'image') {
    const only = command === 'image' ? ['image'] : null;
    // A missing Session Manager plugin stops the deploy with its hint; anything else means "not up yet".
    const probe = current => withCoordinator(current, ({ request }) => request('/health'), { attempts: 10 }).catch(error => { throw error instanceof DeployError && !/plugin/i.test(error.hint ?? '') ? new Error(error.message) : error; });
    await awsDeploy(deployment, { aws: awsRun, only, save, log, prompt: options.yes ? null : ask, myIp: deployment.aws.dashboard === 'public' ? await myIp() : null, generate: generateSecret, probe });
    if (command === 'deploy') await withCoordinator(deployment, ({ request }) => registerManifest(deployment, request, log));
    log('');
    report(deployment, log);
    if (command === 'deploy') log(`\nOpen the dashboard with: agent-team open ${deployment.projectId}\nSeed memory from the checkout with: agent-team seed ${deployment.projectId}`);
    return 0;
  }
  if (command === 'status') { report(deployment, log); return 0; }
  if (command === 'password') { log(await readSecret(deployment, 'AGENT_TEAM_DASHBOARD_PASSWORD', { aws: awsRun })); return 0; }
  if (command === 'open') {
    if (!deployment.aws.instanceId) throw new DeployError('Control plane is not deployed', `Run: agent-team deploy ${deployment.projectId}`);
    const tunnel = deployment.aws.dashboard !== 'public';
    const url = tunnel ? 'http://127.0.0.1:4311/' : `http://${deployment.aws.publicIp}:4311/`;
    const session = tunnel ? spawn('aws', ['ssm', 'start-session', '--region', deployment.aws.region, '--target', deployment.aws.instanceId, '--document-name', 'AWS-StartPortForwardingSession', '--parameters', JSON.stringify({ portNumber: ['4311'], localPortNumber: ['4311'] })], { stdio: ['ignore', 'ignore', 'inherit'] }) : null;
    if (session) await new Promise(resolve => setTimeout(resolve, 3000));
    try { openInBrowser(url); } catch { /* headless */ }
    log(url);
    if (!session) return 0;
    log('Tunnel open; press Ctrl-C to close it.');
    return new Promise(resolve => session.on('exit', code => resolve(code ?? 0)));
  }
  if (command === 'logs') {
    if (!deployment.aws.instanceId) throw new DeployError('Control plane is not deployed', `Run: agent-team deploy ${deployment.projectId}`);
    const child = spawn('aws', ['ssm', 'start-session', '--region', deployment.aws.region, '--target', deployment.aws.instanceId, '--document-name', 'AWS-StartInteractiveCommand', '--parameters', JSON.stringify({ command: ['sudo journalctl -u agent-team -f -n 200'] })], { stdio: 'inherit' });
    return new Promise(resolve => child.on('exit', code => resolve(code ?? 0)));
  }
  if (command === 'seed') {
    return withCoordinator(deployment, async ({ url, token, request }) => { await registerManifest(deployment, request, log); await seedMemory({ project: deployment.checkout, id: deployment.projectId, coordinator: url, token, log }); return 0; });
  }
  if (command === 'enqueue') {
    const body = parseEnqueueArgs(deployment.projectId, options.flags);
    return withCoordinator(deployment, async ({ request }) => { await registerManifest(deployment, request); log(JSON.stringify(await request('/jobs', body), null, 2)); return 0; });
  }
  if (command === 'destroy') {
    const confirm = options.yes ? 'yes' : await ask(`Terminate the control plane and worker images for ${deployment.projectId}? Type the project id to confirm`);
    if (!options.yes && confirm !== deployment.projectId) { log('Nothing removed.'); return 1; }
    const removeData = options.flags.includes('--data') || (!options.yes && (await ask('Also delete the data volume (queue, memory, PM state)? (y/N)')).toLowerCase() === 'y');
    const removeRoles = options.flags.includes('--roles') || (!options.yes && (await ask('Also delete the IAM roles of this project? (y/N)')).toLowerCase() === 'y');
    await awsDestroy(deployment, { aws: awsRun, log, removeData, removeRoles, removeSecrets: options.flags.includes('--secrets') });
    save(deployment);
    log(`Removed. The deployment file ${path.join(options.configDir, `${deployment.projectId}.json`)} is kept for a redeploy.`);
    return 0;
  }
  throw new DeployError(`Unknown command ${command}`, USAGE);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(error.message);
    if (error.hint) console.error(error.hint);
    process.exitCode = 1;
  });
}
