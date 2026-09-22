import { DELIVERABLE_KINDS, deliverableWords, missingFields, newId, type DeliverableKind, type DeliverableSubmission, type EventDraft } from '@agent-team/protocol';
import type { Tx } from '@agent-team/storage';
import { HttpError, type Context } from '../context.ts';
import { newTask } from '../repos/issueTasks.ts';
import { reviewersFor } from './documents.ts';
import { moveTask } from './taskMoves.ts';
import type { Turns } from './turns.ts';

// A round of a duty that asks for deliverables is one task. Its owner hands each deliverable in as it is ready, then hands the round
// in; one teammate judges every deliverable in one review turn. The round is done when as many as it asks for are approved; short of
// that it goes back to its owner with what was rejected and why. What an approved deliverable becomes is decided here, once: a card
// is put on the board, a message waits as a handoff for a person to send. Nothing leaves the platform by itself.
export const DELIVERABLES = 'deliverables';
const refuse = (message: string) => new HttpError(409, 'deliverable', message);
const DAY_MS = 24 * 3600_000;
type Turn = { id: string; agent_id: string; project_id: string; task_id: string | null };

// What a round asks for: the duty's target, or one for a task made by hand.
async function roundOf(tx: Pick<Tx, 'selectFrom'>, taskId: string) {
  const duty = await tx.selectFrom('duties').select(['id', 'target', 'deliverable_kind']).where('last_task_id', '=', taskId).executeTakeFirst();
  return { dutyId: duty?.id ?? null, target: Number(duty?.target ?? 1), kind: (duty?.deliverable_kind ?? null) as DeliverableKind | null };
}

async function counts(tx: Pick<Tx, 'selectFrom'>, taskId: string) {
  const rows = await tx.selectFrom('deliverables').select('state').where('task_id', '=', taskId).execute();
  return { submitted: rows.filter(row => row.state === 'submitted').length, approved: rows.filter(row => row.state === 'approved').length, rejected: rows.filter(row => row.state === 'rejected').length };
}

// Whether the owner of a round may hand it in: something waits to be judged, or it already has what it asks for.
export async function mayHandIn(tx: Pick<Tx, 'selectFrom'>, taskId: string): Promise<boolean> {
  const count = await counts(tx, taskId);
  return count.submitted > 0 || count.approved >= (await roundOf(tx, taskId)).target;
}

// For a packet: where the round stands, for its owner; the deliverables to judge, for its reviewer.
export async function roundPart(tx: Tx, taskId: string, forReview: boolean): Promise<string | null> {
  const task = await tx.selectFrom('tasks').select('result_kind').where('id', '=', taskId).executeTakeFirst();
  if (task?.result_kind !== DELIVERABLES) return null;
  const round = await roundOf(tx, taskId), rows = await tx.selectFrom('deliverables').selectAll().where('task_id', '=', taskId).orderBy('created_at').execute();
  const describe = (row: (typeof rows)[number]) => {
    const fields = Object.entries(JSON.parse(row.fields) as Record<string, string>).map(([key, value]) => `${key}: ${value}`).join('; ');
    return `## ${row.title} (${deliverableWords(row.kind, 1)}, deliverableId ${row.id})\n${fields ? `${fields}\n` : ''}${row.link ? `Link: ${row.link}\n` : ''}${row.body}`;
  };
  if (forReview) {
    const waiting = rows.filter(row => row.state === 'submitted');
    return `# Deliverables to judge (${waiting.length}; the round asks for ${round.target})\n\n${waiting.map(describe).join('\n\n') || '(none)'}`;
  }
  const approved = rows.filter(row => row.state === 'approved').length, rejected = rows.filter(row => row.state === 'rejected'), waiting = rows.filter(row => row.state === 'submitted');
  return [`# This round\nIt asks for ${round.target} ${round.kind ? deliverableWords(round.kind, round.target) : 'deliverables'}. Approved so far: ${approved}. Handed in and not yet judged: ${waiting.length}.`,
    rejected.length ? `# Sent back\n${rejected.map(row => `- ${row.title}: ${row.note ?? 'no reason given'}`).join('\n')}` : '',
    waiting.length ? `# Handed in, waiting to be judged\n${waiting.map(row => `- ${row.title}`).join('\n')}` : ''].filter(Boolean).join('\n\n');
}

