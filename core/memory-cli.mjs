#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// The `memory` command available to engines inside a run. It reaches the coordinator with the
// job's lease, so it can only search the project's memory and propose new items for that job;
// it never writes memory directly. Usage:
//   memory search <query words> [--scope AREA]...
//   memory propose <type> <title> -- <body> [--scope AREA]...
const USAGE = 'Usage: memory search <query> [--scope AREA]... | memory propose <observation|gotcha|decision|run> <title> -- <body> [--scope AREA]...';

export function parseMemoryArgs(args) {
  const [command, ...rest] = args;
  const scope = []; const words = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--scope' && rest[i + 1]) scope.push(rest[++i]);
    else words.push(rest[i]);
  }
  if (command === 'search') {
    if (!words.length) throw new Error(USAGE);
    return { command, query: words.join(' '), scope };
  }
  if (command === 'propose') {
    const separator = words.indexOf('--');
    if (words.length < 3 || separator < 2) throw new Error(USAGE);
    return { command, type: words[0], title: words.slice(1, separator).join(' '), body: words.slice(separator + 1).join(' '), scope };
  }
  throw new Error(USAGE);
}

export async function runMemoryCli(args, env = process.env, fetchImpl = fetch) {
  const parsed = parseMemoryArgs(args);
  const url = env.AGENT_TEAM_MEMORY_URL; const job = env.AGENT_TEAM_MEMORY_JOB; const lease = env.AGENT_TEAM_MEMORY_LEASE;
  if (!url || !job || !lease) throw new Error('memory is only available inside an agent-team run');
  const [workerId, leaseToken] = lease.split(':');
  const projectId = env.AGENT_TEAM_MEMORY_PROJECT;
  const call = async (route, body) => {
    const response = await fetchImpl(new URL(route, url), { method: body ? 'POST' : 'GET', headers: { authorization: `Lease ${job}:${lease}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`memory request failed (${response.status})`);
    return response.json();
  };
  if (parsed.command === 'search') {
    const results = await call(`/projects/${projectId}/memory/search?q=${encodeURIComponent(parsed.query)}${parsed.scope.map(value => `&scope=${encodeURIComponent(value)}`).join('')}&limit=10`);
    return results.map(item => `## ${item.title} (${item.id}, ${item.type}${item.confirmed ? ', confirmed' : ''})\n${item.body}`).join('\n\n') || 'No memory items match.';
  }
  const result = await call(`/jobs/${job}/proposals`, { workerId, leaseToken, items: [{ type: parsed.type, title: parsed.title, body: parsed.body, scope: parsed.scope }] });
  return `Proposed for memory review: ${result.ids.join(', ')}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runMemoryCli(process.argv.slice(2)).then(text => console.log(text)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
