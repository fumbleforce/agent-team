#!/usr/bin/env node
import { spawn, execFile } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { Writable } from 'node:stream';
import { CONFIG_DIR, deriveFromManifest, generateSecret, listDeployments, newDeployment, readDeployment, writeDeployment } from '../core/deployment.mjs';
import { deploy as awsDeploy, destroy as awsDestroy, image as awsImage, readSecret, secrets as awsSecrets, discover, DeployError } from '../adapters/hosting/aws/deploy.mjs';
import { aws } from '../adapters/launcher/ec2.mjs';
import { createClient } from '../core/worker.mjs';
import { parseEnqueueArgs } from '../core/cli.mjs';
import { seedMemory } from '../core/seed-memory.mjs';

// The owner-facing command. `init` asks for the checkout and the credentials once; everything
// else reads the deployment file it wrote and the project's own manifest.
const USAGE = `Usage: agent-team <command> [project]

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

Options: --yes (no prompts; fails where one is unavoidable), --config-dir DIR`;

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

function parse(argv) {
  const options = { yes: false, configDir: CONFIG_DIR, positional: [], flags: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--yes') options.yes = true;
    else if (arg === '--config-dir' && argv[i + 1]) options.configDir = argv[++i];
    else if (arg.startsWith('--') && options.positional.length >= 2) options.flags.push(arg);
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

const myIp = () => new Promise(resolve => execFile('curl', ['-fsS', 'https://checkip.amazonaws.com'], { timeout: 10_000 }, (error, stdout) => resolve(error ? null : stdout.trim())));
const configuredRegion = () => new Promise(resolve => execFile('aws', ['configure', 'get', 'region'], { timeout: 10_000 }, (error, stdout) => resolve(error ? null : stdout.trim() || null)));

// init: derive everything from the manifest, ask for what cannot be derived, store secrets.
export async function init(options, { ask, log, awsRun = aws }) {
  const checkoutInput = options.positional[1] ?? await ask('Path to the project checkout', { fallback: process.cwd() });
  const derived = deriveFromManifest(path.resolve(checkoutInput));
  const existing = readDeployment(derived.projectId, options.configDir);
  const deployment = existing ? { ...existing, ...derived, aws: existing.aws } : newDeployment(derived, { region: await configuredRegion() });
  if (!deployment.aws.region) deployment.aws.region = await ask('AWS region', { fallback: 'eu-central-1' });
  else if (!options.yes && !existing) deployment.aws.region = await ask('AWS region', { fallback: deployment.aws.region });
  log(`Project ${deployment.name} (${deployment.projectId}): ${deployment.scm.kind} ${deployment.scm.repository}, ${deployment.tracker.kind}, ${deployment.engine.default} via ${deployment.engine.billing}, workers on ${deployment.worker.launcher}`);
  await discover(deployment, { aws: awsRun, prompt: options.yes ? null : ask, log });
  const values = {};
  for (const secret of deployment.secrets.filter(secret => !secret.generated)) {
    const name = `${deployment.ssmPrefix}/${secret.name}`;
    let present = false;
    try { await awsRun(['ssm', 'get-parameter', '--region', deployment.aws.region, '--name', name]); present = true; } catch {}
    if (present && (options.yes || (await ask(`${secret.purpose} is already stored; replace it? (y/N)`)).toLowerCase() !== 'y')) continue;
    values[secret.name] = await ask(`Paste the ${secret.purpose}`, { secret: true });
    if (!values[secret.name]) throw new DeployError(`${secret.purpose} is required`);
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
  log(`  dashboard      ${a.publicIp ? `http://${a.publicIp}:4311  (user: any, password: agent-team password ${deployment.projectId})` : '-'}`);
  log(`  worker image   ${a.amiId ?? (deployment.worker.amiParameter ? 'not built' : 'not needed')}`);
  log(`  data volume    ${a.dataVolumeId ?? '-'}`);
}

// A port-forward to the coordinator through Session Manager, for commands run from a laptop.
async function withCoordinator(deployment, fn) {
  if (!deployment.aws.instanceId) throw new DeployError('Control plane is not deployed', `Run: agent-team deploy ${deployment.projectId}`);
  const port = 14310 + Math.floor(Math.random() * 1000);
  const session = spawn('aws', ['ssm', 'start-session', '--region', deployment.aws.region, '--target', deployment.aws.instanceId, '--document-name', 'AWS-StartPortForwardingSession', '--parameters', JSON.stringify({ portNumber: ['4310'], localPortNumber: [String(port)] })], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  session.stderr.on('data', chunk => { stderr += chunk; });
  try {
    const token = await readSecret(deployment, 'AGENT_TEAM_TOKEN');
    const request = createClient(`http://127.0.0.1:${port}`, token);
    for (let attempt = 0; attempt < 30; attempt++) {
      try { await request('/health'); break; } catch { if (session.exitCode !== null) throw new DeployError('Session Manager port-forward failed', stderr.includes('SessionManagerPlugin') ? 'Install the Session Manager plugin for the AWS CLI.' : stderr.trim().slice(-300)); await new Promise(resolve => setTimeout(resolve, 1000)); }
    }
    return await fn({ request, url: `http://127.0.0.1:${port}`, token });
  } finally { session.kill(); }
}

export async function main(argv = process.argv.slice(2), { ask = prompter(), log = console.log, awsRun = aws } = {}) {
  const options = parse(argv);
  const [command, name] = options.positional;
  if (!command || command === 'help' || command === '--help') { log(USAGE); return 0; }
  if (command === 'init') { await init(options, { ask, log, awsRun }); return 0; }
  const deployment = resolveProject(options, name);
  const save = current => writeDeployment(current, options.configDir);
  if (command === 'deploy' || command === 'image') {
    const only = command === 'image' ? ['image'] : null;
    await awsDeploy(deployment, { aws: awsRun, only, save, log, prompt: options.yes ? null : ask, myIp: await myIp(), generate: generateSecret });
    log('');
    report(deployment, log);
    if (command === 'deploy') log(`\nOpen the dashboard with: agent-team open ${deployment.projectId}\nSeed memory from the checkout with: agent-team seed ${deployment.projectId}`);
    return 0;
  }
  if (command === 'status') { report(deployment, log); return 0; }
  if (command === 'password') { log(await readSecret(deployment, 'AGENT_TEAM_DASHBOARD_PASSWORD', { aws: awsRun })); return 0; }
  if (command === 'open') {
    if (!deployment.aws.publicIp) throw new DeployError('Control plane is not deployed', `Run: agent-team deploy ${deployment.projectId}`);
    const url = `http://${deployment.aws.publicIp}:4311/`;
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    spawn(opener, [url], { stdio: 'ignore', detached: true }).unref();
    log(url); return 0;
  }
  if (command === 'logs') {
    if (!deployment.aws.instanceId) throw new DeployError('Control plane is not deployed', `Run: agent-team deploy ${deployment.projectId}`);
    const child = spawn('aws', ['ssm', 'start-session', '--region', deployment.aws.region, '--target', deployment.aws.instanceId, '--document-name', 'AWS-StartInteractiveCommand', '--parameters', JSON.stringify({ command: ['sudo journalctl -u agent-team -f -n 200'] })], { stdio: 'inherit' });
    return new Promise(resolve => child.on('exit', code => resolve(code ?? 0)));
  }
  if (command === 'seed') {
    return withCoordinator(deployment, async ({ url, token }) => { await seedMemory({ project: deployment.checkout, id: deployment.projectId, coordinator: url, token, log }); return 0; });
  }
  if (command === 'enqueue') {
    const body = parseEnqueueArgs(deployment.projectId, options.flags);
    return withCoordinator(deployment, async ({ request }) => { log(JSON.stringify(await request('/jobs', body), null, 2)); return 0; });
  }
  if (command === 'destroy') {
    const confirm = options.yes ? 'yes' : await ask(`Terminate the control plane and worker images for ${deployment.projectId}? Type the project id to confirm`);
    if (!options.yes && confirm !== deployment.projectId) { log('Nothing removed.'); return 1; }
    const removeData = options.flags.includes('--data') || (!options.yes && (await ask('Also delete the data volume (queue, memory, PM state)? (y/N)')).toLowerCase() === 'y');
    const removeRoles = options.flags.includes('--roles') || (!options.yes && (await ask('Also delete the shared IAM roles? Only if no other project uses them. (y/N)')).toLowerCase() === 'y');
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
