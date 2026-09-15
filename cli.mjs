import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient } from './worker.mjs';

export function parseEnqueueArgs(target, flags = []) {
  if (typeof target !== 'string' || !target || target.startsWith('-')) throw new Error('enqueue requires a project ID');
  const body = { projectId: target, publish: false, autoMerge: false }; const seen = new Set();
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (seen.has(flag)) throw new Error(`Duplicate ${flag}`); seen.add(flag);
    if (flag === '--publish') body.publish = true;
    else if (flag === '--auto-merge') body.autoMerge = true;
    else {
      const key = { '--issue': 'issue', '--key': 'idempotencyKey', '--base': 'base', '--model': 'model', '--timeout-minutes': 'timeoutMinutes' }[flag];
      if (!key || !flags[i + 1] || flags[i + 1].startsWith('--')) throw new Error(`Invalid option ${flag}`);
      const value = flags[++i]; body[key] = key === 'timeoutMinutes' ? Number(value) : value;
    }
  }
  if (body.autoMerge && !body.publish) throw new Error('--auto-merge requires explicit --publish authorization');
  return body;
}

export async function main(args = process.argv.slice(2)) {
  const request = createClient(process.env.AGENT_TEAM_URL ?? 'http://127.0.0.1:4310', process.env.AGENT_TEAM_TOKEN);
  const [command, target, ...flags] = args;
  let result;
  if (command === 'list' && args.length === 1) result = await request('/jobs');
  else if (command === 'requeue' && args.length === 2 && /^[a-f0-9-]{36}$/.test(target)) result = await request(`/jobs/${target}/requeue`, {});
  else if (command === 'enqueue' && target && !target.startsWith('-')) {
    const body = parseEnqueueArgs(target, flags);
    result = await request('/jobs', body);
  } else throw new Error('Usage: cli.mjs list | enqueue PROJECT [--issue ID] [--publish [--auto-merge]] [--key KEY] [--base REF] [--model MODEL] [--timeout-minutes N] | requeue JOB (only after human inspection)');
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
