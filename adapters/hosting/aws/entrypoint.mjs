import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Control-plane entrypoint for AWS: one container or one EC2 instance runs the coordinator, the
// tracker intake, the resident PM and the dashboard. Secrets come from SSM Parameter Store when
// AGENT_TEAM_SSM_PREFIX is set (parameters named <prefix>/<VARIABLE>), otherwise from the
// environment. Durable state lives under AGENT_TEAM_DATA (an EBS or EFS mount).
const root = path.dirname(path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))));
const data = process.env.AGENT_TEAM_DATA ?? '/data';
const configDir = path.join(data, 'config');
mkdirSync(configDir, { recursive: true, mode: 0o700 });

const SECRETS = ['AGENT_TEAM_TOKEN', 'AGENT_TEAM_DASHBOARD_PASSWORD', 'LINEAR_API_KEY', 'ANTHROPIC_API_KEY', 'GITLAB_TOKEN', 'GH_TOKEN'];

// Reads every known secret under the prefix in one call; missing parameters stay unset.
function loadSsmSecrets(prefix) {
  const names = SECRETS.map(name => `${prefix.replace(/\/$/, '')}/${name}`);
  const output = execFileSync('aws', ['ssm', 'get-parameters', '--with-decryption', '--names', ...names, '--output', 'json'], { encoding: 'utf8', timeout: 30_000 });
  const parsed = JSON.parse(output);
  for (const parameter of parsed.Parameters ?? []) {
    const name = parameter.Name.split('/').pop();
    if (SECRETS.includes(name) && !process.env[name]) process.env[name] = parameter.Value;
  }
}
if (process.env.AGENT_TEAM_SSM_PREFIX) loadSsmSecrets(process.env.AGENT_TEAM_SSM_PREFIX);

let projects;
try { projects = JSON.parse(process.env.AGENT_TEAM_PROJECTS ?? ''); } catch { throw new Error('AGENT_TEAM_PROJECTS must be a JSON registry such as {"project":{"repository":"group/project"}}'); }
if (!process.env.AGENT_TEAM_TOKEN) throw new Error('AGENT_TEAM_TOKEN is required (environment or SSM)');
if (!process.env.AGENT_TEAM_DASHBOARD_PASSWORD) throw new Error('AGENT_TEAM_DASHBOARD_PASSWORD is required for a public dashboard');

// Launcher settings shared by every project that uses ephemeral workers; manifests refine them.
let launcher = null;
if (process.env.AGENT_TEAM_LAUNCHER) {
  try { launcher = JSON.parse(process.env.AGENT_TEAM_LAUNCHER); } catch { throw new Error('AGENT_TEAM_LAUNCHER must be JSON such as {"kind":"ec2","options":{"region":"eu-north-1","subnetId":"...","securityGroupId":"...","instanceProfile":"...","coordinatorUrl":"https://...","token":"..."}}'); }
  if (launcher.options && !launcher.options.token) launcher.options.token = process.env.AGENT_TEAM_TOKEN;
}

const write = (name, value) => { const file = path.join(configDir, name); writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 }); return file; };
const coordinator = write('coordinator.json', { host: '0.0.0.0', port: 4310, db: path.join(data, 'queue.sqlite'), dataDir: data, projects, ...(launcher ? { launcher } : {}), claimTimeoutMinutes: Number(process.env.AGENT_TEAM_CLAIM_TIMEOUT_MINUTES ?? 15) });
const pm = write('pm.json', { coordinatorUrl: 'http://127.0.0.1:4310', engine: process.env.AGENT_TEAM_PM_ENGINE, billing: process.env.AGENT_TEAM_PM_BILLING, model: process.env.AGENT_TEAM_PM_MODEL, dataDir: path.join(data, 'pm') });
const intake = write('intake.json', { coordinatorUrl: 'http://127.0.0.1:4310', pollSeconds: Number(process.env.AGENT_TEAM_INTAKE_SECONDS ?? 60) });
const dashboard = write('dashboard.json', { host: '0.0.0.0', port: 4311, coordinatorUrl: 'http://127.0.0.1:4310' });

const env = { ...process.env, AGENT_TEAM_PUBLIC_BIND: '1', AGENT_TEAM_URL: 'http://127.0.0.1:4310', AGENT_TEAM_HOSTNAME: process.env.AGENT_TEAM_HOSTNAME ?? 'aws' };
const children = [];
function start(name, script, config, delay = 0) {
  setTimeout(() => {
    const child = spawn(process.execPath, [path.join(root, script), '--config', config], { env, stdio: 'inherit' });
    children.push(child);
    child.on('exit', code => { console.error(`${name} exited with ${code}; stopping the control plane so the service restarts it`); shutdown(1); });
  }, delay);
}
function shutdown(code) {
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 3000);
}
process.once('SIGTERM', () => shutdown(0)); process.once('SIGINT', () => shutdown(0));
if (!existsSync(path.join(root, 'core', 'queue.mjs'))) throw new Error(`Toolkit not found at ${root}`);
start('coordinator', 'core/queue.mjs', coordinator);
start('dashboard', 'core/dashboard.mjs', dashboard, 1500);
if (process.env.LINEAR_API_KEY) start('intake', 'core/intake.mjs', intake, 3000);
else console.error('No tracker API key is set; the intake is not running and ideas/approvals are not polled');
if (process.env.AGENT_TEAM_PM_ENGINE) start('pm', 'core/pm.mjs', pm, 4500);
else console.error('AGENT_TEAM_PM_ENGINE is not set; the resident PM is not running');