export const DELIVERABLES_WORK = 'The result of this task is a number of deliverables, not a change to a repository. Make each one so someone can act on it as it stands, and hand it in with deliverable.submit as soon as it is ready: the body is the thing itself, the fields are what its kind needs, the link is where it lives outside the platform. Do not hand in the same thing twice, and do not pad the count: fewer that are right beat more that are not. When you have handed in what the round asks for, call task.update with ready_for_review; a teammate judges them all. If some are sent back, make new ones in their place.';
export const DELIVERABLES_REVIEW = 'Judge the deliverables below, as their reader would: could this lead be called, this email be sent, this card be built, as it stands? Record every verdict in one deliverable.review call, one per deliverable: pass if it can go out as it is, changes if not, with a note that says what is wrong. You judge, you do not rewrite.';

export function createDeliverables(context: Context, turns: Turns) {
  const { storage, events, now } = context;
  const db = storage.db;

  // What an approved deliverable turns into, in the same transaction as the verdict.
  async function act(tx: Tx, row: { id: string; project_id: string; task_id: string; kind: string; title: string; body: string; link: string | null; fields: string; author_agent_id: string }, reviewer: string): Promise<{ ref: string | null; drafts: EventDraft[] }> {
    const fields = JSON.parse(row.fields) as Record<string, string>;
    if (row.kind === 'card') {
      const made = await newTask(tx, { projectId: row.project_id, title: row.title, brief: `${row.body}${row.link ? `\n\n${row.link}` : ''}`, ownerId: null, authorAgentId: row.author_agent_id, actor: { actorKind: 'agent', agentId: reviewer }, now: now() });
      return { ref: made.key, drafts: made.events };
    }
    if (row.kind === 'message') {
      const id = newId(now());
      await tx.insertInto('handoffs').values({ id, project_id: row.project_id, direction: 'out', source: 'message', title: fields.subject ?? row.title, summary: row.body, context: JSON.stringify({ to: fields.to ?? '', subject: fields.subject ?? row.title, ...(row.link ? { link: row.link } : {}), deliverableId: row.id }), attachment_id: null, target_task_id: row.task_id, target_type: 'task', target_id: row.task_id, state: 'outbox', picked_by_agent_id: row.author_agent_id, created_by: null, created_at: now() }).execute();
      return { ref: id, drafts: [{ type: 'handoff.sent', actorKind: 'agent', agentId: reviewer, projectId: row.project_id, taskId: row.task_id, payload: { handoffId: id, destination: 'message' } }] };
    }
    return { ref: null, drafts: [] };
  }

  // After the owner's own verdict the round's task follows its deliverables: a round in review with nothing left to judge is done when it
  // has what it asks for and goes back to its owner otherwise, and a round in hand that reached its number is done.
  async function settle(tx: Tx, taskId: string, userId: string): Promise<{ drafts: EventDraft[]; wake: { agentId: string; projectId: string } | null }> {
    const task = await tx.selectFrom('tasks').select(['state', 'assignee_agent_id', 'project_id']).where('id', '=', taskId).executeTakeFirstOrThrow();
    const count = await counts(tx, taskId), met = count.approved >= (await roundOf(tx, taskId)).target;
    const to = task.state === 'in_review' && count.submitted === 0 ? (met ? 'done' : 'in_progress') : ['assigned', 'in_progress'].includes(task.state) && met ? 'done' : null;
    if (!to) return { drafts: [], wake: null };
    if (task.state === 'in_review') await tx.updateTable('work_items').set({ state: 'canceled', defer_reason: 'task-closed' }).where('task_id', '=', taskId).where('kind', '=', 'review').where('state', '=', 'queued').execute();
    if (to === 'done') await tx.updateTable('work_items').set({ state: 'canceled', defer_reason: 'task-closed' }).where('task_id', '=', taskId).where('state', '=', 'queued').execute();
    const drafts = await moveTask(tx, taskId, to, { now: now(), actor: { actorKind: 'user', userId }, payload: { byOwner: true } });
    return { drafts, wake: to === 'in_progress' && task.assignee_agent_id ? { agentId: task.assignee_agent_id, projectId: task.project_id } : null };
  }

  return {
    async submit(turn: Turn, input: DeliverableSubmission) {
      if (!turn.task_id) throw refuse('This turn has no task');
      const missing = missingFields(input);
      if (missing.length) throw refuse(`A ${DELIVERABLE_KINDS[input.kind].one} needs ${missing.join(' and ')} in fields`);
      return storage.transaction(async tx => {
        const task = await tx.selectFrom('tasks').select(['result_kind', 'assignee_agent_id', 'state']).where('id', '=', turn.task_id!).executeTakeFirstOrThrow();
        if (task.result_kind !== DELIVERABLES) throw refuse('This task does not ask for deliverables');
        if (task.assignee_agent_id !== turn.agent_id) throw refuse('Only the owner of the task hands in its deliverables');
        if (!['assigned', 'in_progress'].includes(task.state)) throw refuse(`The task is ${task.state}; nothing more can be handed in now`);
        const round = await roundOf(tx, turn.task_id!);
        if (round.kind && round.kind !== input.kind) throw refuse(`This round asks for ${deliverableWords(round.kind, 2)}, not ${deliverableWords(input.kind, 2)}`);
        const title = input.title.normalize('NFKC').toLowerCase();
        const same = await tx.selectFrom('deliverables').select('title').where('task_id', '=', turn.task_id!).where('state', '!=', 'rejected').execute();
        if (same.some(row => row.title.normalize('NFKC').toLowerCase() === title)) throw refuse(`"${input.title}" is already handed in`);
        const id = newId(now());
        await tx.insertInto('deliverables').values({ id, project_id: turn.project_id, task_id: turn.task_id!, duty_id: round.dutyId, kind: input.kind, title: input.title, body: input.body, link: input.link ?? null, fields: JSON.stringify(input.fields), author_agent_id: turn.agent_id, state: 'submitted', reviewer_agent_id: null, note: null, outcome_ref: null, created_at: now(), decided_at: null }).execute();
        const count = await counts(tx, turn.task_id!);
        return { deliverableId: id, handedIn: count.submitted + count.approved, target: round.target };
      });
    },

    // The owner hands the round in: what was handed in since the last verdict is judged by one teammate, or counts at once on a team of one.
    async handIn(turn: Turn) {
      const result = await storage.transaction(async tx => {
        const task = await tx.selectFrom('tasks').select(['id', 'project_id', 'assignee_agent_id']).where('id', '=', turn.task_id!).executeTakeFirstOrThrow();
        const count = await counts(tx, task.id), target = (await roundOf(tx, task.id)).target;
        if (count.submitted === 0 && count.approved < target) throw refuse('Nothing is handed in yet: hand in each deliverable with deliverable.submit first');
        // With nothing new to judge (the owner judged them by hand), there is nobody to ask.
        const [reviewer] = count.submitted ? await reviewersFor(tx, task.project_id, task.assignee_agent_id, 1) : [];
        if (!reviewer) await tx.updateTable('deliverables').set({ state: 'approved', decided_at: now(), note: 'Nobody else on the team to judge it' }).where('task_id', '=', task.id).where('state', '=', 'submitted').execute();
        const done = !reviewer && count.approved + count.submitted >= target;
        const moved = await moveTask(tx, task.id, reviewer ? 'in_review' : done ? 'done' : 'in_progress', { set: { blocked_reason: null }, now: now(), actor: { actorKind: 'agent', agentId: turn.agent_id, turnId: turn.id }, payload: { deliverables: count.submitted } });
        return { reviewer, task, state: reviewer ? 'in_review' : done ? 'done' : 'in_progress', published: await events.append(tx, [...moved, ...(reviewer ? [{ type: 'review.requested', actorKind: 'agent' as const, agentId: turn.agent_id, projectId: task.project_id, taskId: task.id, turnId: turn.id, payload: { deliverables: count.submitted, reviewers: [reviewer] } }] : [])]) };
      });
      events.published(result.published);
      if (result.reviewer) await turns.enqueue({ agentId: result.reviewer, projectId: result.task.project_id, kind: 'review', taskId: result.task.id, dedupeKey: `delreview:${result.task.id}:${turn.id}` });
      return { state: result.state };
    },

    async review(turn: Turn, verdicts: { deliverableId: string; verdict: 'pass' | 'changes'; note: string }[]) {
      if (!turn.task_id) throw refuse('This turn has no task');
      const result = await storage.transaction(async tx => {
        const task = await tx.selectFrom('tasks').select(['id', 'project_id', 'assignee_agent_id', 'result_kind', 'state']).where('id', '=', turn.task_id!).executeTakeFirstOrThrow();
        if (task.result_kind !== DELIVERABLES) throw refuse('This task has no deliverables to judge');
        if (task.assignee_agent_id === turn.agent_id) throw refuse('An author does not review their own work');
        if (task.state !== 'in_review') throw refuse(`The task is ${task.state}, not in review`);
        const waiting = await tx.selectFrom('deliverables').selectAll().where('task_id', '=', task.id).where('state', '=', 'submitted').execute();
        const unknown = verdicts.filter(item => !waiting.some(row => row.id === item.deliverableId));
        if (unknown.length) throw refuse(`${unknown.map(item => item.deliverableId).join(', ')} is not waiting to be judged in this task`);
        const left = waiting.filter(row => !verdicts.some(item => item.deliverableId === row.id));
        if (left.length) throw refuse(`Judge every deliverable in one call; still without a verdict: ${left.map(row => `${row.title} (${row.id})`).join(', ')}`);
        const drafts: EventDraft[] = [];
        for (const item of verdicts) {
          const row = waiting.find(candidate => candidate.id === item.deliverableId)!;
          const outcome = item.verdict === 'pass' ? await act(tx, row, turn.agent_id) : { ref: null, drafts: [] };
          drafts.push(...outcome.drafts);
          await tx.updateTable('deliverables').set({ state: item.verdict === 'pass' ? 'approved' : 'rejected', reviewer_agent_id: turn.agent_id, note: item.note, outcome_ref: outcome.ref, decided_at: now() }).where('id', '=', row.id).execute();
        }
        const count = await counts(tx, task.id), round = await roundOf(tx, task.id);
        const state = count.approved >= round.target ? 'done' : 'in_progress';
        await tx.updateTable('turns').set({ summary: `Judged ${verdicts.length}: ${verdicts.filter(item => item.verdict === 'pass').length} approved. ${count.approved} of ${round.target} approved in this round.` }).where('id', '=', turn.id).execute();
        const moved = await moveTask(tx, task.id, state, { now: now(), actor: { actorKind: 'agent', agentId: turn.agent_id, turnId: turn.id }, payload: { approved: count.approved, target: round.target } });
        return { state, count, round, task, published: await events.append(tx, [{ type: 'review.recorded', actorKind: 'agent', agentId: turn.agent_id, projectId: task.project_id, taskId: task.id, turnId: turn.id, payload: { deliverables: verdicts.length, approved: count.approved, target: round.target } }, ...drafts, ...moved]) };
      });
      events.published(result.published);
      // Short of what the round asks for: its owner is started on it again, with what was sent back in the packet.
      if (result.state === 'in_progress' && result.task.assignee_agent_id) await turns.enqueue({ agentId: result.task.assignee_agent_id, projectId: result.task.project_id, kind: 'work', taskId: result.task.id, dedupeKey: `delchanges:${result.task.id}:${turn.id}` });
      return { approved: result.count.approved, rejected: result.count.rejected, target: result.round.target, state: result.state };
    },

    // Every duty that asks for deliverables, with how far its current round is; a change duty counts what merged since its round began.
    async progress(projectIds: string[]) {
      if (projectIds.length === 0) return [];
      const duties = await db.selectFrom('duties').innerJoin('agents', 'agents.id', 'duties.agent_id').select(['duties.id', 'duties.project_id', 'duties.title', 'duties.deliverable_kind', 'duties.target', 'duties.every_ms', 'duties.last_task_id', 'duties.round_at', 'duties.next_at', 'agents.name as owner'])
        .where('duties.project_id', 'in', projectIds).where('duties.active', '=', true).where('duties.target', 'is not', null).orderBy('duties.title').execute();
      return Promise.all(duties.map(async duty => {
        const since = Number(duty.round_at ?? Number(duty.next_at) - Number(duty.every_ms));
        const approved = duty.deliverable_kind === 'change'
          ? Number((await db.selectFrom('tasks').select(eb => eb.fn.countAll<number>().as('n')).where('project_id', '=', duty.project_id).where('result_kind', '=', 'change').where('state', '=', 'done').where('updated_at', '>=', since).executeTakeFirst())?.n ?? 0)
          : duty.last_task_id ? (await counts(db, duty.last_task_id)).approved : 0;
        const task = duty.last_task_id ? await db.selectFrom('tasks').select(['id', 'key', 'state']).where('id', '=', duty.last_task_id).executeTakeFirst() : null;
        return { dutyId: duty.id, projectId: duty.project_id, title: duty.title, owner: duty.owner, kind: duty.deliverable_kind as DeliverableKind, target: Number(duty.target), approved, since, everyHours: Number(duty.every_ms) / 3600_000, task: task ? { id: task.id, key: task.key, state: task.state } : null };
      }));
    },

    // What was handed in lately, newest first, for the team's page.
    async recent(projectId: string, days = 14) {
      const rows = await db.selectFrom('deliverables').leftJoin('agents as author', 'author.id', 'deliverables.author_agent_id').leftJoin('agents as reviewer', 'reviewer.id', 'deliverables.reviewer_agent_id').leftJoin('tasks', 'tasks.id', 'deliverables.task_id')
        .select(['deliverables.id', 'deliverables.kind', 'deliverables.title', 'deliverables.body', 'deliverables.link', 'deliverables.fields', 'deliverables.state', 'deliverables.note', 'deliverables.outcome_ref', 'deliverables.created_at', 'deliverables.decided_at', 'deliverables.duty_id', 'author.name as author', 'reviewer.name as reviewer', 'tasks.key as task_key'])
        .where('deliverables.project_id', '=', projectId).where('deliverables.created_at', '>=', now() - days * DAY_MS).orderBy('deliverables.created_at', 'desc').limit(200).execute();
      return rows.map(row => ({ id: row.id, kind: row.kind as DeliverableKind, title: row.title, body: row.body, link: row.link, fields: JSON.parse(row.fields) as Record<string, string>, state: row.state, note: row.note, outcome: row.outcome_ref, createdAt: Number(row.created_at), decidedAt: row.decided_at === null ? null : Number(row.decided_at), dutyId: row.duty_id, author: row.author, reviewer: row.reviewer, taskKey: row.task_key }));
    },

    // The owner's own verdict on something handed in, before or instead of the reviewer's.
    async decide(userId: string, projectId: string, deliverableId: string, verdict: 'pass' | 'changes', note: string | null) {
      const result = await storage.transaction(async tx => {
        const row = await tx.selectFrom('deliverables').selectAll().where('id', '=', deliverableId).where('project_id', '=', projectId).executeTakeFirst();
        if (!row) throw new HttpError(404, 'not_found', 'Deliverable not found');
        if (row.state !== 'submitted') throw refuse(`It is already ${row.state === 'approved' ? 'approved' : 'sent back'}`);
        const outcome = verdict === 'pass' ? await act(tx, row, row.author_agent_id) : { ref: null, drafts: [] };
        await tx.updateTable('deliverables').set({ state: verdict === 'pass' ? 'approved' : 'rejected', reviewer_agent_id: null, note: note ?? (verdict === 'pass' ? 'Approved by the owner' : 'Sent back by the owner'), outcome_ref: outcome.ref, decided_at: now() }).where('id', '=', row.id).execute();
        const settled = await settle(tx, row.task_id, userId);
        return { wake: settled.wake, taskId: row.task_id, published: await events.append(tx, [{ type: 'deliverable.decided', category: 'audit', actorKind: 'user', userId, projectId, taskId: row.task_id, payload: { deliverableId, verdict } }, ...outcome.drafts, ...settled.drafts]) };
      });
      events.published(result.published);
      if (result.wake) await turns.enqueue({ agentId: result.wake.agentId, projectId: result.wake.projectId, kind: 'work', taskId: result.taskId, dedupeKey: `delowner:${result.taskId}:${deliverableId}` });
    },
  };
}
export type Deliverables = ReturnType<typeof createDeliverables>;
