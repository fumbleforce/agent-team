import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// What differs between operating systems when the worker starts a program: how a command name on PATH becomes a file,
// how a script installed by a package manager is launched, and how a process and everything it started are stopped.
const SCRIPT_EXTENSIONS = ['.cmd', '.bat'];
interface Host { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; execPath?: string }

const searchPath = (env: NodeJS.ProcessEnv) => env[Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH'] ?? '';

// Other systems let the kernel search PATH; Windows needs the extension the file actually has, from PATHEXT.
export function resolveBinary(name: string, { env = process.env, platform = process.platform }: Host = {}): string | null {
  if (platform !== 'win32') return name;
  if (/[\\/]/.test(name)) return existsSync(name) ? name : null;
  const extensions = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const hasExtension = extensions.some(extension => name.toLowerCase().endsWith(extension.toLowerCase()));
  const candidates = hasExtension ? [name] : extensions.flatMap(extension => [name + extension.toLowerCase(), name + extension]);
  for (const directory of searchPath(env).split(path.delimiter)) {
    for (const candidate of directory ? candidates : []) {
      const file = path.join(directory.replace(/^"|"$/g, ''), candidate);
      try { if (statSync(file).isFile()) return file; } catch { /* keep looking */ }
    }
  }
  return null;
}

// Whether a command can be started here. Windows is answered by the search above; elsewhere the same walk over PATH, because the kernel
// only searches when the program is started. What a worker reports about itself is built on this: names, never values.
export function installed(name: string, { env = process.env, platform = process.platform }: Host = {}): boolean {
  if (platform === 'win32') return resolveBinary(name, { env, platform }) !== null;
  if (name.includes('/')) return existsSync(name);
  return searchPath(env).split(':').some(directory => { try { return directory !== '' && statSync(path.posix.join(directory, name)).isFile(); } catch { return false; } });
}
type Listed = { id: string; name: string; note?: string; efforts?: string[] };
type Engine = { bin: string; defaultModel?(env: NodeJS.ProcessEnv): string | null; discover?(host: { env: NodeJS.ProcessEnv; run(args: string[], input?: string): Promise<string> }): Promise<{ models: Listed[]; efforts: string[] }> };
export interface Readiness { engines: string[]; variables: string[]; models: Record<string, Listed[]>; efforts: Record<string, string[]>; runs?: { engine: string; model: string | null } }
export function readiness(engines: Record<string, Engine>, variables: readonly string[], host: Host & { defaultEngine?: string } = {}): Readiness {
  const env = host.env ?? process.env;
  const runs = host.defaultEngine && engines[host.defaultEngine] ? { runs: { engine: host.defaultEngine, model: engines[host.defaultEngine]!.defaultModel?.(env)?.slice(0, 120) ?? null } } : {};
  return { engines: Object.keys(engines).filter(name => installed(engines[name]!.bin, host)), variables: variables.filter(name => Boolean(env[name])), models: {}, efforts: {}, ...runs };
}
// What each tool says it offers, asked once when the worker starts: from the tool's own files, and from what it prints where it is installed.
// A tool that does not answer within a few seconds simply says nothing.
export async function discovered(engines: Record<string, Engine>, ready: Readiness, host: Host = {}): Promise<Readiness> {
  const env = host.env ?? process.env, models: Record<string, Listed[]> = {}, efforts: Record<string, string[]> = {};
  await Promise.all(Object.entries(engines).map(async ([name, engine]) => {
    if (!engine.discover) return;
    const run = (args: string[], input?: string) => (ready.engines.includes(name) ? new Promise<string>(resolve => {
      const child = spawnCommand(engine.bin, args, { env, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
      let out = '';
      const timer = setTimeout(() => { killTree(child.pid); resolve(out); }, 8000);
      child.stdout!.on('data', chunk => { out = (out + String(chunk)).slice(0, 500_000); }); child.stderr!.on('data', chunk => { out = (out + String(chunk)).slice(0, 500_000); });
      child.on('error', () => { clearTimeout(timer); resolve(''); }); child.on('close', () => { clearTimeout(timer); resolve(out); });
      if (input !== undefined) { child.stdin!.on('error', () => {}); child.stdin!.end(input); }
    }) : Promise.resolve(''));
    const found = await engine.discover({ env, run }).catch(() => ({ models: [], efforts: [] }));
    if (found.models.length) models[name] = found.models.slice(0, 100);
    if (found.efforts.length) efforts[name] = found.efforts.slice(0, 12);
  }));
  return { ...ready, models, efforts };
}

// A `.cmd` launcher written by a package manager runs one script with the host's own runtime, or hands its arguments
// to a native program beside it. Starting either directly avoids the shell, its quoting and its command-line limit.
export function launcherTarget(file: string, read: (file: string) => string = file => readFileSync(file, 'utf8')): { file?: string; script?: string; flags: string[] } | null {
  let text: string;
  try { text = read(file); } catch { return null; }
  const script = /"%_prog%"\s+((?:[^\s"]+\s+)*)"%dp0%\\([^"]+\.(?:m?js|cjs))"\s+%\*/i.exec(text);
  // Launchers exist only on Windows, so their paths are read by its rules wherever this runs.
  if (script) return { script: path.win32.join(path.win32.dirname(file), script[2]!), flags: script[1]!.trim().split(/\s+/).filter(Boolean) };
  const native = /^\s*"%dp0%\\([^"]+\.exe)"\s+%\*\s*$/im.exec(text);
  return native ? { file: path.win32.join(path.win32.dirname(file), native[1]!), flags: [] } : null;
}

// Quoting for a command line the Windows shell reads before a `.cmd` script expands it again. Line breaks cannot cross that shell.
const META = /([()\][%!^"`<>&|;, *?])/g;
export function shellQuote(argument: string): string {
  const text = argument.replace(/\r?\n/g, ' ').replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  return `"${text}"`.replace(META, '^$1').replace(META, '^$1');
}

export function commandLine(bin: string, args: string[], host: Host = {}): { file: string; args: string[]; verbatim: boolean } {
  const { env = process.env, platform = process.platform, execPath = process.execPath } = host;
  if (platform !== 'win32') return { file: bin, args, verbatim: false };
  const file = resolveBinary(bin, { env, platform }) ?? bin;
  if (!SCRIPT_EXTENSIONS.includes(path.extname(file).toLowerCase())) return { file, args, verbatim: false };
  const target = launcherTarget(file);
  if (target?.script) return { file: execPath, args: [...target.flags, target.script, ...args], verbatim: false };
  if (target?.file) return { file: target.file, args, verbatim: false };
  return { file: env.ComSpec ?? env.COMSPEC ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${[`"${file}"`, ...args.map(shellQuote)].join(' ')}"`], verbatim: true };
}

// The child is the root of something that can be stopped as a whole: a process group elsewhere, a process tree on Windows.
export function spawnCommand(bin: string, args: string[], options: SpawnOptions = {}): ChildProcess {
  const resolved = commandLine(bin, args, { env: options.env ?? process.env });
  return spawn(resolved.file, resolved.args, { windowsHide: true, detached: process.platform !== 'win32', ...options, windowsVerbatimArguments: resolved.verbatim });
}

// Stops a process and everything it started. Windows has no graceful signal for a tree, so it is ended outright.
export function killTree(pid: number | undefined, signal: NodeJS.Signals = 'SIGTERM', platform: NodeJS.Platform = process.platform): void {
  if (!pid) return;
  try {
    if (platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(-pid, signal);
  } catch { /* already gone */ }
}

// Who a process id belongs to right now: the name of its program, and a token for when it started where the system tells cheaply.
// A pid is reused after its process ends, so a pid alone never says that a process is still the one that was started.
export interface ProcessIdentity { command: string; started: string | null }
type Probe = (file: string, args: string[]) => Promise<string>;
const probeCommand: Probe = (file, args) => new Promise((resolve, reject) => {
  const child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  const timer = setTimeout(() => { child.kill(); reject(new Error('timeout')); }, 5000);
  child.stdout!.on('data', chunk => { out += String(chunk); });
  child.on('error', error => { clearTimeout(timer); reject(error); });
  child.on('close', () => { clearTimeout(timer); resolve(out); });
});

export async function processIdentity(pid: number, host: { platform?: NodeJS.Platform; run?: Probe; read?: (file: string) => string } = {}): Promise<ProcessIdentity | null> {
  const { platform = process.platform, run = probeCommand, read = (file: string) => readFileSync(file, 'utf8') } = host;
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (platform === 'linux') {
      // Field 22 of the stat line is the start time in clock ticks since boot; the name in parentheses may itself hold spaces and parentheses.
      const stat = read(`/proc/${pid}/stat`), fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return { command: stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')')), started: fields[19] ?? null };
    }
    if (platform === 'win32') {
      // The task list names the image and nothing about its start; asking the management interface would cost seconds, so the name is what is compared.
      const line = (await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'])).split(/\r?\n/).find(row => row.startsWith('"'));
      const cells = line ? [...line.matchAll(/"([^"]*)"/g)].map(match => match[1]!) : [];
      return cells[0] && Number(cells[1]) === pid ? { command: cells[0].toLowerCase(), started: null } : null;
    }
    const line = (await run('ps', ['-o', 'lstart=,comm=', '-p', String(pid)])).trim();
    const match = /^(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.+)$/.exec(line);
    return match ? { command: path.posix.basename(match[2]!.trim()), started: match[1]!.replace(/\s+/g, ' ') } : null;
  } catch { return null; }
}
