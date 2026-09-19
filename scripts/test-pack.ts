import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { packageRoot } from '../packages/protocol/src/paths.ts';

// Proves the published package works: pack it, install the tarball into an empty project, and run the CLI from node_modules,
// where Node will not strip types. Not part of `npm test`: it builds the web app and installs the runtime dependencies.
const root = packageRoot(), temp = mkdtempSync(path.join(os.tmpdir(), 'agent-team-pack-'));
// npm is a script on Windows, so it goes through the shell; every argument here is fixed or a path this script made.
const npm = (args: string[], cwd: string) => {
  const result = spawnSync(`npm ${args.map(arg => (/\s/.test(arg) ? `"${arg}"` : arg)).join(' ')}`, { cwd, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`npm ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
};
const freePort = () => new Promise<number>((resolve, reject) => { const server = createServer(); server.on('error', reject); server.listen(0, '127.0.0.1', () => { const { port } = server.address() as { port: number }; server.close(() => resolve(port)); }); });

let failed = false;
try {
  // prepack's own output comes first; npm's report is the JSON array that ends the output.
  const report = npm(['pack', '--json', '--pack-destination', temp], root).replaceAll('\r\n', '\n');
  const packed = (JSON.parse(report.slice(report.startsWith('[\n') ? 0 : report.lastIndexOf('\n[\n') + 1)) as { filename: string; files: { path: string }[] }[])[0]!;
  const paths = packed.files.map(file => file.path);
  for (const needed of ['package.json', 'dist/bin/agent-team.js', 'dist/packages/coordinator/src/main.js', 'dist/packages/worker/src/main.js', 'dist/adapters/storage/migrations/0001_init.js', 'dist/blueprints/roles.json', 'dist/packages/web/dist/index.html', 'dist/adapters/hosting/aws/worker-bake.sh']) assert.ok(paths.includes(needed), `the tarball is missing ${needed}`);
  assert.deepEqual(paths.filter(file => /\.tsx?$/.test(file)), [], 'TypeScript sources do not belong in the tarball');
  assert.deepEqual(paths.filter(file => /\.test\.js$|node_modules/.test(file)), [], 'tests and node_modules do not belong in the tarball');
  assert.match(readFileSync(path.join(root, 'package.json'), 'utf8'), /"agent-team": "bin\/agent-team\.ts"/, 'postpack puts the checkout bin back');
  console.log(`packed ${packed.filename}: ${paths.length} files`);

  const project = path.join(temp, 'project');
  mkdirSync(project);
  writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'pack-consumer', version: '1.0.0', private: true }));
  npm(['install', path.join(temp, packed.filename), '--no-audit', '--no-fund', '--prefer-offline'], project);
  const installed = path.join(project, 'node_modules', '@fumbleforce', 'agent-team');
  const manifest = JSON.parse(readFileSync(path.join(installed, 'package.json'), 'utf8')) as { bin: Record<string, string> };
  assert.equal(manifest.bin['agent-team'], 'dist/bin/agent-team.js');
  assert.ok(existsSync(path.join(project, 'node_modules', '.bin', process.platform === 'win32' ? 'agent-team.cmd' : 'agent-team')), 'npm linked the command');

  // The command as a user runs it, through npm's link.
  const usage = npm(['exec', '--no', '--', 'agent-team'], project);
  assert.match(usage, /agent-team <command>/);
  assert.match(usage, /setup-link/);
  console.log('agent-team prints its usage from node_modules');

  // Storage, migrations and the dynamic imports: a database file brought up to date by the installed CLI.
  const config = path.join(project, 'coordinator.json');
  writeFileSync(config, JSON.stringify({ storage: { kind: 'sqlite', path: path.join(project, 'team.db') } }));
  assert.match(npm(['exec', '--no', '--', 'agent-team', 'migrate', '--config', config], project), /up to date/);
  console.log('agent-team migrate runs every migration from node_modules');

  // The whole coordinator, with the blueprints and the web app it reads from the package.
  const port = await freePort();
  const demo = spawn(process.execPath, [path.join(installed, manifest.bin['agent-team']!), 'demo'], { cwd: project, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  demo.stdout.on('data', chunk => { output += String(chunk); });
  demo.stderr.on('data', chunk => { output += String(chunk); });
  try {
    const deadline = Date.now() + 30_000;
    let healthy = false;
    while (!healthy && Date.now() < deadline && demo.exitCode === null) {
      healthy = await fetch(`http://127.0.0.1:${port}/health`).then(response => response.ok, () => false);
      if (!healthy) await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.ok(healthy, `the demo did not start:\n${output}`);
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<div id="root"|<script/);
    console.log('agent-team demo serves the API and the web app from node_modules');
  } finally {
    demo.kill();
    await new Promise(resolve => { if (demo.exitCode !== null || demo.signalCode !== null) resolve(null); else demo.once('exit', resolve); });
  }
} catch (error) {
  failed = true;
  console.error(error instanceof Error ? error.message : error);
} finally {
  // Whatever happened, the checkout's manifest points at the `.ts` CLI again.
  spawnSync(process.execPath, [path.join(root, 'scripts', 'build-dist.ts'), '--restore'], { stdio: 'inherit' });
  rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exit(failed ? 1 : 0);
