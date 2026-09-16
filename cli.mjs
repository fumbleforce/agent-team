import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient } from './worker.mjs';
import { remoteBase } from './git-base.mjs';

export function parseEnqueueArgs(target, flags = []) {
  if (typeof target !== 'string' || !target || target.startsWith('-')) throw new Error('enqueue requires a project ID');
  const body = { projectId: target, publish: false, autoMerge: false }; const seen = new Set();
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (seen.has(flag)) throw new Error(`Duplicate ${flag}`); seen.add(flag);
    if (flag === '--publish') body.publish = true;
    else if (flag === '--auto-merge') body.autoMerge = true;
    else if (flag === '--ideate') body.kind = 'ideation';
    else if (flag === '--fetch') body.fetch = true;
    else if (flag === '--approval-required') body.approvalRequired = true;
    else {
      const key = { '--proposal-limit': 'proposalLimit', '--issue': 'issue', '--key': 'idempotencyKey', '--base': 'base', '--engine': 'engine', '--model': 'model', '--timeout-minutes': 'timeoutMinutes' }[flag];
      if (!key || !flags[i + 1] || flags[i + 1].startsWith('--')) throw new Error(`Invalid option ${flag}`);
      const value = flags[++i]; body[key] = ['timeoutMinutes', 'proposalLimit'].includes(key) ? Number(value) : value;
    }
  }
  if (body.autoMerge && !body.publish) throw new Error('--auto-merge requires explicit --publish authorization');
  if (body.fetch) remoteBase(body.base);
  if (body.kind === 'ideation') {
    if (body.issue || body.publish || body.autoMerge || body.approvalRequired) throw new Error('Ideation forbids issue, publishing and approval flags');
    if (!Number.isInteger(body.proposalLimit) || body.proposalLimit < 1 || body.proposalLimit > 10) throw new Error('--ideate requires --proposal-limit 1..10');
    delete body.publish; delete body.autoMerge;
  } else {
    if (body.proposalLimit !== undefined) throw new Error('--proposal-limit requires --ideate');
    if (body.approvalRequired && !body.issue) throw new Error('--approval-required requires --issue');
  }
  return body;
}

// Without an exported token, use the private service environment written by install-local.mjs.
export function localToken(env = process.env, home = homedir()) {
  if (env.AGENT_TEAM_TOKEN) return env.AGENT_TEAM_TOKEN;
  try { return /^AGENT_TEAM_TOKEN=(\S+)$/m.exec(readFileSync(path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'agent-team', 'service.env'), 'utf8'))?.[1]; }
  catch { return undefined; }
}

export async function main(args = process.argv.slice(2)) {
  const request = createClient(process.env.AGENT_TEAM_URL ?? 'http://127.0.0.1:4310', localToken());
  const [command, target, ...flags] = args;
  let result;
  if (command === 'list' && args.length === 1) result = await request('/jobs');
  else if (command === 'requeue' && args.length === 2 && /^[a-f0-9-]{36}$/.test(target)) result = await request(`/jobs/${target}/requeue`, {});
  else if (command === 'cancel' && args.length === 2 && /^[a-f0-9-]{36}$/.test(target)) result = await request(`/jobs/${target}/cancel`, {});
  else if (command === 'enqueue' && target && !target.startsWith('-')) {
    const body = parseEnqueueArgs(target, flags);
    result = await request('/jobs', body);
  } else throw new Error('Usage: cli.mjs list | enqueue PROJECT [--issue ID [--approval-required]] [--publish [--auto-merge]] [--ideate --proposal-limit N] [--key KEY] [--base REF [--fetch]] [--engine opencode|claude] [--model MODEL] [--timeout-minutes N] | cancel JOB | requeue JOB (only after human inspection)');
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
