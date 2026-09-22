import type { Context } from '../context.ts';
import { checkInvariants } from './invariants.ts';
import { SURE, UNSURE } from './decisions.ts';
import { confidenceOf, type Answer } from '../../../../adapters/decider/contract.ts';

// The scorecard of docs/ROADMAP.md: every figure is added up from what the coordinator already records. A figure that cannot be
// computed yet (nothing to count, or a record that does not exist yet) has a null value and says why, so an empty baseline is
// never mistaken for a good one.
export type Unit = 'share' | 'count' | 'ms' | 'usd' | 'per100' | 'ratio';
export type Group = 'team-vs-one' | 'self-improving' | 'autonomy' | 'performance' | 'delivery' | 'observability' | 'safety' | 'decisions';

export interface Figure {
  id: string;
  group: Group;
  measure: string;
  value: number | null;
  unit: Unit;
  // How many things the value was computed over; a share of two tasks reads differently from a share of two hundred.
  sample: number;
  target: string;
  met: boolean | null;
  note?: string;
}

export interface Scorecard {
  projectId: string;
  from: number;
  to: number;
  computedAt: number;
  figures: Figure[];
}

export interface ScorecardOptions {
  // Which models count as open-weight. Model names belong to the adapters, so the platform is told rather than knowing.
  openWeight?: (model: string | null, providerKind: string | null) => boolean;
  // Which family a model belongs to, for telling whether two checkers share blind spots.
  modelFamily?: (model: string | null) => string | null;
}

// Every figure the scorecard computes. A trial names one of them as what it expects to move.
export const FIGURE_IDS = ['T1', 'T2', 'T3', 'T4', 'T5', 'T7', 'I1', 'I2', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'P1', 'P2', 'P3', 'P4', 'P5', 'D1', 'D2', 'O1', 'O2', 'S1', 'S2', 'S3', 'S4', 'C1', 'C2', 'C3'] as const;

const MINUTE = 60_000;
const DAY = 24 * 3600_000;
const UNATTENDED_MS = 10 * MINUTE;
const OPEN_STATES = ['assigned', 'in_progress'] as const;
// Kinds of turn that run a model and so must leave a trace behind.
const DETERMINISTIC = new Set(['publish', 'deliver', 'capture']);
// What a person does to a task by hand, as the event log names it.
const HAND_EVENTS = ['task.state_changed', 'task.assigned', 'task.stopped', 'task.handed_off', 'work_item.moved', 'turn.interrupted'];

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

const share = (part: number, whole: number) => (whole === 0 ? null : part / whole);

function figure(input: Omit<Figure, 'met'> & { meets?: (value: number) => boolean }): Figure {
  const { meets, ...rest } = input;
  return { ...rest, met: rest.value === null || !meets ? null : meets(rest.value) };
}

// Two findings are the same finding when they name the same file or mostly use the same words.
const words = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []);
export function sameFinding(a: { path?: string | undefined; note: string }, b: { path?: string | undefined; note: string }): boolean {
  if (a.path && b.path) return a.path === b.path;
  const left = words(a.note), right = words(b.note);
  if (left.size === 0 || right.size === 0) return false;
  const shared = [...left].filter(word => right.has(word)).length;
  return shared / (left.size + right.size - shared) >= 0.4;
}

