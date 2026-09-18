#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// The `team` command available to engines inside a run: the project's shared channel, reached
// through the coordinator with the job's lease. A run can read its project's channel and post
// as its own role; it cannot post for another project or delete anything. Usage:
//   team read [--after SEQ] [--limit N]
//   team say <text>                      a note
//   team claim|blocker|handoff|question <text>
const KINDS = ['note', 'claim', 'blocker', 'handoff', 'question'];
const USAGE = 'Usage: team read [--after SEQ] [--limit N] | team say <text> | team claim|blocker|handoff|question <text>';

export function parseTeamArgs(args) {
  const [command, ...rest] = args;
  if (command === 'read') {
    const options = { command, after: 0, limit: 30 };
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--after' && /^\d+$/.test(rest[i + 1] ?? '')) options.after = Number(rest[++i]);
      else if (rest[i] === '--limit' && /^\d+$/.test(rest[i + 1] ?? '')) options.limit = Math.min(Math.max(Number(rest[++i]), 1), 200);
      else throw new Error(USAGE);
    }
    return options;
  }
  const kind = command === 'say' ? 'note' : command;
  if (!KINDS.includes(kind) || !rest.length) throw new Error(USAGE);
  return { command: 'post', kind, body: rest.join(' ') };
}

export function formatPosts(posts) {
  if (!posts.length) return 'The team channel is empty.';
  return posts.map(post => `#${post.seq} ${new Date(post.createdAt).toISOString().slice(0, 16).replace('T', ' ')} ${post.author}${post.kind === 'note' ? '' : ` [${post.kind}]`}: ${post.body}`).join('\n');
}

export async function runTeamCli(args, env = process.env, fetchImpl = fetch) {
  const parsed = parseTeamArgs(args);
  const url = env.AGENT_TEAM_MEMORY_URL; const job = env.AGENT_TEAM_MEMORY_JOB; const lease = env.AGENT_TEAM_MEMORY_LEASE;
  if (!url || !job || !lease) throw new Error('team is only available inside an agent-team run');
  const [workerId, leaseToken] = lease.split(':');
  const projectId = env.AGENT_TEAM_MEMORY_PROJECT;
  const call = async (route, body) => {
    const response = await fetchImpl(new URL(route, url), { method: body ? 'POST' : 'GET', headers: { authorization: `Lease ${job}:${lease}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`team request failed (${response.status})`);
    return response.json();
  };
  if (parsed.command === 'read') return formatPosts(await call(`/projects/${projectId}/channel?after=${parsed.after}&limit=${parsed.limit}`));
  const post = await call(`/jobs/${job}/channel`, { workerId, leaseToken, kind: parsed.kind, body: parsed.body });
  return `Posted #${post.seq} as ${post.author}.`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runTeamCli(process.argv.slice(2)).then(text => console.log(text)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
