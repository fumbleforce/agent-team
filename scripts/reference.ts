// The reference tasks of docs/ROADMAP.md: a fixed set of work, run the same way by different arms and scored by checks the
// agents never see. Two arms exist: `team` (the default team, with its reviews) and `solo` (one seat, no review: a single
// model working alone). A run spends real model usage unless the engine is `fake`, so it is never part of `npm test`.
//
//   node scripts/reference.ts run [--arm team|solo] [--engine NAME] [--model ID] [--seat-model NAME=ID,...] [--without NAME,...]
//                                [--task NAME] [--minutes N] [--out FILE]
// --seat-model puts single seats on another model (checkers on a different family than the author, say); --without runs the
// team with seats removed, which is how a seat is shown to earn its place (row T6).
//   node scripts/reference.ts report [FILE...]
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTurns, startCoordinator } from '@agent-team/coordinator';
import { createWorker } from '@agent-team/worker';
import { packageRoot } from '@agent-team/protocol';
import { engineAdapter } from '../adapters/engine/index.ts';

export interface ReferenceTask {
  name: string;
  dir: string;
  title: string;
  brief: string;
  kind: 'change' | 'document';
  stands_for: string;
  seeded?: string[];
  flawed?: string;
}

export type Arm = 'team' | 'solo';

export interface TaskResult {
  task: string;
  arm: Arm;
  engine: string;
  model: string | null;
  score: number | null;
  skipped?: string;
  notes: string[];
  state: string;
  turns: number;
  costUsd: number;
  tokens: number;
  ms: number;
  seededCaught?: boolean;
  questioned?: boolean;
}

export interface RunFile {
  at: string;
  arm: Arm;
  engine: string;
  model: string | null;
  // Seats that were taken out of the team for this run, and seats that ran on a model of their own.
  without?: string[];
  seatModels?: Record<string, string>;
  results: TaskResult[];
}

const TASKS_DIR = path.join(packageRoot(), 'reference', 'tasks');
// States in which the platform has nothing more to do on its own for this arm.
const SETTLED = ['approved', 'merging', 'done', 'canceled', 'blocked', 'quarantined', 'stopped'];
const TOKEN = 'reference-machine-token-0123456789';

export function loadTasks(dir: string = TASKS_DIR): ReferenceTask[] {
  return readdirSync(dir)
    .filter(name => existsSync(path.join(dir, name, 'task.json')))
    .sort()
    .map(name => ({ name, dir: path.join(dir, name), ...(JSON.parse(readFileSync(path.join(dir, name, 'task.json'), 'utf8')) as Omit<ReferenceTask, 'name' | 'dir'>) }));
}

// A hidden check is a script given the resulting tree and a file describing how the task ended. It prints one JSON object.
export function runCheck(task: ReferenceTask, tree: string, outcome: Record<string, unknown>): { score: number; notes: string[]; seededCaught?: boolean; questioned?: boolean } {
  const outcomeFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'agent-team-reference-outcome-')), 'outcome.json');
  writeFileSync(outcomeFile, JSON.stringify(outcome));
  const result = spawnSync(process.execPath, [path.join(task.dir, 'check.mjs'), tree, outcomeFile], { encoding: 'utf8', timeout: 60_000 });
  try {
    return JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '');
  } catch {
    return { score: 0, notes: [`the check did not report: ${(result.stderr || result.stdout).slice(-300)}`] };
  }
}

function prepareRepository(task: ReferenceTask): string {
  const checkout = mkdtempSync(path.join(os.tmpdir(), `agent-team-reference-${task.name}-`));
  if (existsSync(path.join(task.dir, 'repo'))) cpSync(path.join(task.dir, 'repo'), checkout, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: checkout, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(checkout, '.gitignore'), 'node_modules\n');
  git('add', '-A');
  git('-c', 'user.name=reference', '-c', 'user.email=reference@localhost', 'commit', '-q', '--allow-empty', '-m', 'Reference repository');
  return checkout;
}