export function createScorecard(context: Context, options: ScorecardOptions = {}) {
  const db = context.storage.db;
  const openWeight = options.openWeight ?? ((_model, providerKind) => providerKind === 'local');
  const modelFamily = options.modelFamily ?? (model => model);

  async function compute(projectId: string, period: { from?: number; to?: number } = {}): Promise<Scorecard> {
    const to = period.to ?? context.now();
    const from = period.from ?? to - 30 * DAY;

    const tasks = await db.selectFrom('tasks').select(['id', 'state', 'blocked_reason', 'created_at', 'updated_at', 'brief', 'tag']).where('project_id', '=', projectId).execute();
    const taskIds = tasks.map(task => task.id);
    const turns = await db.selectFrom('turns')
      .select(['id', 'task_id', 'kind', 'state', 'started_at', 'finished_at', 'tokens_in', 'tokens_out', 'model', 'provider_id'])
      .where('project_id', '=', projectId).where('started_at', '>=', from).where('started_at', '<=', to).orderBy('started_at').execute();
    const done = tasks.filter(task => task.state === 'done' && Number(task.updated_at) >= from && Number(task.updated_at) <= to);
    const doneIds = new Set(done.map(task => task.id));

    // --- Who acted by hand, per task.
    const handEvents = taskIds.length === 0 ? [] : await db.selectFrom('events').select(['task_id', 'type'])
      .where('project_id', '=', projectId).where('actor_kind', '=', 'user').where('type', 'in', HAND_EVENTS).where('task_id', 'is not', null).execute();
    const quarantines = await db.selectFrom('quarantines').select(['scope', 'ref_id', 'turn_id', 'opened_at', 'released_by', 'released_at']).execute();
    const projectTurnIds = new Set((await db.selectFrom('turns').select('id').where('project_id', '=', projectId).execute()).map(turn => turn.id));
    const ours = quarantines.filter(row => (row.scope === 'task' && taskIds.includes(row.ref_id)) || (row.turn_id !== null && projectTurnIds.has(row.turn_id)));
    const decisions = await db.selectFrom('decisions').leftJoin('deliberations', 'deliberations.id', 'decisions.deliberation_id')
      .select(['decisions.id', 'decisions.needs_human', 'decisions.resolved_by_user', 'decisions.resolved_at', 'deliberations.task_id'])
      .where('decisions.project_id', '=', projectId).execute();

    const acted = new Map<string, number>();
    const count = (taskId: string | null) => { if (taskId) acted.set(taskId, (acted.get(taskId) ?? 0) + 1); };
    for (const event of handEvents) count(event.task_id);
    for (const row of ours) if (row.scope === 'task' && row.released_by) count(row.ref_id);
    for (const decision of decisions) if (decision.resolved_by_user) count(decision.task_id);

    const handsOff = done.filter(task => !acted.has(task.id)).length;
    const actionsOnDone = done.reduce((sum, task) => sum + (acted.get(task.id) ?? 0), 0);

    // --- Tasks nobody is on: open, not held, untouched for a while, nothing queued or running, no person or decision awaited.
    const live = new Set((await db.selectFrom('work_items').select('task_id').where('project_id', '=', projectId).where('state', 'in', ['queued', 'leased']).execute()).map(item => item.task_id));
    const awaited = new Set(decisions.filter(decision => decision.needs_human && decision.resolved_at === null).map(decision => decision.task_id));
    const quarantined = new Set(ours.filter(row => row.scope === 'task' && row.released_at === null).map(row => row.ref_id));
    const waiting = tasks.filter(task => (OPEN_STATES as readonly string[]).includes(task.state) && !live.has(task.id));
    const explained = (task: typeof tasks[number]) => task.blocked_reason !== null || awaited.has(task.id) || quarantined.has(task.id);
    const unattended = waiting.filter(task => !explained(task) && Number(task.updated_at) < to - UNATTENDED_MS);

    // --- Time.
    const leadTimes = done.map(task => Number(task.updated_at) - Number(task.created_at));
    const byTask = new Map<string, typeof turns>();
    for (const turn of turns) if (turn.task_id) byTask.set(turn.task_id, [...(byTask.get(turn.task_id) ?? []), turn]);
    const workingShares: number[] = [];
    for (const task of done) {
      const lead = Number(task.updated_at) - Number(task.created_at);
      const worked = (byTask.get(task.id) ?? []).reduce((sum, turn) => sum + (turn.finished_at === null ? 0 : Number(turn.finished_at) - Number(turn.started_at)), 0);
      if (lead > 0) workingShares.push(Math.min(1, worked / lead));
    }
    // The gap between one work turn of a task and the next, when no other turn of that task (a review, a decision) came between.
    const gaps: number[] = [];
    for (const list of byTask.values()) {
      for (let index = 1; index < list.length; index++) {
        const before = list[index - 1]!, after = list[index]!;
        if (before.kind === 'work' && after.kind === 'work' && before.state === 'completed' && before.finished_at !== null) gaps.push(Number(after.started_at) - Number(before.finished_at));
      }
    }

    // --- Cost and models.
    const costs = await db.selectFrom('cost_entries').leftJoin('turns', 'turns.id', 'cost_entries.turn_id').leftJoin('providers', 'providers.id', 'cost_entries.provider_id')
      .select(['cost_entries.usd_minor', 'cost_entries.tokens_in', 'cost_entries.tokens_out', 'turns.task_id', 'turns.model', 'providers.kind as provider_kind'])
      .where('cost_entries.project_id', '=', projectId).where('cost_entries.at', '>=', from).where('cost_entries.at', '<=', to).execute();
    const spentOnDone = costs.filter(row => row.task_id && doneIds.has(row.task_id)).reduce((sum, row) => sum + Number(row.usd_minor ?? 0), 0);
    const tokens = (row: typeof costs[number]) => Number(row.tokens_in ?? 0) + Number(row.tokens_out ?? 0);
    const allTokens = costs.reduce((sum, row) => sum + tokens(row), 0);
    const openTokens = costs.filter(row => openWeight(row.model, row.provider_kind)).reduce((sum, row) => sum + tokens(row), 0);

    // --- Reviews.
    const approvals = taskIds.length === 0 ? [] : await db.selectFrom('approvals').select(['task_id', 'agent_id', 'turn_id', 'findings', 'verdict', 'head_sha', 'state', 'created_at'])
      .where('task_id', 'in', taskIds).where('created_at', '>=', from).where('created_at', '<=', to).execute();
    const reviewed = new Set(approvals.map(row => row.task_id));
    const sentBack = new Set(approvals.filter(row => row.verdict !== 'pass').map(row => row.task_id));

    // --- How different the checkers are: what only one seat found, and whether they ran on different model families.
    const reviewTurns = new Map((approvals.length === 0 ? [] : await db.selectFrom('turns').select(['id', 'model']).where('id', 'in', approvals.map(row => row.turn_id)).execute()).map(row => [row.id, row.model]));
    let findingsTotal = 0, findingsAlone = 0, checkedByTwo = 0, acrossFamilies = 0;
    for (const taskId of reviewed) {
      const bySeat = new Map<string, { path?: string; note: string }[]>();
      const families = new Set<string>();
      for (const row of approvals.filter(entry => entry.task_id === taskId)) {
        bySeat.set(row.agent_id, [...(bySeat.get(row.agent_id) ?? []), ...(JSON.parse(row.findings || '[]') as { path?: string; note: string }[])]);
        const family = modelFamily(reviewTurns.get(row.turn_id) ?? null);
        if (family) families.add(family);
      }
      if (bySeat.size < 2) continue;
      checkedByTwo++;
      if (families.size >= 2) acrossFamilies++;
      for (const [seat, found] of bySeat) {
        const others = [...bySeat].filter(([other]) => other !== seat).flatMap(([, list]) => list);
        for (const finding of found) {
          findingsTotal++;
          if (!others.some(other => sameFinding(finding, other))) findingsAlone++;
        }
      }
    }

    // --- Delivery.
    const firstWork = new Map<string, number>();
    for (const turn of turns) if (turn.kind === 'work' && turn.task_id && !firstWork.has(turn.task_id)) firstWork.set(turn.task_id, Number(turn.started_at));
    const state = new Map(tasks.map(task => [task.id, task]));
    const started = [...firstWork].filter(([taskId, at]) => state.get(taskId)?.state === 'done' || at < to - 7 * DAY);
    const finishedInAWeek = started.filter(([taskId, at]) => { const task = state.get(taskId); return task?.state === 'done' && Number(task.updated_at) - at <= 7 * DAY; }).length;
    const followUps = doneIds.size === 0 ? [] : await db.selectFrom('links').select(['to_id', 'created_at']).where('to_type', '=', 'task').where('from_type', '=', 'issue').where('to_id', 'in', [...doneIds]).execute();
    const cameBack = new Set(followUps.filter(link => { const task = state.get(link.to_id)!; const after = Number(link.created_at) - Number(task.updated_at); return after > 0 && after <= 14 * DAY; }).map(link => link.to_id));

    // --- Traces.
    const finished = turns.filter(turn => turn.finished_at !== null && !DETERMINISTIC.has(turn.kind));
    const traced = finished.length === 0 ? new Set<string>() : new Set((await db.selectFrom('trace_steps').select('turn_id').distinct().where('turn_id', 'in', finished.map(turn => turn.id)).execute()).map(row => row.turn_id));

    // --- Safety.
    const merged = await db.selectFrom('merge_queue').select(['task_id', 'head_sha']).where('project_id', '=', projectId).where('state', '=', 'merged').where('finished_at', '>=', from).where('finished_at', '<=', to).execute();
    const passes = new Set(approvals.filter(row => row.verdict === 'pass' && row.state === 'valid').map(row => `${row.task_id} ${row.head_sha}`));
    const allPasses = merged.length === 0 ? passes : new Set((await db.selectFrom('approvals').select(['task_id', 'head_sha']).where('task_id', 'in', merged.map(row => row.task_id)).where('verdict', '=', 'pass').where('state', '=', 'valid').execute()).map(row => `${row.task_id} ${row.head_sha}`));
    const unapproved = merged.filter(row => !allPasses.has(`${row.task_id} ${row.head_sha}`)).length;
    const opened = ours.filter(row => Number(row.opened_at) >= from && Number(row.opened_at) <= to);
    const releaseTimes = opened.filter(row => row.released_by && row.released_at !== null).map(row => Number(row.released_at) - Number(row.opened_at));
    const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10);
    const daily = await db.selectFrom('cost_daily').select(['agent_id', 'amount_minor']).where('project_id', '=', projectId).where('day', '>=', dayOf(from)).where('day', '<=', dayOf(to)).execute();
    const caps = await db.selectFrom('agents').select(['id', 'daily_cap_minor']).where('daily_cap_minor', 'is not', null).execute();
    const capOf = new Map(caps.map(row => [row.id, Number(row.daily_cap_minor)]));
    const overCap = daily.filter(row => row.agent_id && capOf.has(row.agent_id) && Number(row.amount_minor) > capOf.get(row.agent_id)!).length;

    // The rules are about the whole coordinator, not one project: a breach anywhere is shown on every scorecard.
    const broken = await checkInvariants(context);

    // --- Who decides: advice the owner settled itself, against decisions that went to the PM.
    const asked = await db.selectFrom('deliberations').select(['kind']).where('project_id', '=', projectId).where('created_at', '>=', from).where('created_at', '<=', to).where('kind', 'in', ['advice', 'design']).execute();
    const advised = asked.filter(row => row.kind === 'advice').length;

    // --- What a person's time goes to, and how much of the work is the team's own.
    // The team's ideas carry their mark in the task's brief; a standing duty's tasks carry its tag. Both are work nobody had to ask for.
    const isIdea = (task: (typeof tasks)[number]) => task.brief.includes('Agent-Team idea:');
    const ideas = tasks.filter(task => isIdea(task) && Number(task.created_at) <= to);
    const ideasTaken = ideas.filter(task => !['backlog', 'canceled'].includes(task.state)).length;
    const ideasDeclined = ideas.filter(task => task.state === 'canceled').length;
    const ownWork = done.filter(task => isIdea(task) || task.tag === 'duty').length;
    const said = await db.selectFrom('events').select(eb => eb.fn.countAll<number>().as('n')).where('project_id', '=', projectId).where('actor_kind', '=', 'user').where('type', '=', 'message.posted').where('at', '>=', from).where('at', '<=', to).executeTakeFirstOrThrow();
    const repairs = (await db.selectFrom('events').select(eb => eb.fn.countAll<number>().as('n')).where('project_id', '=', projectId).where('actor_kind', '=', 'user').where('type', 'in', [...HAND_EVENTS, 'quarantine.released']).where('at', '>=', from).where('at', '<=', to).executeTakeFirstOrThrow()).n;
    const chosen = Number(said.n) + ideasTaken + ideasDeclined;

    // --- The team changing how it works: trials started in the period, and how those judged in it ended.
    const trialRows = await db.selectFrom('trials').select(['state', 'started_at', 'ends_at', 'judged_at']).where('project_id', '=', projectId).execute();
    const trialsStarted = trialRows.filter(row => Number(row.started_at) >= from && Number(row.started_at) <= to);
    const trialsJudged = trialRows.filter(row => row.judged_at !== null && Number(row.judged_at) >= from && Number(row.judged_at) <= to);
    const overdue = trialRows.filter(row => row.state === 'running' && Number(row.ends_at) < to - 3600_000).length;
    const perMonth = trialsStarted.length / Math.max(1, (to - from) / (30 * DAY));

    // --- The decision model: what it read, what that cost, and how often the PM chose otherwise when it was sure.
    const reads = await db.selectFrom('machine_decisions').select(['confidence', 'answers', 'usd_micro', 'judged_at', 'overturned_at']).where('project_id', '=', projectId).where('created_at', '>=', from).where('created_at', '<=', to).execute();
    const wasSure = (row: typeof reads[number]) => { const answers = JSON.parse(row.answers) as Record<string, Answer>; return [answers.kind, answers.seat].some(answer => answer !== undefined && confidenceOf(answer) >= SURE); };
    const judgedSure = reads.filter(row => row.judged_at !== null && wasSure(row)).length, overturned = reads.filter(row => row.overturned_at !== null).length;
    const readsUsd = reads.reduce((sum, row) => sum + row.usd_micro, 0) / 1_000_000;

    const figures: Figure[] = [
      figure({ id: 'T1', group: 'team-vs-one', measure: 'Quality against one frontier model alone', value: null, unit: 'ratio', sample: 0, target: '1.0 or more', note: 'Comes from scored reference-task runs: agent-team reference' }),
      figure({ id: 'T2', group: 'team-vs-one', measure: 'Cost against one frontier model alone', value: null, unit: 'ratio', sample: 0, target: '0.3 or less', note: 'Comes from scored reference-task runs: agent-team reference' }),
      figure({ id: 'T3', group: 'team-vs-one', measure: 'Share of tokens on open-weight models', value: share(openTokens, allTokens), unit: 'share', sample: allTokens, target: '80 % or more', meets: value => value >= 0.8 }),
      figure({ id: 'T4', group: 'team-vs-one', measure: 'Seeded defects caught before done', value: null, unit: 'share', sample: 0, target: '80 % or more', note: 'Comes from scored reference-task runs: agent-team reference' }),
      figure({ id: 'T5', group: 'team-vs-one', measure: 'Findings only one seat raised, on work two seats checked', value: share(findingsAlone, findingsTotal), unit: 'share', sample: findingsTotal, target: '60 % or more', meets: value => value >= 0.6 }),
      figure({ id: 'T7', group: 'team-vs-one', measure: 'Work checked by seats on different model families', value: share(acrossFamilies, checkedByTwo), unit: 'share', sample: checkedByTwo, target: '100 %', meets: value => value === 1 }),
      figure({ id: 'I1', group: 'self-improving', measure: 'Changes the team made to how it works, per month', value: trialRows.length === 0 ? null : perMonth, unit: 'count', sample: trialsStarted.length, target: '2 a month or more', meets: value => value >= 2 }),
      figure({ id: 'I2', group: 'self-improving', measure: 'Of those judged, the changes that worked and were kept', value: share(trialsJudged.filter(row => row.state === 'kept').length, trialsJudged.length), unit: 'share', sample: trialsJudged.length, target: '50 % or more, none left unjudged', meets: value => value >= 0.5 && overdue === 0, ...(overdue ? { note: `${overdue} trial${overdue === 1 ? ' is' : 's are'} past the end and not judged` } : {}) }),
      figure({ id: 'A1', group: 'autonomy', measure: 'Tasks finished with nobody acting', value: share(handsOff, done.length), unit: 'share', sample: done.length, target: '60 % or more', meets: value => value >= 0.6 }),
      figure({ id: 'A2', group: 'autonomy', measure: 'Times a person acted, per finished task', value: done.length === 0 ? null : actionsOnDone / done.length, unit: 'count', sample: done.length, target: '0.3 or fewer', meets: value => value <= 0.3 }),
      figure({ id: 'A3', group: 'autonomy', measure: 'Unattended tasks right now', value: unattended.length, unit: 'count', sample: waiting.length, target: 'none', meets: value => value === 0 }),
      figure({ id: 'A4', group: 'autonomy', measure: 'What a person did that was ideas and dialogue, not repairs', value: share(chosen, chosen + Number(repairs)), unit: 'share', sample: chosen + Number(repairs), target: '90 % or more', meets: value => value >= 0.9 }),
      figure({ id: 'A5', group: 'autonomy', measure: 'Finished work the team thought of itself (its ideas and its standing duties)', value: share(ownWork, done.length), unit: 'share', sample: done.length, target: '50 % or more', meets: value => value >= 0.5 }),
      figure({ id: 'A6', group: 'autonomy', measure: 'Ideas the owner took up, of those decided', value: share(ideasTaken, ideasTaken + ideasDeclined), unit: 'share', sample: ideasTaken + ideasDeclined, target: '50 % or more', meets: value => value >= 0.5 }),
      figure({ id: 'A7', group: 'autonomy', measure: 'Questions the owner of the work settled itself, with advice', value: share(advised, asked.length), unit: 'share', sample: asked.length, target: 'shown, not judged' }),
      figure({ id: 'P1', group: 'performance', measure: 'Time from created to done, median', value: median(leadTimes), unit: 'ms', sample: leadTimes.length, target: 'half the baseline', note: `90th percentile: ${percentile(leadTimes, 90) ?? 'none'} ms` }),
      figure({ id: 'P2', group: 'performance', measure: 'Share of that time someone was working', value: median(workingShares), unit: 'share', sample: workingShares.length, target: '50 % or more', meets: value => value >= 0.5 }),
      figure({ id: 'P3', group: 'performance', measure: 'Gap between one work turn of a task and the next, median', value: median(gaps), unit: 'ms', sample: gaps.length, target: 'under 30 seconds', meets: value => value < 30_000, note: `90th percentile: ${percentile(gaps, 90) ?? 'none'} ms` }),
      figure({ id: 'P4', group: 'performance', measure: 'Cost of a finished task', value: done.length === 0 ? null : spentOnDone / 100 / done.length, unit: 'usd', sample: done.length, target: 'set after the baseline' }),
      figure({ id: 'P5', group: 'performance', measure: 'Accepted at first review', value: share(reviewed.size - sentBack.size, reviewed.size), unit: 'share', sample: reviewed.size, target: '70 % or more', meets: value => value >= 0.7 }),
      figure({ id: 'D1', group: 'delivery', measure: 'Started work finished within 7 days', value: share(finishedInAWeek, started.length), unit: 'share', sample: started.length, target: '85 % or more', meets: value => value >= 0.85 }),
      figure({ id: 'D2', group: 'delivery', measure: 'Finished work that came back within 14 days', value: share(cameBack.size, done.length), unit: 'share', sample: done.length, target: '10 % or fewer', meets: value => value <= 0.1 }),
      figure({ id: 'O1', group: 'observability', measure: 'Waiting tasks that say why', value: share(waiting.filter(explained).length, waiting.length), unit: 'share', sample: waiting.length, target: '100 %', meets: value => value === 1 }),
      figure({ id: 'O2', group: 'observability', measure: 'Turns that can be read afterwards', value: share(finished.filter(turn => traced.has(turn.id)).length, finished.length), unit: 'share', sample: finished.length, target: '100 %', meets: value => value === 1 }),
      figure({ id: 'S1', group: 'safety', measure: 'Safety rules broken, read back from the data', value: broken.length, unit: 'count', sample: projectTurnIds.size, target: '0', meets: value => value === 0, ...(broken.length ? { note: broken.slice(0, 3).map(item => `${item.rule}: ${item.detail}`).join('; ') } : {}) }),
      figure({ id: 'S2', group: 'safety', measure: 'Merges without recorded approval at that revision', value: unapproved, unit: 'count', sample: merged.length, target: '0', meets: value => value === 0 }),
      figure({ id: 'S3', group: 'safety', measure: 'Quarantines per 100 turns', value: turns.length === 0 ? null : (opened.length / turns.length) * 100, unit: 'per100', sample: turns.length, target: 'under 1', meets: value => value < 1, note: `Median time until a person released one: ${median(releaseTimes) ?? 'none'} ms` }),
      figure({ id: 'S4', group: 'safety', measure: 'Days an agent spent past its cap', value: overCap, unit: 'count', sample: daily.length, target: '0', meets: value => value === 0 }),
      figure({ id: 'C1', group: 'decisions', measure: 'Sure reads of the decision model that the PM overturned', value: share(overturned, judgedSure), unit: 'share', sample: judgedSure, target: '10 % or fewer', meets: value => value <= 0.1 }),
      figure({ id: 'C2', group: 'decisions', measure: 'Cost of a thousand reads of the decision model', value: reads.length === 0 ? null : (readsUsd / reads.length) * 1000, unit: 'usd', sample: reads.length, target: 'shown, not judged', note: `${reads.length} read${reads.length === 1 ? '' : 's'}, $${readsUsd.toFixed(4)} in all${done.length ? `, ${(reads.length / done.length).toFixed(1)} per finished task` : ''}` }),
      figure({ id: 'C3', group: 'decisions', measure: 'Reads the decision model was unsure of', value: share(reads.filter(row => row.confidence < UNSURE).length, reads.length), unit: 'share', sample: reads.length, target: 'shown, not judged' }),
    ];
    return { projectId, from, to, computedAt: context.now(), figures };
  }

  return { compute };
}

const UNITS: Record<Unit, (value: number) => string> = {
  share: value => `${Math.round(value * 100)} %`,
  count: value => (Number.isInteger(value) ? String(value) : value.toFixed(2)),
  ratio: value => value.toFixed(2),
  per100: value => value.toFixed(1),
  usd: value => `$${value.toFixed(2)}`,
  ms: value => (value >= 3600_000 ? `${(value / 3600_000).toFixed(1)} h` : value >= MINUTE ? `${(value / MINUTE).toFixed(1)} min` : `${Math.round(value / 1000)} s`),
};

export const formatFigure = (item: Pick<Figure, 'value' | 'unit'>) => (item.value === null ? 'not measured' : UNITS[item.unit](item.value));
