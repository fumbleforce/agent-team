import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackersWithCredentials } from '../../tracker/index.mjs';

// The local hosting target: coordinator, dashboard, intake, resident PM and one worker on this
// machine, supervised by one process, everything bound to loopback. State lives under
// <configDir>/local/<project>/; the service environment file holds the generated token with
// owner-only permissions. Nothing here survives a reboot: that is what the systemd adapter is for.
const TOOLKIT = path.dirname(path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))));
export const PORTS = { coordinator: 4310, dashboard: 4311 };

export function localDir(projectId, configDir) { return path.join(configDir, 'local', projectId); }

// Writes every service configuration for one project. `token` is generated once and reused.
export function writeConfigs({ projectId, checkout, manifest, configDir, token, env = process.env, engine = manifest.engine.default, billing = manifest.engine.billing, model = manifest.engine.model }) {
  const dir = localDir(projectId, configDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const data = path.join(dir, 'data'); mkdirSync(data, { recursive: true, mode: 0o700 });
  const write = (name, value) => { const file = path.join(dir, name); writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); return file; };
  const coordinatorUrl = `http://127.0.0.1:${PORTS.coordinator}`;
  const files = {
    coordinator: write('coordinator.json', { host: '127.0.0.1', port: PORTS.coordinator, db: path.join(data, 'queue.sqlite'), dataDir: data, dashboardUrl: `http://127.0.0.1:${PORTS.dashboard}`, projects: { [projectId]: { repository: manifest.scm.repository ?? projectId } } }),
    worker: write('worker.json', { coordinatorUrl, workerId: hostname().slice(0, 32) || 'local', concurrency: 1, stateDir: path.join(data, 'worker'), projects: { [projectId]: checkout }, engine }),
    dashboard: write('dashboard.json', { host: '127.0.0.1', port: PORTS.dashboard, coordinatorUrl, hostname: 'local' }),
    intake: write('intake.json', { coordinatorUrl, pollSeconds: 60, trackers: trackersWithCredentials(env), projects: { [projectId]: checkout } }),
    pm: write('pm.json', { coordinatorUrl, engine, billing, ...(model ? { model } : {}), dataDir: path.join(data, 'pm'), pollSeconds: 20, dailyHourUtc: 7, repositories: { [projectId]: checkout } }),
  };
  const envFile = path.join(dir, 'service.env');
  writeFileSync(envFile, `AGENT_TEAM_TOKEN=${token}\nAGENT_TEAM_URL=${coordinatorUrl}\n`, { mode: 0o600 });
  chmodSync(envFile, 0o600);
  return { dir, files, envFile, coordinatorUrl, dashboardUrl: `http://127.0.0.1:${PORTS.dashboard}/` };
}

export function readToken(projectId, configDir) {
  const file = path.join(localDir(projectId, configDir), 'service.env');
  if (!existsSync(file)) return null;
  return /^AGENT_TEAM_TOKEN=(\S+)$/m.exec(readFileSync(file, 'utf8'))?.[1] ?? null;
}

// Starts the services in dependency order and stops all of them when one exits or on a signal.
// The engine that answers the PM and owner chat is the manifest's default engine.
export function start({ files, token, env = process.env, log = console.log, toolkit = TOOLKIT, spawnImpl = spawn, withIntake = true, withPm = true }) {
  const serviceEnv = { ...env, AGENT_TEAM_TOKEN: token, AGENT_TEAM_URL: `http://127.0.0.1:${PORTS.coordinator}` };
  const children = new Map();
  let stopping = false;
  const stop = () => { if (stopping) return; stopping = true; for (const child of children.values()) if (child.exitCode === null) child.kill('SIGTERM'); };
  const startOne = (name, script, config, delay) => new Promise(resolve => setTimeout(() => {
    if (stopping) return resolve();
    const child = spawnImpl(process.execPath, [path.join(toolkit, script), '--config', config], { env: serviceEnv, stdio: ['ignore', 'inherit', 'inherit'] });
    children.set(name, child);
    child.on('exit', code => { if (!stopping) { log(`${name} exited with ${code}; stopping the local control plane`); stop(); } });
    resolve(child);
  }, delay));
  const plan = [['coordinator', 'core/queue.mjs', files.coordinator, 0], ['dashboard', 'core/dashboard.mjs', files.dashboard, 1200], ['worker', 'core/worker.mjs', files.worker, 2000],
    ...(withIntake ? [['intake', 'core/intake.mjs', files.intake, 3000]] : []), ...(withPm ? [['pm', 'core/pm.mjs', files.pm, 4000]] : [])];
  const started = Promise.all(plan.map(args => startOne(...args)));
  const finished = new Promise(resolve => {
    const check = () => { if ([...children.values()].every(child => child.exitCode !== null) && children.size === plan.length) resolve(); };
    started.then(() => { for (const child of children.values()) child.on('exit', check); check(); });
  });
  return { stop, started, finished, children };
}
