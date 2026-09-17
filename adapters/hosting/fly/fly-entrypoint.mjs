import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// One container runs the control plane: coordinator, tracker intake (when a key is present), the
// resident PM (when AGENT_TEAM_PM_ENGINE is set) and the dashboard. Configuration is derived from
// environment/secrets; state lives on the mounted volume.
const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const data = process.env.AGENT_TEAM_DATA ?? '/data';
const configDir = path.join(data, 'config');
mkdirSync(configDir, { recursive: true, mode: 0o700 });

let projects;
try { projects = JSON.parse(process.env.AGENT_TEAM_PROJECTS ?? ''); } catch { throw new Error('AGENT_TEAM_PROJECTS must be a JSON registry such as {"my-project":{"repository":"owner/repo"}}'); }
if (!process.env.AGENT_TEAM_TOKEN) throw new Error('AGENT_TEAM_TOKEN secret is required');
if (!process.env.AGENT_TEAM_DASHBOARD_PASSWORD) throw new Error('AGENT_TEAM_DASHBOARD_PASSWORD secret is required for a public dashboard');

// A database uploaded as queue-import.sqlite replaces the live one on the next start (migration).
const live = path.join(data, 'queue.sqlite'); const imported = path.join(data, 'queue-import.sqlite');
if (existsSync(imported)) {
  for (const suffix of ['', '-wal', '-shm']) if (existsSync(live + suffix)) unlinkSync(live + suffix);
  renameSync(imported, live);
  console.error('Imported queue-import.sqlite as the live queue database');
}

const write = (name, value) => { const file = path.join(configDir, name); writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 }); return file; };
const coordinator = write('coordinator.json', { host: '0.0.0.0', port: 4310, db: path.join(data, 'queue.sqlite'), dataDir: data, projects });
const pm = write('pm.json', { coordinatorUrl: 'http://127.0.0.1:4310', engine: process.env.AGENT_TEAM_PM_ENGINE, billing: process.env.AGENT_TEAM_PM_BILLING, dataDir: path.join(data, 'pm') });
const intake = write('intake.json', { coordinatorUrl: 'http://127.0.0.1:4310', pollSeconds: 60 });
const dashboard = write('dashboard.json', { host: '0.0.0.0', port: 4311, coordinatorUrl: 'http://127.0.0.1:4310' });

const env = { ...process.env, AGENT_TEAM_PUBLIC_BIND: '1', AGENT_TEAM_URL: 'http://127.0.0.1:4310', AGENT_TEAM_HOSTNAME: process.env.FLY_APP_NAME ?? 'fly' };
const children = [];
function start(name, script, config, delay = 0) {
  setTimeout(() => {
    const child = spawn(process.execPath, [path.join(root, script), '--config', config], { env, stdio: 'inherit' });
    children.push(child);
    child.on('exit', code => { console.error(`${name} exited with ${code}; stopping the control plane so the platform restarts it`); shutdown(1); });
  }, delay);
}
function shutdown(code) {
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 3000);
}
process.once('SIGTERM', () => shutdown(0)); process.once('SIGINT', () => shutdown(0));
start('coordinator', 'core/queue.mjs', coordinator);
start('dashboard', 'core/dashboard.mjs', dashboard, 1500);
if (process.env.LINEAR_API_KEY) start('intake', 'core/intake.mjs', intake, 3000);
else console.error('LINEAR_API_KEY is not set; the intake is not running and ideas/approvals are not polled');
if (process.env.AGENT_TEAM_PM_ENGINE) start('pm', 'core/pm.mjs', pm, 4500);
else console.error('AGENT_TEAM_PM_ENGINE is not set; the resident PM is not running');
