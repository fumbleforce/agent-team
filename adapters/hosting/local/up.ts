import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configDir, DEFAULT_PORT, ENTRYPOINTS, packageRoot, workerIdFor } from '@agent-team/protocol';

export interface LocalOptions { projectId: string; checkout: string; engine: string; port?: number; env?: NodeJS.ProcessEnv }

// Where finished work is pushed and its change opened: only when the project's own manifest authorizes publishing and names the repository.
// Without that a worker keeps its work on local branches and nothing leaves the machine.
export function publishTarget(checkout: string): { scm: string; repository: string; base: string } | null {
  try {
    const manifest = JSON.parse(readFileSync(path.join(checkout, '.agent-team.json'), 'utf8')) as { scm?: { kind?: string }; ceiling?: { publishAuthorized?: unknown }; delivery?: { repository?: string; baseBranch?: string; publishAuthorized?: unknown } };
    const authorized = manifest.ceiling?.publishAuthorized === true || manifest.delivery?.publishAuthorized === true;
    return authorized && manifest.scm?.kind && manifest.delivery?.repository ? { scm: manifest.scm.kind, repository: manifest.delivery.repository, base: manifest.delivery.baseBranch ?? 'main' } : null;
  } catch { return null; }
}

export const localDir = (projectId: string, env: NodeJS.ProcessEnv = process.env) => path.join(configDir(env), 'local', projectId);

// Private configuration for the two processes; the machine token is generated once and reused.
export function writeLocalConfigs(options: LocalOptions) {
  const dir = localDir(options.projectId, options.env);
  const data = path.join(dir, 'data');
  mkdirSync(data, { recursive: true, mode: 0o700 });
  const port = options.port ?? DEFAULT_PORT;
  const url = `http://127.0.0.1:${port}`;
  const envFile = path.join(dir, 'service.env');
  const token = existsSync(envFile) ? /^AGENT_TEAM_TOKEN=(.+)$/m.exec(readFileSync(envFile, 'utf8'))?.[1] ?? null : null;
  const machineToken = token ?? randomBytes(24).toString('base64url');
  const write = (name: string, value: unknown) => { const file = path.join(dir, name); writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); return file; };
  return {
    dir, url, machineToken,
    coordinator: write('coordinator.json', { host: '127.0.0.1', port, storage: { kind: 'sqlite', path: path.join(data, 'coordinator.sqlite') } }),
    worker: write('worker.json', { coordinatorUrl: url, workerId: workerIdFor(os.hostname(), options.projectId), stateDir: path.join(data, 'worker'), engine: options.engine, projects: { [options.projectId]: options.checkout }, ...(publishTarget(options.checkout) ? { publish: publishTarget(options.checkout) } : {}) }),
    envFile: write('service.env', `AGENT_TEAM_TOKEN=${machineToken}\nAGENT_TEAM_URL=${url}\n`),
  };
}

// Two processes on one port. If either exits, the other is stopped.
export function startLocal(configs: ReturnType<typeof writeLocalConfigs>, env: NodeJS.ProcessEnv = process.env) {
  const children: ChildProcess[] = [];
  const start = (entry: string, config: string) => {
    const child = spawn(process.execPath, [path.join(packageRoot(), entry), '--config', config], { env: { ...env, AGENT_TEAM_TOKEN: configs.machineToken, AGENT_TEAM_URL: configs.url }, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
    child.on('exit', () => stop());
    children.push(child);
  };
  const stop = () => { for (const child of children) if (child.exitCode === null) child.kill('SIGTERM'); };
  start(ENTRYPOINTS.coordinator, configs.coordinator);
  const workerTimer = setTimeout(() => start(ENTRYPOINTS.worker, configs.worker), 1500);
  return { stop: () => { clearTimeout(workerTimer); stop(); }, finished: new Promise<void>(resolve => { const check = setInterval(() => { if (children.length && children.every(child => child.exitCode !== null)) { clearInterval(check); resolve(); } }, 250); }) };
}

export async function setupLink(url: string, machineToken: string): Promise<string | null> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const response = await fetch(`${url}/machine/setup-link`, { method: 'POST', headers: { authorization: `Bearer ${machineToken}` } }).catch(() => null);
    if (response?.ok) { const body = await response.json() as { path: string | null }; return body.path ? url + body.path : null; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('The coordinator did not become ready');
}
