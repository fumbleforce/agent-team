import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// What differs between operating systems when the toolkit starts a program: how a command name
// on PATH becomes a file, how a script installed by a package manager is launched, how a process
// and everything it started are stopped, and how a shim command is written. Every spawn in the
// toolkit goes through here so the rest of the code can name a command the same way everywhere.
const SCRIPT_EXTENSIONS = ['.cmd', '.bat'];

// The key that carries the search path in an environment object. Windows environments usually
// spell it `Path`; a copied object keeps that spelling, so writing `PATH` next to it would leave
// two keys and let the child pick either.
export function pathKey(env = process.env) {
  return Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';
}
export function searchPath(env = process.env) { return env[pathKey(env)] ?? ''; }
// The search path with one directory in front, in the spelling the environment already uses.
export function prependPath(env, directory) {
  return { [pathKey(env)]: `${directory}${path.delimiter}${searchPath(env)}` };
}

// Finds the file a command name stands for. Other systems let the kernel search PATH; Windows
// needs the extension the file actually has (`.exe`, `.cmd`, ...) from PATHEXT, and a command
// installed by a package manager is a `.cmd` script the process API cannot start on its own.
export function resolveBinary(name, { env = process.env, platform = process.platform } = {}) {
  if (platform !== 'win32') return name;
  if (/[\\/]/.test(name)) return existsSync(name) ? name : null;
  const extensions = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const hasExtension = extensions.some(extension => name.toLowerCase().endsWith(extension.toLowerCase()));
  for (const directory of searchPath(env).split(path.delimiter)) {
    if (!directory) continue;
    // PATHEXT is upper-case; the files usually are not, which matters on a case-sensitive disk. The
    // usual spelling goes first so a case-insensitive disk reports the name as it was written.
    const candidates = hasExtension ? [name] : [...extensions.flatMap(extension => [name + extension.toLowerCase(), name + extension]), name];
    for (const candidate of candidates) {
      const file = path.join(directory.replace(/^"|"$/g, ''), candidate);
      try { if (statSync(file).isFile()) return file; } catch { /* keep looking */ }
    }
  }
  return null;
}

// A `.cmd` launcher written by a package manager runs one script with the host's own runtime;
// starting that script directly avoids a shell and keeps every argument, newlines included.
export function launcherScript(file, { read = readFileSync } = {}) {
  let text;
  try { text = read(file, 'utf8'); } catch { return null; }
  const match = /"%_prog%"\s+((?:[^\s"]+\s+)*)"%dp0%\\([^"]+\.(?:m?js|cjs))"\s+%\*/i.exec(text);
  if (!match) return null;
  return { script: path.join(path.dirname(file), match[2]), flags: match[1].trim().split(/\s+/).filter(Boolean) };
}

// A `.cmd` launcher that only hands its arguments to a native program beside it (`claude.cmd`
// runs `claude.exe`): that program is started directly, without the shell and its 8191-character
// limit on a command line, which a prompt or an agents definition exceeds easily.
export function nativeLauncher(file, { read = readFileSync } = {}) {
  let text;
  try { text = read(file, 'utf8'); } catch { return null; }
  const match = /^\s*"%dp0%\\([^"]+\.exe)"\s+%\*\s*$/im.exec(text);
  return match ? { file: path.join(path.dirname(file), match[1]) } : null;
}

// Quoting for a command line the Windows shell reads before a `.cmd` script expands it again:
// the rules cross-platform launchers use. Line breaks cannot cross that shell and become spaces.
const META = /([()\][%!^"`<>&|;, *?])/g;
export function shellQuote(argument) {
  let text = String(argument).replace(/\r?\n/g, ' ');
  text = text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  return `"${text}"`.replace(META, '^$1').replace(META, '^$1');
}

// What to hand the process API for a command name and its arguments: on Windows the resolved
// file, or the runtime and script behind a package-manager launcher, or the shell for any other
// script. Elsewhere the name and arguments pass through unchanged.
export function commandLine(bin, args = [], { env = process.env, platform = process.platform, execPath = process.execPath } = {}) {
  if (platform !== 'win32') return { file: bin, args, options: {} };
  const file = resolveBinary(bin, { env, platform }) ?? bin;
  if (!SCRIPT_EXTENSIONS.includes(path.extname(file).toLowerCase())) return { file, args, options: {} };
  const launcher = launcherScript(file);
  if (launcher) return { file: execPath, args: [...launcher.flags, launcher.script, ...args], options: {} };
  const native = nativeLauncher(file);
  if (native) return { file: native.file, args, options: {} };
  const line = [`"${file}"`, ...args.map(shellQuote)].join(' ');
  return { file: env.ComSpec ?? env.COMSPEC ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], options: { windowsVerbatimArguments: true } };
}

export function spawnCommand(bin, args, options = {}) {
  const resolved = commandLine(bin, args, { env: options.env ?? process.env });
  return spawn(resolved.file, resolved.args, { windowsHide: true, ...options, ...resolved.options });
}
export function spawnCommandSync(bin, args, options = {}) {
  const resolved = commandLine(bin, args, { env: options.env ?? process.env });
  return spawnSync(resolved.file, resolved.args, { windowsHide: true, ...options, ...resolved.options });
}

// Options that make a child the root of something the toolkit can stop as a whole: a process
// group elsewhere, and on Windows a process tree ended by its root process id.
export function treeSpawnOptions(platform = process.platform) {
  return platform === 'win32' ? { detached: false, windowsHide: true } : { detached: true };
}

// Stops a process and everything it started. Process groups take a signal; Windows has no
// graceful signal for a tree, so both the first request and the escalation end it outright.
export function killTree(pid, signalName = 'SIGTERM', { platform = process.platform, run = spawnSync } = {}) {
  if (!pid) return;
  if (platform !== 'win32') { process.kill(-pid, signalName); return; }
  const result = run('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  if (result.error) throw result.error;
}

// Whether anything from the tree is still running after its root closed. Windows offers no cheap
// answer for a whole tree, and its trees are ended outright, so nothing lingers there.
export function treeAlive(pid, { platform = process.platform } = {}) {
  if (!pid || platform === 'win32') return false;
  try { process.kill(-pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

// The files that make `name` a command on PATH running `script` with this runtime: a POSIX shell
// script for Unix shells (Git's shell on Windows included) and, on Windows, a `.cmd` beside it.
export function shimFiles(name, script, { execPath = process.execPath, platform = process.platform } = {}) {
  const files = [{ name, content: `#!/bin/sh\nexec "${execPath}" "${script}" "$@"\n`, mode: 0o700 }];
  if (platform === 'win32') files.push({ name: `${name}.cmd`, content: `@echo off\r\n"${execPath}" "${script}" %*\r\n`, mode: 0o700 });
  return files;
}

// An MCP server started through the package runner, as engines start it: without a shell. On
// Windows the runner is a `.cmd` script, so the shell has to start it.
export function packageRunnerCommand(args, { platform = process.platform } = {}) {
  return platform === 'win32' ? { command: 'cmd.exe', args: ['/d', '/c', 'npx', ...args] } : { command: 'npx', args };
}

// The command that opens an address in the default browser; failures are the caller's to ignore.
export function openInBrowser(url, { platform = process.platform, spawnImpl = spawn } = {}) {
  const [file, args] = platform === 'darwin' ? ['open', [url]] : platform === 'win32' ? ['cmd.exe', ['/d', '/c', 'start', '', url]] : ['xdg-open', [url]];
  const child = spawnImpl(file, args, { stdio: 'ignore', detached: platform !== 'win32', windowsHide: true });
  child.on?.('error', () => {});
  child.unref?.();
  return child;
}
