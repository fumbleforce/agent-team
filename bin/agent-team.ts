#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { setupLink, startLocal, writeLocalConfigs } from '../adapters/hosting/local/up.ts';
import { ENGINES } from '../adapters/engine/index.ts';

const USAGE = `agent-team <command>
  up [checkout] [--engine NAME] [--port N]   start the coordinator and a worker for a checkout on this machine
  demo                                       serve the sample organization on an in-memory database`;

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
} else { console.log(USAGE); process.exit(command ? 1 : 0); }
