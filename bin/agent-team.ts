#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chooseLocal, publishTarget, setupLink, slugFor, startLocal, webBuildIsStale, writeLocalConfigs } from '../adapters/hosting/local/up.ts';
import { terminalAsk } from '../adapters/hosting/shared/ask.ts';
import { detectRepository } from '../adapters/hosting/shared/repository.ts';
import { ENGINES } from '../adapters/engine/index.ts';
import { configDir, DEFAULT_PORT, ENTRYPOINTS, packageRoot, workerIdFor } from '@agent-team/protocol';
import { createStorage, type StorageConfig } from '@agent-team/storage';

const USAGE = `agent-team <command>
  up [checkout] [--engine NAME] [--port N]   start the coordinator and a worker for a checkout on this machine
  connect [link] [checkout] [--engine NAME]  pair this machine with a project using the link from the app, then work for it
  work [checkout]                            work again for the project this checkout was connected to
  demo                                       serve the sample organization on an in-memory database
  setup-link [--url URL]                     print a one-time link for creating the owner (of the local project, or of AGENT_TEAM_TOKEN's coordinator)
  scorecard [--project SLUG] [--days N] [--json]   the roadmap's figures for a project: autonomy, speed, delivery, safety
  migrate [--config FILE]                    bring a database up to date (default: the local project's)
  backup [--config FILE] [--out FILE]        copy a database into one file, while it is in use (default: the local project's)
  export [--config FILE] [--out DIR]         everything a coordinator holds, in one folder: its database, secrets key and stored files
  import <dir> [--config FILE]               load an export into a coordinator's empty database, of either kind, with its key and files
  init aws [checkout]                        set up an AWS deployment for a project, kept in its folder: asks what it cannot work out, then offers the plan
             [--region R] [--profile P] [--permissions-boundary ARN] [--toolkit-ref COMMIT] [--instance-type T] [--setup CMD] [--force]
  deploy aws [--plan|--apply] [--only STEP] [--skip STEP]   plan the AWS deployment, then apply it on a yes (or at once with --apply)
  status aws                                 show what the AWS deployment has recorded and the control plane's state
  destroy aws [--yes] [--roles] [--data] [--secrets]   list what would be deleted; delete it after a yes (or --yes)
  call <tool> [json]                         call a platform tool from inside a turn, for engines that cannot mount the tool endpoint`;

const [command, ...rest] = process.argv.slice(2);
const flag = (name: string) => { const index = rest.indexOf(name); return index >= 0 ? rest[index + 1] : undefined; };

