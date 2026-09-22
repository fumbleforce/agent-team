import { deliverableWords, newId, type DeliverableTarget, type EventDraft } from '@agent-team/protocol';
import type { Tx } from '@agent-team/storage';
import type { Context } from '../context.ts';
import { HttpError } from '../context.ts';
import { newTask } from '../repos/issueTasks.ts';
import { DELIVERABLES } from './deliverables.ts';
import { moveTask } from './taskMoves.ts';
import type { Turns } from './turns.ts';

// Standing duties: what a seat owns without being asked. When a duty comes round it opens a task for its owner and starts them on
// it. A duty whose last task is still open waits: the point is that someone is on it, not that tasks pile up. A duty that asks for a
// number of deliverables is different in two ways: its round ends when the next one comes, finished or not, and a duty that asks for
// changes opens no task of its own: the changes are the team's work on the board, counted as they merge, and the PM is told the target.
const HOUR = 3600_000;
const OPEN = ['inbox', 'backlog', 'assigned', 'in_progress', 'awaiting_decision', 'in_review', 'approved', 'merging', 'blocked', 'quarantined'];
const refuse = (message: string) => new HttpError(409, 'duty', message);
export interface DutyInput { title: string; brief: string; ownerAgentId: string; everyHours: number; result: 'change' | 'document'; deliverable?: DeliverableTarget | undefined }

// Sets, changes or (with everyHours 0) ends the duty of that title in the project, inside a larger change when one is under way.
export async function setDuty(tx: Tx, now: () => number, projectId: string, input: DutyInput) {
  const project = await tx.selectFrom('projects').select(['team_id', 'parent_id']).where('id', '=', projectId).executeTakeFirstOrThrow();
  const teamId = project.team_id ?? (project.parent_id ? (await tx.selectFrom('projects').select('team_id').where('id', '=', project.parent_id).executeTakeFirst())?.team_id : null);
  const owner = await tx.selectFrom('agents').select(['id', 'team_id', 'status']).where('id', '=', input.ownerAgentId).executeTakeFirst();
  if (!owner || owner.team_id !== teamId || owner.status === 'retired') throw refuse('That agent is not a seat of this team');
  const existing = await tx.selectFrom('duties').select('id').where('project_id', '=', projectId).where('title', '=', input.title).executeTakeFirst();
  if (input.everyHours === 0) {
    if (existing) await tx.updateTable('duties').set({ active: false }).where('id', '=', existing.id).execute();
    return { dutyId: existing?.id ?? null, state: 'ended' };
  }
  const kind = input.deliverable?.kind ?? null;
  const values = { agent_id: owner.id, brief: input.brief, result_kind: kind === null ? input.result : kind === 'change' ? 'change' : DELIVERABLES, every_ms: input.everyHours * HOUR, active: true, deliverable_kind: kind, target: input.deliverable?.target ?? null };
  if (existing) {
    await tx.updateTable('duties').set(values).where('id', '=', existing.id).execute();
    return { dutyId: existing.id, state: 'changed' };
  }
  const id = newId(now());
  // The first round is due at once, so a new duty shows what it does before anyone forgets why it was set.
  await tx.insertInto('duties').values({ id, project_id: projectId, title: input.title, ...values, next_at: now(), last_task_id: null, created_at: now() }).execute();
  return { dutyId: id, state: 'set' };
}