export async function runTask(task: ReferenceTask, options: { arm: Arm; engine: string; model: string | null; minutes: number; without?: string[]; seatModels?: Record<string, string>; log?: (line: string) => void }): Promise<TaskResult> {
  const log = options.log ?? (() => {});
  const base = { task: task.name, arm: options.arm, engine: options.engine, model: options.model };
  const started = Date.now();
  const checkout = prepareRepository(task);
  const coordinator = await startCoordinator({ port: 0, storage: { kind: 'sqlite', path: ':memory:' }, machineToken: TOKEN, webRoot: null, trackers: null });
  try {
    const db = coordinator.context.storage.db;
    const registered = await fetch(`${coordinator.url}/machine/projects`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ slug: 'reference', name: 'Reference', manifest: {} }) });
    const projectId = ((await registered.json()) as { id: string }).id;
    if (options.model) await db.updateTable('agents').set({ model: options.model }).execute();
    const roster = await db.selectFrom('agents').select(['id', 'name', 'is_pm']).orderBy('sort').execute();
    const owner = roster.find(agent => !agent.is_pm) ?? roster[0]!;
    // Alone means alone: every other seat is paused, so nobody reviews, advises or decides.
    if (options.arm === 'solo') await db.updateTable('agents').set({ status: 'paused' }).where('id', '!=', owner.id).execute();
    for (const name of options.without ?? []) {
      if (name === owner.name) throw new Error(`${name} owns the reference task and cannot be taken out`);
      await db.updateTable('agents').set({ status: 'paused' }).where('name', '=', name).execute();
    }
    for (const [name, model] of Object.entries(options.seatModels ?? {})) await db.updateTable('agents').set({ model }).where('name', '=', name).execute();

    const taskId = `reference-${task.name}`;
    const now = Date.now();
    await db.insertInto('tasks').values({ id: taskId, project_id: projectId, key: 'REF-1', source: 'internal', title: task.title, brief: task.brief, tag: null, priority: 2, milestone_id: null, state: 'in_progress', assignee_agent_id: owner.id, author_agent_id: null, branch: null, head_sha: null, pr_url: null, blocked_reason: null, result_kind: task.kind, created_at: now, updated_at: now } as never).execute();

    const engine = engineAdapter(options.engine);
    const stateDir = mkdtempSync(path.join(os.tmpdir(), 'agent-team-reference-state-'));
    const worker = createWorker({ coordinatorUrl: coordinator.url, token: TOKEN, workerId: 'reference', stateDir, lanes: { work: 1, bounded: 2, deliver: 1 }, projects: { [projectId]: checkout }, engine, env: process.env, timeoutMs: options.minutes * 60_000, worktrees: { branchPrefix: 'agents/', base: 'HEAD' } });
    await createTurns(coordinator.context).enqueue({ agentId: owner.id, projectId, kind: 'work', taskId, dedupeKey: `reference:${task.name}` });

    const deadline = started + options.minutes * 60_000;
    let state = 'in_progress';
    let idle = 0;
    while (Date.now() < deadline) {
      const claimed = await worker.tick().catch(() => false);
      await worker.idle();
      state = (await db.selectFrom('tasks').select('state').where('id', '=', taskId).executeTakeFirstOrThrow()).state;
      // Alone, the work ends when its author says it is ready; with a team it ends when the team has settled it.
      if (SETTLED.includes(state) || (options.arm === 'solo' && state === 'in_review')) break;
      const waiting = await db.selectFrom('work_items').select('id').where('project_id', '=', projectId).where('state', 'in', ['queued', 'leased']).executeTakeFirst();
      idle = claimed || waiting ? 0 : idle + 1;
      // Nothing queued and nothing claimed for a while: the platform has let go of the task, which is itself a result.
      if (idle > 20) { log(`  nothing is queued for ${task.name} any more; it rests in ${state}`); break; }
      if (!claimed) await new Promise(resolve => setTimeout(resolve, 500));
    }

    const turns = await db.selectFrom('turns').select(['summary', 'tokens_in', 'tokens_out', 'cost_minor', 'kind']).where('project_id', '=', projectId).orderBy('started_at').execute();
    const costs = await db.selectFrom('cost_entries').select(['usd_minor']).where('project_id', '=', projectId).execute();
    const worktrees = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: checkout, encoding: 'utf8' }).split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice(9));
    const tree = worktrees.find(item => path.resolve(item) !== path.resolve(checkout)) ?? checkout;
    const changedFiles = execFileSync('git', ['-C', tree, 'diff', '--name-only', 'main'], { encoding: 'utf8' }).split('\n').filter(Boolean);
    const summary = turns.filter(turn => turn.kind === 'work').map(turn => turn.summary ?? '').join('\n');
    // A document is judged as it was handed in; one that never was is judged as nothing.
    const handedIn = (await db.selectFrom('tasks').select('result_ref').where('id', '=', taskId).executeTakeFirstOrThrow()).result_ref;
    const ref = handedIn ? (JSON.parse(handedIn) as { pageId: string; rev: number }) : null;
    const document = ref ? (await db.selectFrom('kb_revisions').select('body').where('page_id', '=', ref.pageId).where('rev_no', '=', ref.rev).executeTakeFirst())?.body ?? '' : '';
    const checked = runCheck(task, tree, { state, summary, changedFiles, document });
    return {
      ...base, score: checked.score, notes: checked.notes, state, turns: turns.length,
      costUsd: costs.reduce((sum, row) => sum + Number(row.usd_minor ?? 0), 0) / 100,
      tokens: turns.reduce((sum, turn) => sum + Number(turn.tokens_in) + Number(turn.tokens_out), 0),
      ms: Date.now() - started,
      ...(checked.seededCaught === undefined ? {} : { seededCaught: checked.seededCaught }),
      ...(checked.questioned === undefined ? {} : { questioned: checked.questioned }),
    };
  } finally {
    await coordinator.close();
  }
}

