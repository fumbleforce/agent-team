import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
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

// In a checkout the app's pages are built files. When the sources are newer than the build (after a pull, say), the pages would lag behind
// the server, so the build is refreshed before starting. An installed package ships its pages built and has no sources to compare.
export function webBuildIsStale(root: string): boolean {
  const source = path.join(root, 'packages', 'web', 'src'), built = path.join(root, 'packages', 'web', 'dist', 'index.html');
  if (!existsSync(source)) return false;
  if (!existsSync(built)) return true;
  const newest = (dir: string): number => readdirSync(dir, { withFileTypes: true }).reduce((latest, entry) => Math.max(latest, entry.isDirectory() ? newest(path.join(dir, entry.name)) : statSync(path.join(dir, entry.name)).mtimeMs), 0);
  return newest(source) > statSync(built).mtimeMs;
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

// What `up` has set up on this machine, one entry per project folder it was run for.
export interface LocalProject { slug: string; coordinator: string; url: string | null; machineToken: string | null }
export function localProjects(env: NodeJS.ProcessEnv = process.env): LocalProject[] {
  const home = path.join(configDir(env), 'local');
  if (!existsSync(home)) return [];
  return readdirSync(home).filter(slug => existsSync(path.join(home, slug, 'coordinator.json'))).map(slug => {
    const envFile = path.join(home, slug, 'service.env');
    const service = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
    return { slug, coordinator: path.join(home, slug, 'coordinator.json'), url: /^AGENT_TEAM_URL=(.+)$/m.exec(service)?.[1] ?? null, machineToken: /^AGENT_TEAM_TOKEN=(.+)$/m.exec(service)?.[1] ?? null };
  });
}

// The project a command means when it was not told: the one `up` ran for in this folder, else the only one, else the one picked.
export async function chooseLocal(folder: string, ask: ((question: string, options?: { fallback?: string }) => Promise<string>) | null, env: NodeJS.ProcessEnv = process.env): Promise<LocalProject | null> {
  const projects = localProjects(env);
  const here = projects.find(project => project.slug === slugFor(folder));
  if (here || projects.length <= 1 || !ask) return here ?? (projects.length === 1 ? projects[0]! : null);
  const picked = await ask(`Which project? (${projects.map(project => project.slug).join(', ')})`, { fallback: projects[0]!.slug });
  return projects.find(project => project.slug === picked) ?? null;
}

export function slugFor(checkout: string): string {
  let manifest: { queueProjectId?: string } = {};
  try { manifest = JSON.parse(readFileSync(path.join(checkout, '.agent-team.json'), 'utf8')) as { queueProjectId?: string }; } catch { /* a folder without a manifest goes by its name */ }
  return (manifest.queueProjectId ?? path.basename(checkout)).toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

// Two processes on one port. If either exits, the other is stopped.
export function startLocal(configs: ReturnType<typeof writeLocalConfigs>, env: NodeJS.ProcessEnv = process.env) {
  const children: ChildProcess[] = [];
  const start = (entry: string, config: string) => {
    const child = spawn(process.execPath, [path.join(packageRoot(), entry), '--config', config], { env: { ...env, AGENT_TEAM_TOKEN: configs.machineToken, AGENT_TEAM_URL: configs.url }, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
    child.on('exit', () => end('SIGTERM'));
    children.push(child);
  };
  // The first stop asks; a stop after that one ends what is still running, and the worker's next start sweeps what it left.
  let asked = false;
  // A child ended by a signal has no exit code, only the signal's name.
  const over = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;
  const end = (signal: NodeJS.Signals) => { for (const child of children) if (!over(child)) child.kill(signal); };
  const stop = () => {
    end(asked ? 'SIGKILL' : 'SIGTERM');
    asked = true;
  };
  start(ENTRYPOINTS.coordinator, configs.coordinator);
  const workerTimer = setTimeout(() => start(ENTRYPOINTS.worker, configs.worker), 1500);
  return { stop: () => { clearTimeout(workerTimer); stop(); }, finished: new Promise<void>(resolve => { const check = setInterval(() => { if (children.length && children.every(over)) { clearInterval(check); resolve(); } }, 250); }) };
}

export async function setupLink(url: string, machineToken: string): Promise<string | null> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const response = await fetch(`${url}/machine/setup-link`, { method: 'POST', headers: { authorization: `Bearer ${machineToken}` } }).catch(() => null);
    if (response?.ok) { const body = await response.json() as { path: string | null }; return body.path ? url + body.path : null; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('The coordinator did not become ready');
}
