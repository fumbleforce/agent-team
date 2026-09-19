#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient } from './worker.mjs';

// Seeds a project's memory from its checkout: the manifest's instruction files, the charter and any
// extra files or directories given on the command line become confirmed convention items, one per
// file, committed as the owner. Run once when a project joins, and again when the rules change.
//   seed-memory.mjs --project /abs/checkout [--id QUEUE_PROJECT_ID] [--coordinator http://127.0.0.1:4310] [--include docs/conventions.md]... [--dry-run]
const USAGE = 'Usage: seed-memory.mjs --project /absolute/checkout [--id QUEUE_PROJECT_ID] [--coordinator URL] [--include PATH]... [--dry-run]';
const MAX_FILE = 8000;

export function parseArgs(args) {
  const options = { include: [], dryRun: false };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--dry-run') options.dryRun = true;
    else if (['--project', '--id', '--coordinator'].includes(flag) && args[i + 1] && !args[i + 1].startsWith('--')) options[flag.slice(2)] = args[++i];
    else if (flag === '--include' && args[i + 1] && !args[i + 1].startsWith('--')) options.include.push(args[++i]);
    else throw new Error(USAGE);
  }
  if (!options.project || !path.isAbsolute(options.project)) throw new Error(USAGE);
  return options;
}

// Expands directories to their markdown-like files; skips anything outside the checkout. Names are
// repository paths with forward slashes on every platform, as memory scopes and sources require.
const repositoryPath = (checkout, absolute) => path.relative(checkout, absolute).split(path.sep).join('/');
function expand(checkout, relative) {
  const absolute = path.resolve(checkout, relative);
  if (!absolute.startsWith(checkout + path.sep)) throw new Error(`Refusing to read outside the checkout: ${relative}`);
  let info;
  try { info = statSync(absolute); } catch { return []; }
  if (info.isFile()) return [repositoryPath(checkout, absolute)];
  return readdirSync(absolute).filter(name => /\.(md|mdc|txt)$/.test(name)).sort().map(name => repositoryPath(checkout, path.join(absolute, name)));
}

// Collects { relativePath: content } for the manifest's instruction files, charter and includes.
export function collectSeedFiles(checkout, manifest, include = []) {
  const wanted = [...(manifest.instructions ?? []), ...(manifest.charter ? [manifest.charter] : []), ...include];
  const files = {};
  for (const entry of wanted) {
    for (const relative of expand(checkout, entry)) {
      const content = readFileSync(path.join(checkout, relative), 'utf8').trim();
      if (content) files[relative] = content.slice(0, MAX_FILE);
    }
  }
  return files;
}

export async function seedMemory({ project, id, coordinator = 'http://127.0.0.1:4310', include = [], dryRun = false, token = process.env.AGENT_TEAM_TOKEN, log = console.log }) {
  const manifest = JSON.parse(readFileSync(path.join(project, '.agent-team.json'), 'utf8'));
  const projectId = id ?? manifest.queueProjectId;
  if (!projectId) throw new Error('Pass --id or set queueProjectId in .agent-team.json');
  const files = collectSeedFiles(project, manifest, include);
  const names = Object.keys(files);
  if (!names.length) throw new Error('No instruction files found to seed from');
  for (const name of names) log(`${name} (${files[name].length} chars)`);
  if (dryRun) { log(`Dry run: ${names.length} file${names.length === 1 ? '' : 's'} would seed memory for ${projectId}`); return { projectId, files: names, sha: null }; }
  const request = createClient(coordinator, token);
  await request(`/projects/${projectId}/memory/init`, {});
  const result = await request(`/projects/${projectId}/memory/seed`, { files, author: { name: 'Owner' } });
  log(`Seeded ${result.ids.length} item${result.ids.length === 1 ? '' : 's'} for ${projectId} at ${result.sha.slice(0, 8)}`);
  return { projectId, files: names, sha: result.sha };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  seedMemory(parseArgs(process.argv.slice(2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