if (command === 'demo') await import('./agent-team-demo.ts');
else if (command === 'up') {
  const checkout = path.resolve(rest.find(item => !item.startsWith('--') && item !== flag('--engine') && item !== flag('--port')) ?? '.');
  const manifestFile = path.join(checkout, '.agent-team.json');
  if (!existsSync(checkout)) { console.error(`${checkout} does not exist`); process.exit(1); }
  // A checkout without a manifest still comes up; what it connects to is then set in the app.
  const manifest = (existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : {}) as { name?: string; queueProjectId?: string; engine?: { default?: string }; scm?: { kind?: string }; delivery?: Record<string, unknown> };
  // Where the code lives is read from the checkout (its remote, else package.json) when the manifest does not say, so nobody types it.
  // Only the repository and its main branch are filled in: publishing still needs the committed manifest's authorization.
  const found = manifest.scm?.kind && manifest.delivery?.repository ? null : detectRepository(checkout);
  if (found) Object.assign(manifest, { scm: { ...found.scm, ...manifest.scm }, delivery: { ...found.delivery, ...manifest.delivery } });
  const slug = (manifest.queueProjectId ?? path.basename(checkout)).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const engine = flag('--engine') ?? manifest.engine?.default ?? 'claude';
  if (!ENGINES.includes(engine)) { console.error(`Engine "${engine}" is not available here; choose one of: ${ENGINES.join(', ')}`); process.exit(1); }
  if (webBuildIsStale(packageRoot())) {
    console.log('The app\'s pages are older than their sources; building them first…');
    const built = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build', '-w', 'packages/web'], { cwd: packageRoot(), stdio: 'inherit', shell: process.platform === 'win32', windowsHide: true });
    if (built.status !== 0) console.error('Building the pages failed; starting with the pages as they are.');
  }
  const configs = writeLocalConfigs({ projectId: slug, checkout, engine, ...(flag('--port') ? { port: Number(flag('--port')) } : {}) });
  const services = startLocal(configs);
  process.on('SIGINT', () => services.stop());
  const link = await setupLink(configs.url, configs.machineToken);
  const registered = await fetch(`${configs.url}/machine/projects`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${configs.machineToken}` }, body: JSON.stringify({ slug, name: manifest.name ?? slug, manifest }) });
  if (!registered.ok) { console.error(`Registering the project failed (${registered.status})`); services.stop(); process.exit(1); }
  console.log(link ? `First run: create the owner account at ${link}` : `Open ${configs.url} (no sign-in on this machine)`);
  await services.finished;
} else if (command === 'connect' || command === 'work') {
  // A worker for a project made in the app. `connect` trades the app's single-use link for a token of this machine's own and
  // remembers it; `work` starts again from what was remembered. The token never appears on a command line.
  const positional = rest.filter(item => !item.startsWith('--') && item !== flag('--engine'));
  // `connect` with the folder but no link, and `work` in a folder nobody connected, ask for the link instead of stopping.
  const linkGiven = command === 'connect' && /^https?:\/\//.test(positional[0] ?? '');
  let link = linkGiven ? positional[0] : undefined;
  const checkout = path.resolve((linkGiven ? positional[1] : positional[0]) ?? '.');
  if (!existsSync(path.join(checkout, '.git'))) { console.error(`${checkout} is not a git checkout. Run this inside the project's folder, or give the folder as the last argument.`); process.exit(1); }
  const home = path.join(configDir(), 'workers');
  const connected = () => existsSync(home) ? readdirSync(home).map(name => path.join(home, name)).find(dir => { try { return Object.values((JSON.parse(readFileSync(path.join(dir, 'worker.json'), 'utf8')) as { projects: Record<string, string> }).projects).some(folder => path.resolve(folder) === checkout); } catch { return false; } }) : undefined;
  if (!link && (command === 'connect' || !connected())) {
    const ask = terminalAsk();
    // The app shows the whole command; pasting all of it is as good as pasting the link.
    if (ask) link = (await ask(`${command === 'work' ? 'This folder is not connected to a project yet. ' : ''}Paste the link the app's guide gives for another machine (good for 15 minutes)`)).replace(/^.*\bconnect\s+/, '');
  }
  if (command === 'connect' || link) {
    const parsed = /^(https?:\/\/[^/]+)\/pair\/([A-Za-z0-9-]{6,20})\/?$/.exec(link ?? '');
    if (!parsed) { console.error('Usage: agent-team connect <link from the app> [checkout]'); process.exit(1); }
    const engine = flag('--engine') ?? 'claude';
    if (!ENGINES.includes(engine)) { console.error(`Engine "${engine}" is not available here; choose one of: ${ENGINES.join(', ')}`); process.exit(1); }
    const response = await fetch(`${parsed[1]}/machine/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: parsed[2], name: os.hostname().slice(0, 40) }) }).catch(() => null);
    if (!response) { console.error(`Nothing answers at ${parsed[1]}`); process.exit(1); }
    const paired = await response.json().catch(() => null) as { token?: string; projectId?: string; slug?: string; error?: { message?: string } } | null;
    if (!response.ok || !paired?.token || !paired.projectId || !paired.slug) { console.error(paired?.error?.message ?? 'The link was not accepted. Make a new one in the app.'); process.exit(1); }
    const dir = path.join(home, paired.slug);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(dir, 'worker.json'), `${JSON.stringify({ coordinatorUrl: parsed[1], workerId: workerIdFor(os.hostname(), paired.slug), stateDir: path.join(dir, 'state'), engine, projects: { [paired.projectId]: checkout }, ...(publishTarget(checkout) ? { publish: publishTarget(checkout) } : {}) }, null, 2)}\n`, { mode: 0o600 });
    writeFileSync(path.join(dir, 'worker.env'), `AGENT_TEAM_TOKEN=${paired.token}\n`, { mode: 0o600 });
    console.log(`Connected to "${paired.slug}". Next time, run "agent-team work" in this folder.`);
  }
  const known = connected();
  if (!known) { console.error('This folder is not connected to a project yet. In the app, open Get started and copy the connect command.'); process.exit(1); }
  const token = /^AGENT_TEAM_TOKEN=(.+)$/m.exec(readFileSync(path.join(known, 'worker.env'), 'utf8'))?.[1];
  if (!token) { console.error(`${path.join(known, 'worker.env')} holds no token; connect again with a new link from the app.`); process.exit(1); }
  console.log(`Working from ${checkout}. Leave this running; stop it with Ctrl+C.`);
  const child = spawn(process.execPath, [path.join(packageRoot(), ENTRYPOINTS.worker), '--config', path.join(known, 'worker.json')], { env: { ...process.env, AGENT_TEAM_TOKEN: token }, stdio: 'inherit', windowsHide: true });
  process.on('SIGINT', () => child.kill('SIGTERM'));
  process.exitCode = await new Promise<number>(resolve => child.on('exit', code => resolve(code ?? 0)));
} else if (command === 'setup-link') {
  // Without a token in the environment, the coordinator `up` set up on this machine is meant, and its own token is used.
  const local = process.env.AGENT_TEAM_TOKEN ? null : await chooseLocal(process.cwd(), terminalAsk());
  const url = flag('--url') ?? local?.url ?? `http://127.0.0.1:${DEFAULT_PORT}`, token = process.env.AGENT_TEAM_TOKEN ?? local?.machineToken;
  if (!token) { console.error('There is no project set up with `agent-team up` on this machine to take the token from. For any other coordinator, set AGENT_TEAM_TOKEN to its machine token.'); process.exit(1); }
  console.log(await setupLink(url, token).catch(() => { console.error(`Nothing answers at ${url}. Start it first (agent-team up), or name another address with --url.`); process.exit(1); }) ?? 'An owner already exists; sign in instead.');
} else if (command === 'scorecard') {
  // The roadmap's figures for one project, from the coordinator that holds it: the local one, or AGENT_TEAM_TOKEN's at --url.
  const local = process.env.AGENT_TEAM_TOKEN ? null : await chooseLocal(process.cwd(), terminalAsk());
  const url = flag('--url') ?? local?.url ?? `http://127.0.0.1:${DEFAULT_PORT}`, token = process.env.AGENT_TEAM_TOKEN ?? local?.machineToken;
  if (!token) { console.error('There is no project set up with `agent-team up` on this machine to take the token from. For any other coordinator, set AGENT_TEAM_TOKEN to its machine token.'); process.exit(1); }
  const project = flag('--project') ?? local?.slug ?? slugFor(process.cwd());
  const response = await fetch(`${url}/machine/projects/${project}/scorecard?days=${Number(flag('--days')) || 30}`, { headers: { authorization: `Bearer ${token}` } }).catch(() => null);
  if (!response) { console.error(`Nothing answers at ${url}. Start it first (agent-team up), or name another address with --url.`); process.exit(1); }
  if (!response.ok) { console.error(response.status === 404 ? `The coordinator at ${url} has no project "${project}"; name one with --project.` : `The coordinator answered ${response.status}.`); process.exit(1); }
  const { printScorecard } = await import('../packages/coordinator/src/runtime/scorecardText.ts');
  console.log(flag('--json') !== undefined || rest.includes('--json') ? JSON.stringify(await response.json(), null, 2) : printScorecard(await response.json() as never, project));
} else if (command === 'migrate') {
  const file = flag('--config') ?? (await chooseLocal(process.cwd(), terminalAsk()))?.coordinator;
  if (!file) { console.error('There is no project set up with `agent-team up` on this machine. Name a coordinator config: agent-team migrate --config FILE'); process.exit(1); }
  const storage = await createStorage((JSON.parse(readFileSync(file, 'utf8')) as { storage: StorageConfig }).storage);
  await storage.migrate();
  await storage.close();
  console.log(`The database named in ${file} is up to date`);
} else if (command === 'backup') {
  const ask = terminalAsk();
  const local = flag('--config') ? null : await chooseLocal(process.cwd(), ask);
  const file = flag('--config') ?? local?.coordinator;
  if (!file) { console.error('There is no project set up with `agent-team up` on this machine. Name a coordinator config: agent-team backup --config FILE [--out FILE]'); process.exit(1); }
  const suggested = `agent-team-${local?.slug ?? slugFor(process.cwd())}-${new Date().toISOString().slice(0, 10)}.sqlite`;
  const out = flag('--out') ?? (ask ? await ask('Back up into', { fallback: suggested }) : suggested);
  if (existsSync(out)) { console.error(`${out} already exists; a backup never overwrites a file. Name another with --out.`); process.exit(1); }
  const storage = await createStorage((JSON.parse(readFileSync(file, 'utf8')) as { storage: StorageConfig }).storage);
  // A database that is a server is backed up with the server's own tools.
  if (!storage.backup) { console.error(`The ${storage.dialect} storage adapter has no file backup; use the database server's own`); await storage.close(); process.exit(1); }
  await storage.backup(path.resolve(out));
  await storage.close();
  console.log(`Backed up to ${path.resolve(out)}`);
} else if (command === 'export' || command === 'import') {
  // Moving a coordinator, from this machine to a hosted one say: the database (copied row by row, so it can change kind), the key its
  // secrets are sealed with, and the stored files. Nothing is overwritten: an export goes to a new folder, an import into an empty database.
  const ask = terminalAsk();
  const local = flag('--config') ? null : await chooseLocal(process.cwd(), ask);
  const file = flag('--config') ?? local?.coordinator;
  if (!file) { console.error(`There is no project set up with \`agent-team up\` on this machine. Name a coordinator config: agent-team ${command} --config FILE`); process.exit(1); }
  const config = JSON.parse(readFileSync(file, 'utf8')) as { storage: StorageConfig; dataDir?: string };
  const dataDir = config.dataDir ?? (config.storage.kind === 'sqlite' ? path.dirname(path.resolve(path.dirname(file), config.storage.path)) : null);
  const { copyDatabase } = await import('@agent-team/storage');
  const { cpSync } = await import('node:fs');
  // The key is copied where there is none (the same key already there is fine: it was checked); stored files are added, never replaced.
  const files = (from: string, to: string) => { for (const name of ['secret.key', 'blobs', 'artifacts']) if (existsSync(path.join(from, name)) && !(name === 'secret.key' && existsSync(path.join(to, name)))) cpSync(path.join(from, name), path.join(to, name), { recursive: true, force: false }); };
  if (command === 'export') {
    const out = path.resolve(flag('--out') ?? `agent-team-export-${new Date().toISOString().slice(0, 10)}`);
    if (existsSync(out)) { console.error(`${out} already exists; an export never overwrites. Name another with --out.`); process.exit(1); }
    mkdirSync(out, { recursive: true, mode: 0o700 });
    const source = await createStorage(config.storage);
    // A database file is read from a copy taken under its own locks, so the export is consistent while the coordinator runs.
    const snapshot = source.backup ? path.join(out, '.snapshot.sqlite') : null;
    if (snapshot) await source.backup!(snapshot);
    const from = snapshot ? await createStorage({ kind: 'sqlite', path: snapshot }) : source;
    const target = await createStorage({ kind: 'sqlite', path: path.join(out, 'coordinator.sqlite') });
    await target.migrate();
    const rows = await copyDatabase(from, target);
    await target.close(); await from.close(); if (from !== source) await source.close();
    if (snapshot) { const { rmSync } = await import('node:fs'); rmSync(snapshot, { force: true }); }
    if (dataDir) files(dataDir, out);
    console.log(`Exported ${rows} rows to ${out}${existsSync(path.join(out, 'secret.key')) ? ', with the key the secrets are sealed with: keep this folder private' : '. The secrets were sealed with AGENT_TEAM_SECRET_KEY: set the same on the coordinator that imports it'}`);
  } else {
    const from = path.resolve(rest.find(item => !item.startsWith('--') && item !== flag('--config')) ?? '');
    if (!existsSync(path.join(from, 'coordinator.sqlite'))) { console.error('Usage: agent-team import <export folder> [--config FILE]'); process.exit(1); }
    if (!dataDir) { console.error(`${file} names a database server; add "dataDir" to it, the folder its secrets key and stored files are kept in`); process.exit(1); }
    if (existsSync(path.join(dataDir, 'secret.key')) && existsSync(path.join(from, 'secret.key')) && readFileSync(path.join(dataDir, 'secret.key'), 'utf8').trim() !== readFileSync(path.join(from, 'secret.key'), 'utf8').trim()) { console.error(`${dataDir} already has a different secrets key; import into a coordinator that has not been started yet`); process.exit(1); }
    const source = await createStorage({ kind: 'sqlite', path: path.join(from, 'coordinator.sqlite') }), target = await createStorage(config.storage);
    await target.migrate();
    const rows = await copyDatabase(source, target);
    await source.close(); await target.close();
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    files(from, dataDir);
    console.log(`Imported ${rows} rows into the database named in ${file}, and the secrets key and stored files into ${dataDir}`);
  }
} else if (['init', 'deploy', 'status', 'destroy'].includes(command ?? '') && rest[0] === 'aws') {
  process.exit(await (await import('../adapters/hosting/aws/cli.ts')).awsCli(command!, rest.slice(1)));
} else if (command === 'call') {
  // The turn's token comes from a private file or the environment, never from the command line.
  const url = process.env.AGENT_TEAM_PLATFORM_URL, tokenFile = process.env.AGENT_TEAM_TURN_TOKEN_FILE;
  const token = tokenFile ? readFileSync(tokenFile, 'utf8').trim() : process.env.AGENT_TEAM_TURN_TOKEN;
  if (!url || !token || !rest[0]) { console.error('Usage: agent-team call <tool> [json] | --list, with AGENT_TEAM_PLATFORM_URL and AGENT_TEAM_TURN_TOKEN_FILE set by the worker'); process.exit(1); }
  const listing = rest[0] === '--list';
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: listing ? 'tools/list' : 'tools/call', params: listing ? {} : { name: rest[0], arguments: JSON.parse(rest[1] ?? '{}') } }) });
  const body = await response.json() as { result?: { content?: { text?: string }[]; isError?: boolean; tools?: { name: string; description?: string; inputSchema?: unknown }[] }; error?: { message?: string } };
  // The list says what each tool is for and what it takes, in a form a model reads at a glance.
  if (listing && body.result?.tools) console.log(body.result.tools.map(tool => `${tool.name}: ${tool.description ?? ''}\n  takes ${JSON.stringify((tool.inputSchema as { properties?: unknown } | undefined)?.properties ?? {})}`).join('\n'));
  else console.log(body.result?.content?.map(part => part.text).join('\n') ?? body.error?.message ?? `The call failed (${response.status})`);
  process.exit(response.ok && !body.error && !body.result?.isError ? 0 : 1);
} else if (command === 'mcp-bridge') {
  // For an engine that starts its MCP servers as programs: messages on stdin go to the server's address, its answers come back on stdout.
  // The token is read from its private file here, so it is in no command line and no environment.
  const [url, tokenFile] = rest;
  if (!url || !/^https?:\/\//.test(url)) { console.error('Usage: agent-team mcp-bridge <url> [token file]'); process.exit(1); }
  const token = tokenFile ? readFileSync(tokenFile, 'utf8').trim() : null;
  let session: string | null = null;
  const { createInterface } = await import('node:readline');
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    const response: Response | null = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(session ? { 'mcp-session-id': session } : {}) }, body: line }).catch(() => null);
    const id = (() => { try { return (JSON.parse(line) as { id?: unknown }).id; } catch { return undefined; } })();
    if (!response) { if (id !== undefined) process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: 'The server could not be reached' } })}\n`); continue; }
    session = response.headers.get('mcp-session-id') ?? session;
    const text = await response.text();
    // A notification has no answer; a stream carries its answers as data lines.
    const answers = (response.headers.get('content-type') ?? '').includes('text/event-stream') ? text.split('\n').filter((part: string) => part.startsWith('data:')).map((part: string) => part.slice(5).trim()) : [text.trim()];
    for (const answer of answers.filter(Boolean)) process.stdout.write(`${answer}\n`);
    if (!answers.some(Boolean) && id !== undefined && !response.ok) process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: `The server answered ${response.status}` } })}\n`);
  }
} else { console.log(USAGE); process.exit(command ? 1 : 0); }
