#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { setupLink, startLocal, writeLocalConfigs } from '../adapters/hosting/local/up.ts';
import { ENGINES } from '../adapters/engine/index.ts';
import { DEFAULT_PORT } from '@agent-team/protocol';
import { createStorage, type StorageConfig } from '@agent-team/storage';

const USAGE = `agent-team <command>
  up [checkout] [--engine NAME] [--port N]   start the coordinator and a worker for a checkout on this machine
  demo                                       serve the sample organization on an in-memory database
  setup-link [--url URL]                     print a one-time link for creating the owner (needs AGENT_TEAM_TOKEN)
  migrate --config FILE                      bring the database named in a coordinator config up to date
  deploy aws [--plan|--apply] [--only STEP] [--skip STEP]   plan (the default) or apply the AWS deployment in <config dir>/aws-deployment.json
  status aws                                 show what the AWS deployment has recorded and the control plane's state
  destroy aws [--yes] [--roles] [--data] [--secrets]   list what would be deleted; delete it only with --yes
  call <tool> [json]                         call a platform tool from inside a turn, for engines that cannot mount the tool endpoint`;

const [command, ...rest] = process.argv.slice(2);
const flag = (name: string) => { const index = rest.indexOf(name); return index >= 0 ? rest[index + 1] : undefined; };

if (command === 'demo') await import('./agent-team-demo.ts');
else if (command === 'up') {
  const checkout = path.resolve(rest.find(item => !item.startsWith('--') && item !== flag('--engine') && item !== flag('--port')) ?? '.');
  const manifestFile = path.join(checkout, '.agent-team.json');
  if (!existsSync(manifestFile)) { console.error(`No .agent-team.json in ${checkout}`); process.exit(1); }
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as { name?: string; queueProjectId?: string; engine?: { default?: string } };
  const slug = (manifest.queueProjectId ?? path.basename(checkout)).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const engine = flag('--engine') ?? manifest.engine?.default ?? 'claude';
  if (!ENGINES.includes(engine)) { console.error(`Engine "${engine}" is not available here; choose one of: ${ENGINES.join(', ')}`); process.exit(1); }
  const configs = writeLocalConfigs({ projectId: slug, checkout, engine, ...(flag('--port') ? { port: Number(flag('--port')) } : {}) });
  const services = startLocal(configs);
  process.on('SIGINT', () => services.stop());
  const link = await setupLink(configs.url, configs.machineToken);
  const registered = await fetch(`${configs.url}/machine/projects`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${configs.machineToken}` }, body: JSON.stringify({ slug, name: manifest.name ?? slug, manifest }) });
  if (!registered.ok) { console.error(`Registering the project failed (${registered.status})`); services.stop(); process.exit(1); }
  console.log(link ? `First run: create the owner account at ${link}` : `Open ${configs.url}`);
  await services.finished;
} else if (command === 'setup-link') {
  const url = flag('--url') ?? `http://127.0.0.1:${DEFAULT_PORT}`, token = process.env.AGENT_TEAM_TOKEN;
  if (!token) { console.error('AGENT_TEAM_TOKEN is required'); process.exit(1); }
  console.log(await setupLink(url, token) ?? 'An owner already exists; sign in instead.');
} else if (command === 'migrate') {
  const file = flag('--config');
  if (!file) { console.error('Usage: agent-team migrate --config FILE'); process.exit(1); }
  const storage = await createStorage((JSON.parse(readFileSync(file, 'utf8')) as { storage: StorageConfig }).storage);
  await storage.migrate();
  await storage.close();
  console.log('The database is up to date');
} else if (['deploy', 'status', 'destroy'].includes(command ?? '') && rest[0] === 'aws') {
  process.exit(await (await import('../adapters/hosting/aws/cli.ts')).awsCli(command!, rest.slice(1)));
} else if (command === 'call') {
  // The turn's token comes from a private file or the environment, never from the command line.
  const url = process.env.AGENT_TEAM_PLATFORM_URL, tokenFile = process.env.AGENT_TEAM_TURN_TOKEN_FILE;
  const token = tokenFile ? readFileSync(tokenFile, 'utf8').trim() : process.env.AGENT_TEAM_TURN_TOKEN;
  if (!url || !token || !rest[0]) { console.error('Usage: agent-team call <tool> [json], with AGENT_TEAM_PLATFORM_URL and AGENT_TEAM_TURN_TOKEN_FILE set by the worker'); process.exit(1); }
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: rest[0], arguments: JSON.parse(rest[1] ?? '{}') } }) });
  const body = await response.json() as { result?: { content?: { text?: string }[]; isError?: boolean }; error?: { message?: string } };
  console.log(body.result?.content?.map(part => part.text).join('\n') ?? body.error?.message ?? `The call failed (${response.status})`);
  process.exit(response.ok && !body.error && !body.result?.isError ? 0 : 1);
} else { console.log(USAGE); process.exit(command ? 1 : 0); }
