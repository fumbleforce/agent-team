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

// A `.cmd` launcher written by a package manager runs one script with the host's own runtime, or hands its arguments
// to a native program beside it. Starting either directly avoids the shell, its quoting and its command-line limit.
export function launcherTarget(file: string, read: (file: string) => string = file => readFileSync(file, 'utf8')): { file?: string; script?: string; flags: string[] } | null {
  let text: string;
  try { text = read(file); } catch { return null; }
  const script = /"%_prog%"\s+((?:[^\s"]+\s+)*)"%dp0%\\([^"]+\.(?:m?js|cjs))"\s+%\*/i.exec(text);
  if (script) return { script: path.join(path.dirname(file), script[2]!), flags: script[1]!.trim().split(/\s+/).filter(Boolean) };
  const native = /^\s*"%dp0%\\([^"]+\.exe)"\s+%\*\s*$/im.exec(text);
  return native ? { file: path.join(path.dirname(file), native[1]!), flags: [] } : null;
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
