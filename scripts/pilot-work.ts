// Two real work turns on one task against an installed engine CLI, in a throwaway repository and an in-memory database:
// the first writes code in the task's worktree, the second resumes the same engine session. Spends real model usage, so it
// is never part of `npm test`. Usage: node scripts/pilot-work.ts [engine]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTurns, startCoordinator } from '@agent-team/coordinator';
import { createWorker } from '@agent-team/worker';
import { engineAdapter } from '../adapters/engine/index.ts';

const engine = engineAdapter(process.argv[2] ?? 'claude');
const token = 'pilot-machine-token-0123456789abcdef';
const checkout = mkdtempSync(path.join(os.tmpdir(), 'agent-team-pilot-work-'));
const git = (...args: string[]) => execFileSync('git', args, { cwd: checkout, encoding: 'utf8' });
git('init', '-q', '-b', 'main');
writeFileSync(path.join(checkout, 'package.json'), `${JSON.stringify({ name: 'pilot', type: 'module', private: true, scripts: { test: 'node --test' } }, null, 2)}\n`);
writeFileSync(path.join(checkout, 'slug.js'), 'export function slug(text) {\n  return text.toLowerCase();\n}\n');
writeFileSync(path.join(checkout, '.env'), 'SECRET=never-visible-to-the-agent\n');
writeFileSync(path.join(checkout, '.gitignore'), 'node_modules\n');
git('add', '-f', '.'); git('-c', 'user.name=pilot', '-c', 'user.email=pilot@localhost', 'commit', '-q', '-m', 'Pilot repository');

const coordinator = await startCoordinator({ port: 0, storage: { kind: 'sqlite', path: ':memory:' }, machineToken: token, webRoot: null, trackers: null });
const db = coordinator.context.storage.db;
const registered = await fetch(`${coordinator.url}/machine/projects`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ slug: 'pilot', name: 'Pilot', manifest: {} }) });
const projectId = (await registered.json() as { id: string }).id;
const ada = await db.selectFrom('agents').select('id').where('name', '=', 'Ada').executeTakeFirstOrThrow();
const taskId = 'pilot-task';
const now = Date.now();
await db.insertInto('tasks').values({ id: taskId, project_id: projectId, key: 'PILOT-1', source: 'internal', title: 'Make slug() turn spaces into dashes', brief: 'slug.js lowercases only. Make slug("Hello World") return "hello-world" (runs of whitespace become one dash, trimmed). Add slug.test.js using node:test with two cases and run `npm test`. Keep the change minimal, then report what you did with the task.update tool.', tag: null, priority: 0, milestone_id: null, state: 'in_progress', assignee_agent_id: ada.id, author_agent_id: null, branch: null, head_sha: null, pr_url: null, blocked_reason: null, created_at: now, updated_at: now } as never).execute();

const stateDir = mkdtempSync(path.join(os.tmpdir(), 'agent-team-pilot-state-'));
const worker = createWorker({ coordinatorUrl: coordinator.url, token, workerId: 'pilot', stateDir, lanes: { work: 1, bounded: 1, deliver: 1 }, projects: { [projectId]: checkout }, engine, env: process.env, timeoutMs: 300_000, worktrees: { branchPrefix: 'agents/', base: 'HEAD' } });
const turns = createTurns(coordinator.context);