const mean = (values: number[]) => (values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length);

// The rows of the scorecard that compare arms. Only tasks both arms finished count toward a ratio.
export function report(files: RunFile[]) {
  const latest = (arm: Arm) => files.filter(file => file.arm === arm && !file.without?.length).sort((a, b) => a.at.localeCompare(b.at)).at(-1) ?? null;
  const team = latest('team'), solo = latest('solo');
  const scored = (file: RunFile | null) => new Map((file?.results ?? []).filter(result => result.score !== null).map(result => [result.task, result]));
  const teamScores = scored(team), soloScores = scored(solo);
  const both = [...teamScores.keys()].filter(task => soloScores.has(task));
  const ratio = (pick: (result: TaskResult) => number) => {
    const ours = mean(both.map(task => pick(teamScores.get(task)!))), theirs = mean(both.map(task => pick(soloScores.get(task)!)));
    return ours === null || theirs === null || theirs === 0 ? null : ours / theirs;
  };
  const shareOf = (file: RunFile | null, key: 'seededCaught' | 'questioned') => {
    const relevant = (file?.results ?? []).filter(result => result[key] !== undefined);
    return relevant.length === 0 ? null : relevant.filter(result => result[key]).length / relevant.length;
  };
  // Each run of the team with seats removed, against the newest full team run made the same way.
  const full = (file: RunFile) => !file.without?.length;
  const fullTeam = files.filter(file => file.arm === 'team' && full(file)).sort((a, b) => a.at.localeCompare(b.at)).at(-1) ?? null;
  const T6 = files.filter(file => file.arm === 'team' && !full(file)).map(file => {
    const theirs = scored(file), ours = scored(fullTeam);
    const shared = [...theirs.keys()].filter(task => ours.has(task));
    const withoutSeat = mean(shared.map(task => theirs.get(task)!.score!)), withSeat = mean(shared.map(task => ours.get(task)!.score!));
    const caughtWithout = shareOf(file, 'seededCaught'), caughtWith = shareOf(fullTeam, 'seededCaught');
    const earns = withoutSeat === null || withSeat === null ? null : withSeat - withoutSeat > 0.02 || (caughtWith ?? 0) > (caughtWithout ?? 0);
    return { without: file.without, comparedOn: shared, scoreWith: withSeat, scoreWithout: withoutSeat, caughtWith, caughtWithout, earnsItsPlace: earns };
  });
  return {
    comparedOn: both,
    T1: ratio(result => result.score!),
    T2: ratio(result => result.costUsd),
    T4: { team: shareOf(team, 'seededCaught'), solo: shareOf(solo, 'seededCaught') },
    I4: { team: shareOf(team, 'questioned'), solo: shareOf(solo, 'questioned') },
    T6,
    team: team && { at: team.at, engine: team.engine, model: team.model, meanScore: mean([...teamScores.values()].map(result => result.score!)) },
    solo: solo && { at: solo.at, engine: solo.engine, model: solo.model, meanScore: mean([...soloScores.values()].map(result => result.score!)) },
  };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const flag = (name: string) => { const index = rest.indexOf(name); return index < 0 ? undefined : rest[index + 1]; };
  const resultsDir = path.join(packageRoot(), 'reference', 'results');

  if (command === 'run') {
    const arm = (flag('--arm') ?? 'team') as Arm;
    if (arm !== 'team' && arm !== 'solo') { console.error('--arm is team or solo'); process.exit(1); }
    const engine = flag('--engine') ?? 'claude', model = flag('--model') ?? null, minutes = Number(flag('--minutes')) || 30;
    const without = (flag('--without') ?? '').split(',').filter(Boolean);
    const seatModels = Object.fromEntries((flag('--seat-model') ?? '').split(',').filter(Boolean).map(pair => pair.split('=') as [string, string]));
    const tasks = loadTasks().filter(task => !flag('--task') || task.name === flag('--task'));
    if (tasks.length === 0) { console.error(`No reference task named ${flag('--task')}`); process.exit(1); }
    const results: TaskResult[] = [];
    for (const task of tasks) {
      console.log(`${task.name} (${task.stands_for}), ${arm} on ${engine}${model ? ` ${model}` : ''}`);
      const result = await runTask(task, { arm, engine, model, minutes, without, seatModels, log: console.log });
      console.log(result.skipped ? `  skipped: ${result.skipped}` : `  score ${result.score?.toFixed(2)}, ended ${result.state} after ${result.turns} turns, $${result.costUsd.toFixed(2)}, ${Math.round(result.ms / 1000)} s${result.notes.length ? `\n  ${result.notes.join('\n  ')}` : ''}`);
      results.push(result);
    }
    const file: RunFile = { at: new Date().toISOString(), arm, engine, model, ...(without.length ? { without } : {}), ...(Object.keys(seatModels).length ? { seatModels } : {}), results };
    const out = flag('--out') ?? path.join(resultsDir, `${file.at.replace(/[:.]/g, '-')}-${arm}${without.length ? `-without-${without.join('-')}` : ''}.json`);
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`);
    console.log(`Wrote ${out}`);
    return;
  }

  if (command === 'report') {
    const named = rest.filter(item => !item.startsWith('--'));
    const paths = named.length ? named : existsSync(resultsDir) ? readdirSync(resultsDir).filter(name => name.endsWith('.json')).map(name => path.join(resultsDir, name)) : [];
    if (paths.length === 0) { console.error('No reference runs yet. Run: node scripts/reference.ts run --arm team, then --arm solo'); process.exit(1); }
    console.log(JSON.stringify(report(paths.map(file => JSON.parse(readFileSync(file, 'utf8')) as RunFile)), null, 2));
    return;
  }

  console.error('Usage: node scripts/reference.ts run [--arm team|solo] [--engine NAME] [--model ID] [--task NAME] [--minutes N] [--out FILE]\n       node scripts/reference.ts report [FILE...]');
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) await main();