export function createDuties(context: Context, turns: Turns) {
  const { storage, events, now } = context;
  const db = storage.db;

  // A change duty's round: the target is said where the team reads, and the PM is woken to see there is work on the board for it.
  async function changeRound(duty: { id: string; project_id: string; title: string; brief: string; target: number | null; every_ms: number }): Promise<void> {
    const thread = await db.selectFrom('threads').select('id').where('project_id', '=', duty.project_id).where('kind', '=', 'discussion').executeTakeFirst();
    const project = await db.selectFrom('projects').select(['team_id', 'parent_id']).where('id', '=', duty.project_id).executeTakeFirstOrThrow();
    const teamId = project.team_id ?? (project.parent_id ? (await db.selectFrom('projects').select('team_id').where('id', '=', project.parent_id).executeTakeFirst())?.team_id : null);
    const pm = teamId ? await db.selectFrom('agents').select(['id', 'name']).where('team_id', '=', teamId).where('is_pm', '=', true).where('status', '=', 'active').executeTakeFirst() : null;
    const published = await storage.transaction(async tx => {
      await tx.updateTable('duties').set({ round_at: now(), next_at: now() + Number(duty.every_ms) }).where('id', '=', duty.id).execute();
      const drafts: EventDraft[] = [{ type: 'duty.came_round', actorKind: 'system', projectId: duty.project_id, payload: { dutyId: duty.id, title: duty.title } }];
      if (thread && pm) {
        const id = newId(now()), target = Number(duty.target ?? 1);
        await tx.insertInto('messages').values({ id, thread_id: thread.id, author_kind: 'system', author_id: null, kind: 'system', body: `${duty.title}: this round asks for ${target} ${deliverableWords('change', target)} merged. ${duty.brief} ${pm.name}: see there is work on the board for it and that it has owners.`, payload: JSON.stringify({ duty: duty.id }), created_at: now() }).execute();
        drafts.push({ type: 'message.posted', actorKind: 'system', projectId: duty.project_id, threadId: thread.id, payload: { messageId: id, kind: 'system' } });
      }
      return events.append(tx, drafts);
    });
    events.published(published);
    if (thread && pm) await turns.enqueue({ agentId: pm.id, projectId: duty.project_id, kind: 'triage', threadId: thread.id, dedupeKey: `duty:${duty.id}:${now()}` });
  }

  // A counted round ends when the next one comes: what was not judged by then does not count, and the task closes short.
  async function closeShort(tx: Tx, taskId: string): Promise<EventDraft[]> {
    await tx.updateTable('work_items').set({ state: 'canceled', defer_reason: 'task-closed' }).where('task_id', '=', taskId).where('state', '=', 'queued').execute();
    await tx.updateTable('deliverables').set({ state: 'rejected', note: 'The round ended before it was judged', decided_at: now() }).where('task_id', '=', taskId).where('state', '=', 'submitted').execute();
    return moveTask(tx, taskId, 'canceled', { set: { blocked_reason: 'The round ended short' }, now: now(), actor: { actorKind: 'system' }, payload: { reason: 'round-ended' } });
  }

  return {
    async set(projectId: string, input: DutyInput) {
      return storage.transaction(tx => setDuty(tx, now, projectId, input));
    },

    list: (projectId: string) => db.selectFrom('duties').innerJoin('agents', 'agents.id', 'duties.agent_id').select(['duties.id', 'duties.title', 'duties.brief', 'duties.every_ms', 'duties.next_at', 'duties.active', 'duties.result_kind', 'duties.deliverable_kind', 'duties.target', 'agents.name as owner']).where('duties.project_id', '=', projectId).orderBy('duties.title').execute(),

    // Opens the task of every duty that has come round.
    async sweep(): Promise<number> {
      const due = await db.selectFrom('duties').innerJoin('agents', 'agents.id', 'duties.agent_id').select(['duties.id', 'duties.project_id', 'duties.agent_id', 'duties.title', 'duties.brief', 'duties.result_kind', 'duties.every_ms', 'duties.last_task_id', 'duties.deliverable_kind', 'duties.target', 'agents.status'])
        .where('duties.active', '=', true).where('duties.next_at', '<=', now()).execute();
      let opened = 0;
      for (const duty of due) {
        if (duty.deliverable_kind === 'change') { await changeRound(duty); opened++; continue; }
        const counted = duty.target !== null;
        const last = duty.last_task_id ? await db.selectFrom('tasks').select('state').where('id', '=', duty.last_task_id).executeTakeFirst() : null;
        // Its owner is away, or still on the last round of a duty with no count: look again next time, without losing the rhythm.
        if (duty.status !== 'active' || (!counted && last && OPEN.includes(last.state))) continue;
        const day = new Date(now()).toISOString().slice(0, 10), target = Number(duty.target ?? 0);
        const brief = counted ? `${duty.brief}\n\nThis round asks for ${target} ${deliverableWords(duty.deliverable_kind ?? '', target)}. Hand in each with deliverable.submit, then call task.update with ready_for_review.` : duty.brief;
        const result = await storage.transaction(async tx => {
          // A counted round ends when the next one comes: what it did not finish stays short, and the new round starts clean.
          const closed = counted && duty.last_task_id && last && OPEN.includes(last.state) ? await closeShort(tx, duty.last_task_id) : [];
          const made = await newTask(tx, { projectId: duty.project_id, title: `${duty.title} (${day})`, brief, tag: 'duty', resultKind: counted ? DELIVERABLES : duty.result_kind === 'change' ? 'change' : 'document', ownerId: duty.agent_id, authorAgentId: duty.agent_id, actor: { actorKind: 'system' }, now: now() });
          await tx.updateTable('duties').set({ last_task_id: made.taskId, round_at: now(), next_at: now() + Number(duty.every_ms) }).where('id', '=', duty.id).execute();
          return { taskId: made.taskId, published: await events.append(tx, [...closed, ...made.events, { type: 'duty.came_round', actorKind: 'system', projectId: duty.project_id, agentId: duty.agent_id, taskId: made.taskId, payload: { dutyId: duty.id, title: duty.title } }]) };
        });
        events.published(result.published);
        await turns.enqueue({ agentId: duty.agent_id, projectId: duty.project_id, kind: 'work', taskId: result.taskId, dedupeKey: `work:${result.taskId}` });
        opened++;
      }
      return opened;
    },
  };
}
export type Duties = ReturnType<typeof createDuties>;
