import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commandLine, killTree, launcherScript, openInBrowser, packageRunnerCommand, pathKey, prependPath, resolveBinary, shellQuote, shimFiles, treeAlive, treeSpawnOptions } from './platform.mjs';

const LAUNCHER = `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\some-engine\\cli.js" %*\r\n`;

test('the search path keeps the spelling the environment already uses', () => {
  assert.equal(pathKey({ Path: 'a', HOME: 'h' }), 'Path');
  assert.equal(pathKey({ PATH: 'a' }), 'PATH');
  assert.equal(pathKey({}), 'PATH');
  assert.deepEqual(prependPath({ Path: `x${path.delimiter}y` }, '/bin'), { Path: `/bin${path.delimiter}x${path.delimiter}y` });
  assert.deepEqual(prependPath({}, '/bin'), { PATH: `/bin${path.delimiter}` });
});

test('command names pass through unchanged except on Windows, where the file on PATH is found by extension', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'platform-'));
  try {
    const tools = path.join(dir, 'tools'); mkdirSync(tools);
    writeFileSync(path.join(tools, 'engine.cmd'), LAUNCHER);
    writeFileSync(path.join(tools, 'native.exe'), '');
    writeFileSync(path.join(tools, 'plain'), '');
    const env = { Path: `${dir}${path.delimiter}"${tools}"`, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    assert.equal(resolveBinary('engine', { env, platform: 'linux' }), 'engine');
    assert.equal(resolveBinary('engine', { env, platform: 'win32' }), path.join(tools, 'engine.cmd'));
    assert.equal(resolveBinary('native', { env, platform: 'win32' }), path.join(tools, 'native.exe'));
    assert.equal(resolveBinary('native.exe', { env, platform: 'win32' }), path.join(tools, 'native.exe'), 'an explicit extension is kept as given');
    assert.equal(resolveBinary('plain', { env, platform: 'win32' }), path.join(tools, 'plain'), 'a bare file still counts, last');
    assert.equal(resolveBinary('missing', { env, platform: 'win32' }), null);
    assert.equal(resolveBinary(path.join(tools, 'native.exe'), { env, platform: 'win32' }), path.join(tools, 'native.exe'));
    assert.equal(resolveBinary(path.join(tools, 'nothing.exe'), { env, platform: 'win32' }), null);
    // A launcher written by the package manager becomes the runtime plus its script: no shell,
    // so a prompt with line breaks arrives intact.
    assert.deepEqual(launcherScript(path.join(tools, 'engine.cmd')), { script: path.join(tools, 'node_modules\\some-engine\\cli.js'), flags: [] });
    assert.equal(launcherScript(path.join(tools, 'missing.cmd')), null);
    const line = commandLine('engine', ['run', 'first line\nsecond'], { env, platform: 'win32', execPath: 'C:\\node.exe' });
    assert.deepEqual(line, { file: 'C:\\node.exe', args: [path.join(tools, 'node_modules\\some-engine\\cli.js'), 'run', 'first line\nsecond'], options: {} });
    assert.deepEqual(commandLine('native', ['--version'], { env, platform: 'win32' }), { file: path.join(tools, 'native.exe'), args: ['--version'], options: {} });
    assert.deepEqual(commandLine('engine', ['x'], { env, platform: 'linux' }), { file: 'engine', args: ['x'], options: {} });
    assert.deepEqual(commandLine('missing', ['x'], { env, platform: 'win32' }), { file: 'missing', args: ['x'], options: {} }, 'an unknown name is left to the process API, which reports it');
    // Any other script goes through the shell with every argument quoted for it.
    writeFileSync(path.join(tools, 'other.bat'), '@echo off\r\necho %*\r\n');
    const shell = commandLine('other', ['a b', 'say "hi"'], { env: { ...env, ComSpec: 'C:\\Windows\\cmd.exe' }, platform: 'win32' });
    assert.equal(shell.file, 'C:\\Windows\\cmd.exe');
    assert.deepEqual(shell.options, { windowsVerbatimArguments: true });
    assert.deepEqual(shell.args.slice(0, 3), ['/d', '/s', '/c']);
    assert.equal(shell.args[3], `""${path.join(tools, 'other.bat')}" ^^^"a^^^ b^^^" ^^^"say^^^ \\^^^"hi\\^^^"^^^""`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('shell quoting follows the rules launchers use for the Windows shell', () => {
  assert.equal(shellQuote('plain'), '^^^"plain^^^"');
  assert.equal(shellQuote('a b'), '^^^"a^^^ b^^^"', 'spaces are escaped too, as launchers do');
  assert.equal(shellQuote('back\\'), '^^^"back\\\\^^^"');
  assert.equal(shellQuote('line\r\nbreak'), '^^^"line^^^ break^^^"');
  assert.equal(shellQuote('100%'), '^^^"100^^^%^^^"');
});

test('process trees are stopped as a whole on every platform', () => {
  assert.deepEqual(treeSpawnOptions('linux'), { detached: true });
  assert.deepEqual(treeSpawnOptions('win32'), { detached: false, windowsHide: true });
  const calls = [];
  killTree(4242, 'SIGTERM', { platform: 'win32', run: (file, args, options) => { calls.push([file, args, options.stdio]); return {}; } });
  assert.deepEqual(calls, [['taskkill', ['/pid', '4242', '/T', '/F'], 'ignore']]);
  assert.throws(() => killTree(4242, 'SIGKILL', { platform: 'win32', run: () => ({ error: new Error('no taskkill') }) }), /no taskkill/);
  killTree(undefined, 'SIGTERM', { platform: 'win32', run: () => { throw new Error('must not run'); } });
  assert.equal(treeAlive(4242, { platform: 'win32' }), false);
  assert.equal(treeAlive(undefined), false);
  if (process.platform !== 'win32') assert.equal(treeAlive(2 ** 22 - 7), false, 'a group that does not exist');
});

test('shims are shell scripts everywhere and .cmd launchers as well on Windows', () => {
  const posix = shimFiles('memory', '/toolkit/core/memory-cli.mjs', { execPath: '/usr/bin/node', platform: 'linux' });
  assert.deepEqual(posix, [{ name: 'memory', content: '#!/bin/sh\nexec "/usr/bin/node" "/toolkit/core/memory-cli.mjs" "$@"\n', mode: 0o700 }]);
  const windows = shimFiles('memory', 'C:\\toolkit\\core\\memory-cli.mjs', { execPath: 'C:\\node.exe', platform: 'win32' });
  assert.deepEqual(windows.map(file => file.name), ['memory', 'memory.cmd']);
  assert.equal(windows[1].content, '@echo off\r\n"C:\\node.exe" "C:\\toolkit\\core\\memory-cli.mjs" %*\r\n');
});

test('package-runner MCP servers and the browser opener use the platform\'s shell where one is needed', () => {
  assert.deepEqual(packageRunnerCommand(['-y', 'pkg'], { platform: 'linux' }), { command: 'npx', args: ['-y', 'pkg'] });
  assert.deepEqual(packageRunnerCommand(['-y', 'pkg'], { platform: 'win32' }), { command: 'cmd.exe', args: ['/d', '/c', 'npx', '-y', 'pkg'] });
  const spawned = [];
  const spawnImpl = (file, args, options) => { spawned.push([file, args, options.detached]); return { on() {}, unref() {} }; };
  openInBrowser('http://127.0.0.1:4311/', { platform: 'win32', spawnImpl });
  openInBrowser('http://127.0.0.1:4311/', { platform: 'darwin', spawnImpl });
  openInBrowser('http://127.0.0.1:4311/', { platform: 'linux', spawnImpl });
  assert.deepEqual(spawned, [['cmd.exe', ['/d', '/c', 'start', '', 'http://127.0.0.1:4311/'], false], ['open', ['http://127.0.0.1:4311/'], true], ['xdg-open', ['http://127.0.0.1:4311/'], true]]);
});
