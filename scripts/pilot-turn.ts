// One real, read-only turn against an installed engine CLI, in a throwaway repository and an in-memory database.
// It spends a little real model usage, so it is never part of `npm test`. Usage: node scripts/pilot-turn.ts [engine]
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTurns, seedDemo, startCoordinator } from '@agent-team/coordinator';
import { createWorker } from '@agent-team/worker';
import { engineAdapter } from '../adapters/engine/index.ts';

const engine = engineAdapter(process.argv[2] ?? 'claude');
const token = 'pilot-machine-token-0123456789abcdef';
const checkout = mkdtempSync(path.join(os.tmpdir(), 'agent-team-pilot-'));
const git = (...args: string[]) => execFileSync('git', args, { cwd: checkout, stdio: 'ignore' });
git('init', '-q', '-b', 'main');
writeFileSync(path.join(checkout, 'README.md'), '# Pilot\n\nThe answer to the pilot question is 42.\n');
git('add', '.'); git('-c', 'user.name=pilot', '-c', 'user.email=pilot@localhost', 'commit', '-q', '-m', 'Pilot repository');

const coordinator = await startCoordinator({ port: 0, storage: { kind: 'sqlite', path: ':memory:' }, machineToken: token, webRoot: null });
await seedDemo(coordinator.context);
const db = coordinator.context.storage.db;
const project = await db.selectFrom('projects').select('id').where('slug', '=', 'checkout-v2').executeTakeFirstOrThrow();
const agent = await db.selectFrom('agents').select('id').where('name', '=', 'Bram').executeTakeFirstOrThrow();
const thread = await db.selectFrom('threads').select('id').where('project_id', '=', project.id).where('kind', '=', 'discussion').executeTakeFirstOrThrow();
const before = await db.selectFrom('messages').select(eb => eb.fn.countAll<number>().as('n')).where('thread_id', '=', thread.id).executeTakeFirstOrThrow();
await createTurns(coordinator.context).enqueue({ agentId: agent.id, projectId: project.id, kind: 'reply', threadId: thread.id });

const stateDir = mkdtempSync(path.join(os.tmpdir(), 'agent-team-pilot-state-'));
const worker = createWorker({ coordinatorUrl: coordinator.url, token, workerId: 'pilot', stateDir, lanes: { work: 1, bounded: 1, deliver: 1 }, projects: { [project.id]: checkout }, engine, env: process.env, timeoutMs: 180_000 });
console.log(`claimed: ${await worker.tick()}`);
await worker.idle();

const turn = await db.selectFrom('turns').selectAll().executeTakeFirstOrThrow();
const steps = await db.selectFrom('trace_steps').select(['kind', 'title']).orderBy('seq').execute();
const tools = (await coordinator.context.events.read({ after: 0, limit: 1000 })).filter(event => event.type === 'tool.called').map(event => String(event.payload.tool));
const after = await db.selectFrom('messages').select(eb => eb.fn.countAll<number>().as('n')).where('thread_id', '=', thread.id).executeTakeFirstOrThrow();
console.log(JSON.stringify({ state: turn.state, stopReason: turn.stop_reason, summary: turn.summary, tokensIn: turn.tokens_in, tokensOut: turn.tokens_out, costMinor: turn.cost_minor, steps, platformCalls: tools, messagesPosted: Number(after.n) - Number(before.n), stateDir }, null, 2));
await coordinator.close();
process.exitCode = turn.state === 'completed' ? 0 : 1;