async function run(label: string) {
  await db.updateTable('work_items').set({ state: 'done' }).where('state', '=', 'queued').execute();
  await turns.enqueue({ agentId: ada.id, projectId, kind: 'work', taskId, dedupeKey: `pilot:${label}` });
  console.log(`\n== ${label}: claimed ${await worker.tick()}`);
  await worker.idle();
  const turn = await db.selectFrom('turns').selectAll().orderBy('started_at', 'desc').executeTakeFirstOrThrow();
  const steps = await db.selectFrom('trace_steps').select(['seq', 'kind', 'title']).where('turn_id', '=', turn.id).orderBy('seq').execute();
  const artifacts = await db.selectFrom('step_artifacts').select(['seq', 'kind', 'bytes']).where('turn_id', '=', turn.id).orderBy('seq').execute();
  const session = turn.session_id ? await db.selectFrom('agent_sessions').selectAll().where('id', '=', turn.session_id).executeTakeFirst() : null;
  const tools = (await coordinator.context.events.read({ after: 0, limit: 2000 })).filter(event => event.type === 'tool.called' && event.turnId === turn.id).map(event => String(event.payload.tool));
  console.log(JSON.stringify({ state: turn.state, stopReason: turn.stop_reason, contextMode: turn.context_mode, summary: turn.summary?.slice(0, 300), tokensIn: turn.tokens_in, tokensOut: turn.tokens_out, costMinor: turn.cost_minor,
    steps: steps.map(step => `${step.kind}: ${step.title.slice(0, 80)}`), artifacts: artifacts.map(item => `${item.seq}:${item.kind}:${item.bytes}b`), platformCalls: tools,
    session: session ? { engineSessionId: Boolean(session.engine_session_id), turnCount: session.turn_count, state: session.state } : null }, null, 2));
  return turn;
}

const first = await run('write turn');
const worktrees = git('worktree', 'list').trim().split('\n');
const tree = worktrees.at(-1)!.split(/\s+/)[0]!;
console.log(`worktree: ${tree}`);
console.log(`changed against base: ${execFileSync('git', ['-C', tree, 'status', '--short'], { encoding: 'utf8' }).trim().replaceAll('\n', ' | ') || '(nothing uncommitted)'} ; commits: ${execFileSync('git', ['-C', tree, 'log', '--oneline', 'main..HEAD'], { encoding: 'utf8' }).trim().replaceAll('\n', ' | ') || '(none)'}`);
console.log(`secret excluded from the worktree: ${(() => { try { execFileSync('git', ['-C', tree, 'ls-files', '--error-unmatch', '.env'], { stdio: 'ignore' }); return !existsSync(path.join(tree, '.env')); } catch { return !existsSync(path.join(tree, '.env')); } })()}`);
try { console.log(`tests in the worktree: ${execFileSync('node', ['--test'], { cwd: tree, encoding: 'utf8' }).match(/# pass \d+|ℹ pass \d+/)?.[0] ?? 'ran'}`); } catch (error) { console.log(`tests in the worktree FAILED: ${String((error as { stdout?: string }).stdout ?? error).slice(-300)}`); }

// A person adds a requirement; the second turn should resume the same engine session rather than start over.
const thread = await db.selectFrom('threads').select('id').where('project_id', '=', projectId).where('kind', '=', 'discussion').executeTakeFirst();
if (thread) await db.insertInto('messages').values({ id: `pilot-msg-${now}`, thread_id: thread.id, author_kind: 'user', author_id: null, kind: 'decision', body: 'Decision for PILOT-1: slug() must also strip everything except letters, digits and dashes, e.g. slug("Hi, there!") is "hi-there". Add a test for it.', payload: '{}', created_at: Date.now() }).execute();
await db.updateTable('tasks').set({ state: 'in_progress', updated_at: Date.now(), brief: 'Follow-up: slug() must also strip everything except letters, digits and dashes, so slug("Hi, there!") is "hi-there". Add one test, run `npm test`, report with task.update.' }).where('id', '=', taskId).execute();
const second = await run('resumed turn');
console.log(`\nresumed the same session: ${first.session_id !== null && first.session_id === second.session_id && second.context_mode === 'resume'}`);
try { console.log(`tests after the second turn: ${execFileSync('node', ['--test'], { cwd: tree, encoding: 'utf8' }).match(/ℹ pass \d+/)?.[0] ?? 'ran'}`); } catch (error) { console.log(`tests after the second turn FAILED: ${String((error as { stdout?: string }).stdout ?? error).slice(-300)}`); }
console.log(`state dir: ${stateDir}`);
await coordinator.close();
process.exitCode = first.state === 'completed' && second.state === 'completed' ? 0 : 1;
