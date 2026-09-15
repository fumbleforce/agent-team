import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const toolkitRoot = path.dirname(fileURLToPath(import.meta.url));
const url = 'http://127.0.0.1:4310';
const usage = 'Usage: install-local.mjs --project /absolute/checkout --key myntbase --repository fumbleforce/stockapp [--dry-run | --install]';

export function parseArgs(args) {
  const options = {}; const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag)) throw new Error(usage);
    seen.add(flag);
    if (flag === '--install' || flag === '--dry-run') options.install = flag === '--install';
    else if (['--project', '--key', '--repository'].includes(flag) && args[i + 1] && !args[i + 1].startsWith('--')) options[flag.slice(2)] = args[++i];
    else throw new Error(usage);
  }
  if (seen.has('--install') && seen.has('--dry-run')) throw new Error(usage);
  if (!options.project || !options.key || !options.repository) throw new Error(usage);
  return options;
}

function clean(value) {
  if (typeof value !== 'string' || !value || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Expected a nonempty value without control characters');
  return value;
}
function absolute(value) {
  if (!path.isAbsolute(clean(value))) throw new Error('Paths must be absolute');
  return path.normalize(value);
}
function stat(file) {
  try { return lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
// Check every component, including existing ancestors of not-yet-created files.
function inspect(file, directory = false) {
  const parent = path.dirname(file);
  if (parent !== file) inspect(parent, true);
  const info = stat(file);
  if (info && (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()))) throw new Error(`Unsafe path: ${file}`);
  if (info && !directory && (info.nlink !== 1 || info.uid !== process.getuid())) throw new Error(`Unsafe file ownership or links: ${file}`);
  return info;
}
function readExisting(file) {
  if (!inspect(file)) return null;
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid()) throw new Error(`Unsafe file: ${file}`);
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}
function privateDirectory(dir) {
  inspect(dir, true);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = inspect(dir, true);
  if (info.uid !== process.getuid()) throw new Error(`Directory is not owned by current user: ${dir}`);
  chmodSync(dir, 0o700);
}
function atomicWrite(file, contents, previous) {
  if (readExisting(file) !== previous) throw new Error(`File changed during installation: ${file}`);
  if (previous === contents) { chmodSync(file, 0o600); return; }
  const temp = `${file}.${randomBytes(12).toString('hex')}.tmp`;
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { writeFileSync(fd, contents); fsyncSync(fd); }
    finally { closeSync(fd); }
    if (readExisting(file) !== previous) throw new Error(`File changed during installation: ${file}`);
    // link publishes absent files exclusively: concurrent installers cannot rotate a token.
    if (previous === null) linkSync(temp, file);
    else renameSync(temp, file);
  } finally { if (stat(temp)) unlinkSync(temp); }
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function config(file, text, defaults, key, registration) {
  let existing = {};
  if (text !== null) {
    try { existing = JSON.parse(text); } catch { throw new Error(`Invalid JSON config: ${file}`); }
    if (!object(existing) || !object(existing.projects)) throw new Error(`Invalid project config: ${file}`);
  }
  for (const [name, value] of Object.entries(defaults)) {
    if (Object.hasOwn(existing, name) && !isDeepStrictEqual(existing[name], value)) throw new Error(`Conflicting ${name} in ${file}`);
  }
  if (Object.hasOwn(existing.projects ?? {}, key) && !isDeepStrictEqual(existing.projects[key], registration)) throw new Error(`Conflicting project registration in ${file}`);
  return JSON.stringify({ ...existing, ...defaults, projects: { ...existing.projects, [key]: registration } }, null, 2) + '\n';
}
// systemd specifiers apply to paths; dollar expansion additionally applies to ExecStart.
function quote(value, exec = false) {
  let result = clean(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%');
  if (exec) result = result.replaceAll('$', () => '$$');
  return `"${result}"`;
}
function envQuote(value) {
  return `"${clean(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '\\$').replaceAll('`', '\\`')}"`;
}
function unit(role, { toolkit, nodePath, configDir }) {
  const script = role === 'coordinator' ? 'queue.mjs' : 'worker.mjs';
  return `# Generated by agent-team install-local.mjs v1\n[Unit]\nDescription=Agent team ${role}\n${role === 'worker' ? 'After=agent-team-coordinator.service\n' : ''}\n[Service]\nType=simple\nWorkingDirectory=${clean(toolkit).replaceAll('%', '%%')}\nEnvironmentFile=${clean(path.join(configDir, 'service.env')).replaceAll('%', '%%')}\nEnvironment="AGENT_TEAM_URL=${url}"\nExecStart=${quote(nodePath, true)} ${quote(path.join(toolkit, script), true)} --config ${quote(path.join(configDir, `${role}.json`), true)}\nRestart=on-failure\nRestartSec=10\nTimeoutStopSec=45\nKillMode=mixed\nUMask=0077\n`;
}

// Dependency injection is deliberately API-only; the CLI always uses the actual user/runtime.
export function install({ project, key, repository, install: write = false, home = homedir(), toolkit = toolkitRoot,
  nodePath = process.execPath, workerId = hostname(), existingPath = process.env.PATH ?? '',
  resolveOpencode = () => {
    const result = spawnSync('which', ['opencode'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
    if (result.status !== 0) throw new Error('Cannot resolve opencode on PATH');
    return result.stdout.replace(/\r?\n$/, '');
  }, log = console.log } = {}) {
  if (process.platform !== 'linux') throw new Error('Local installation requires Linux');
  project = absolute(project); home = absolute(home); toolkit = absolute(toolkit); nodePath = absolute(nodePath);
  if (!/^[a-zA-Z0-9][\w.-]{0,127}$/.test(key ?? '') || !/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) throw new Error(usage);
  if (!/^[\w.-]{1,128}$/.test(workerId)) throw new Error('Invalid worker hostname');
  if (!stat(project)?.isDirectory()) throw new Error('Project must be an existing directory');
  const opencode = absolute(resolveOpencode());
  const servicePath = [path.dirname(nodePath), path.dirname(opencode), clean(existingPath)].join(':');
  const configDir = path.join(home, '.config/agent-team');
  const stateDir = path.join(home, '.local/state/agent-team');
  const unitDir = path.join(home, '.config/systemd/user');
  const directories = [configDir, stateDir, path.join(stateDir, 'worker')];
  for (const dir of [...directories, unitDir]) inspect(dir, true);
  for (const dir of directories) {
    const info = stat(dir);
    if (info && info.uid !== process.getuid()) throw new Error(`Directory is not owned by current user: ${dir}`);
  }
  const envFile = path.join(configDir, 'service.env');
  const oldEnv = readExisting(envFile);
  let token;
  if (oldEnv !== null) {
    // Accept only this installer's private environment shape; never echo its contents.
    const match = /^AGENT_TEAM_TOKEN=([a-f0-9]{64})\nPATH="(?:[^"\\\r\n]|\\[\\"$`])*"\n$/.exec(oldEnv);
    if (!match) throw new Error(`Unrecognized environment file: ${envFile}`);
    token = match[1];
  }
  const files = [];
  for (const [role, defaults, registration] of [
    ['coordinator', { host: '127.0.0.1', port: 4310, db: path.join(stateDir, 'queue.sqlite') }, { repository }],
    ['worker', { coordinatorUrl: url, workerId, concurrency: 1, stateDir: path.join(stateDir, 'worker') }, project]
  ]) {
    const file = path.join(configDir, `${role}.json`); const previous = readExisting(file);
    files.push({ file, previous, contents: config(file, previous, defaults, key, registration) });
    const service = path.join(unitDir, `agent-team-${role}.service`);
    const oldUnit = readExisting(service); const contents = unit(role, { toolkit, nodePath, configDir });
    if (oldUnit !== null && oldUnit !== contents) throw new Error(`Refusing to replace differing service unit: ${service}`);
    files.push({ file: service, previous: oldUnit, contents });
  }
  if (write) {
    for (const dir of directories) privateDirectory(dir);
    mkdirSync(unitDir, { recursive: true, mode: 0o700 });
    token ??= randomBytes(32).toString('hex');
    atomicWrite(envFile, `AGENT_TEAM_TOKEN=${token}\nPATH=${envQuote(servicePath)}\n`, oldEnv);
    for (const entry of files) atomicWrite(entry.file, entry.contents, entry.previous);
  }
  const paths = [envFile, ...files.map(entry => entry.file)];
  for (const file of paths) log(file);
  log('systemctl --user daemon-reload');
  log('systemctl --user start agent-team-coordinator.service agent-team-worker.service');
  return { paths, installed: write };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { install(parseArgs(process.argv.slice(2))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
