// A real delivery end to end against a scratch repository on a real code host: a work turn writes and publishes a draft
// change, three review turns approve it at its head, and the merge gate merges it once the required check is green.
// Spends real model usage and writes to the named repository only. Usage: node scripts/pilot-delivery.ts <owner/name> [engine]
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTurns, startCoordinator } from '@agent-team/coordinator';
import { createWorker, type WorkerConfig } from '@agent-team/worker';
import { engineAdapter } from '../adapters/engine/index.ts';

const repository = process.argv[2];
if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository)) { console.error('Usage: node scripts/pilot-delivery.ts <owner/name> [engine]'); process.exit(1); }
const engine = engineAdapter(process.argv[3] ?? 'claude');
const token = 'pilot-machine-token-0123456789abcdef';
const checkout = mkdtempSync(path.join(os.tmpdir(), 'agent-team-pilot-delivery-'));
// Over HTTPS, so the machine's ordinary git credentials are what push the branch later.
execFileSync('git', ['clone', '-q', `https://github.com/${repository}.git`, checkout], { stdio: 'inherit' });

const coordinator = await startCoordinator({ port: 0, storage: { kind: 'sqlite', path: ':memory:' }, machineToken: token, webRoot: null, trackers: null });
const db = coordinator.context.storage.db;
const manifest = { scm: { kind: 'github' }, delivery: { repository, baseBranch: 'main', requiredChecks: ['verify'], autoMergeAuthorized: true, checkEnforcement: 'runner' } };
const registered = await fetch(`${coordinator.url}/machine/projects`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ slug: 'pilot', name: 'Pilot', manifest }) });
const projectId = (await registered.json() as { id: string }).id;
const agents = Object.fromEntries((await db.selectFrom('agents').select(['id', 'name']).execute()).map(agent => [agent.name, agent.id])) as Record<string, string>;
const taskId = 'pilot-delivery', now = Date.now(), key = `PILOT-${String(now).slice(-5)}`;
await db.insertInto('tasks').values({ id: taskId, project_id: projectId, key, source: 'internal', title: 'Add a words() helper', brief: 'Add words.js exporting words(text): the number of whitespace-separated words, 0 for an empty or blank string. Add words.test.js using node:test with three cases and run `npm test`. Keep it minimal, commit, then report with the task.update tool.', tag: null, priority: 0, milestone_id: null, state: 'in_progress', assignee_agent_id: agents.Ada!, author_agent_id: null, branch: null, head_sha: null, pr_url: null, blocked_reason: null, created_at: now, updated_at: now }).execute();

const exec: NonNullable<WorkerConfig['publish']>['exec'] = (bin, args, { cwd }) => new Promise((resolve, reject) => execFile(bin, args, { cwd, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => (error ? reject(new Error(String(stderr).trim().slice(-400) || error.message)) : resolve(stdout))));
const worker = createWorker({ coordinatorUrl: coordinator.url, token, workerId: 'pilot', stateDir: mkdtempSync(path.join(os.tmpdir(), 'agent-team-pilot-state-')), lanes: { work: 1, bounded: 1, deliver: 1 }, projects: { [projectId]: checkout }, engine, env: process.env, timeoutMs: 420_000,
  worktrees: { branchPrefix: 'agents/', base: 'HEAD' }, publish: { scm: 'github', repository, base: 'main', exec } });
await createTurns(coordinator.context).enqueue({ agentId: agents.Ada!, projectId, kind: 'work', taskId });

const task = () => db.selectFrom('tasks').select(['state', 'pr_url', 'head_sha', 'blocked_reason']).where('id', '=', taskId).executeTakeFirstOrThrow();
const show = async (label: string) => {
  const turn = await db.selectFrom('turns').select(['kind', 'state', 'stop_reason', 'summary', 'cost_minor']).orderBy('started_at', 'desc').executeTakeFirst();
  console.log(`${label}: turn ${turn?.kind}=${turn?.state}${turn?.stop_reason && turn.stop_reason !== 'completed' ? ` (${turn.stop_reason})` : ''} cost ${turn?.cost_minor ?? 0}c | task ${JSON.stringify(await task())}\n   ${(turn?.summary ?? '').replace(/\s+/g, ' ').slice(0, 260)}`);
};

// Work, then whatever the platform queues next (reviews, then the delivery), until nothing is left or something needs a person.
for (let round = 1; round <= 12; round++) {
  if (!await worker.tick()) {
    const waiting = await db.selectFrom('work_items').select(['kind', 'state', 'defer_reason', 'not_before']).where('state', '=', 'queued').execute();
    if (!waiting.length) break;
    console.log(`waiting: ${waiting.map(item => `${item.kind}${item.defer_reason ? `(${item.defer_reason})` : ''}`).join(', ')}`);
    await new Promise(resolve => setTimeout(resolve, 20_000));
    continue;
  }
  await worker.idle();
  await show(`round ${round}`);
  const state = (await task()).state;
  if (['done', 'blocked', 'quarantined'].includes(state)) break;
}
const approvals = await db.selectFrom('approvals').select(['kind', 'verdict', 'state']).where('task_id', '=', taskId).execute();
const queue = await db.selectFrom('merge_queue').select(['state', 'reason']).where('task_id', '=', taskId).execute();
const final = await task();
console.log(JSON.stringify({ task: final, approvals: approvals.map(row => `${row.kind}:${row.verdict}:${row.state}`), mergeQueue: queue, totalCostMinor: Number((await db.selectFrom('turns').select(eb => eb.fn.sum<number>('cost_minor').as('n')).executeTakeFirstOrThrow()).n) }, null, 2));
await coordinator.close();
process.exitCode = final.state === 'done' ? 0 : 1;
