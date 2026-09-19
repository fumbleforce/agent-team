import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commandLine, launcherTarget, resolveBinary, shellQuote } from './platform.ts';

test('elsewhere a command passes through unchanged; on Windows the file behind the name is found through PATHEXT', () => {
  assert.deepEqual(commandLine('engine', ['--print'], { platform: 'linux' }), { file: 'engine', args: ['--print'], verbatim: false });
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-team-platform-'));
  writeFileSync(path.join(dir, 'engine.cmd'), '@echo off\r\n"%dp0%\\engine.exe"   %*\r\n');
  const env = { PATH: dir, PATHEXT: '.EXE;.CMD' };
  assert.equal(resolveBinary('engine', { env, platform: 'win32' }), path.join(dir, 'engine.cmd'));
  assert.equal(resolveBinary('missing', { env, platform: 'win32' }), null);
  // A launcher that only forwards to a native program is bypassed, so no shell ever reads the arguments.
  assert.deepEqual(commandLine('engine', ['a b', '(x)'], { env, platform: 'win32' }), { file: path.win32.join(dir, 'engine.exe'), args: ['a b', '(x)'], verbatim: false });
});

test('a package-manager launcher runs its script with this runtime; any other script goes through the shell, quoted', () => {
  const shim = '@ECHO off\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" --no-warnings "%dp0%\\node_modules\\tool\\cli.js" %*\r\n';
  assert.deepEqual(launcherTarget('C:\\bin\\tool.cmd', () => shim), { script: 'C:\\bin\\node_modules\\tool\\cli.js', flags: ['--no-warnings'] });
  assert.equal(launcherTarget('C:\\bin\\other.cmd', () => 'echo hello'), null);
  assert.equal(shellQuote('Bash(git push:*)'), '^^^"Bash^^^(git^^^ push:^^^*^^^)^^^"');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-team-platform-'));
  writeFileSync(path.join(dir, 'plain.cmd'), 'echo %*\r\n');
  const line = commandLine('plain', ['a&b'], { env: { PATH: dir, ComSpec: 'cmd.exe' }, platform: 'win32' });
  assert.deepEqual([line.file, line.args.slice(0, 3), line.verbatim], ['cmd.exe', ['/d', '/s', '/c'], true]);
  assert.match(line.args[3]!, /\^\^\^&/);
});
