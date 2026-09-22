import { newId } from '@agent-team/protocol';
import type { Context } from '../context.ts';
import { HttpError } from '../context.ts';
import { newTask } from '../repos/issueTasks.ts';
import type { Turns } from './turns.ts';

// Standing duties: what a seat owns without being asked. When a duty comes round it opens a task for its owner and starts them on
// it. A duty whose last task is still open waits: the point is that someone is on it, not that tasks pile up.
const HOUR = 3600_000;
const OPEN = ['inbox', 'backlog', 'assigned', 'in_progress', 'awaiting_decision', 'in_review', 'approved', 'merging', 'blocked', 'quarantined'];
const refuse = (message: string) => new HttpError(409, 'duty', message);

export function createDuties(context: Context, turns: Turns) {
  const { storage, events, now } = context;
  const db = storage.db;

  return {
    // Sets, changes or (with everyHours 0) ends the duty of that title in the project.
    async set(projectId: string, input: { title: string; brief: string; ownerAgentId: string; everyHours: number; result: 'change' | 'document' }) {
      const project = await db.selectFrom('projects').select(['team_id', 'parent_id']).where('id', '=', projectId).executeTakeFirstOrThrow();
      const teamId = project.team_id ?? (project.parent_id ? (await db.selectFrom('projects').select('team_id').where('id', '=', project.parent_id).executeTakeFirst())?.team_id : null);
      const owner = await db.selectFrom('agents').select(['id', 'team_id', 'status']).where('id', '=', input.ownerAgentId).executeTakeFirst();
      if (!owner || owner.team_id !== teamId || owner.status === 'retired') throw refuse('That agent is not a seat of this team');
      const existing = await db.selectFrom('duties').select('id').where('project_id', '=', projectId).where('title', '=', input.title).executeTakeFirst();
      if (input.everyHours === 0) {
        if (existing) await db.updateTable('duties').set({ active: false }).where('id', '=', existing.id).execute();
        return { dutyId: existing?.id ?? null, state: 'ended' };
      }
      const values = { agent_id: owner.id, brief: input.brief, result_kind: input.result, every_ms: input.everyHours * HOUR, active: true };
      if (existing) {
        await db.updateTable('duties').set(values).where('id', '=', existing.id).execute();
        return { dutyId: existing.id, state: 'changed' };
      }
      const id = newId(now());
      // The first round is due at once, so a new duty shows what it does before anyone forgets why it was set.
      await db.insertInto('duties').values({ id, project_id: projectId, title: input.title, ...values, next_at: now(), last_task_id: null, created_at: now() }).execute();
      return { dutyId: id, state: 'set' };
    },

    list: (projectId: string) => db.selectFrom('duties').innerJoin('agents', 'agents.id', 'duties.agent_id').select(['duties.id', 'duties.title', 'duties.brief', 'duties.every_ms', 'duties.next_at', 'duties.active', 'duties.result_kind', 'agents.name as owner']).where('duties.project_id', '=', projectId).orderBy('duties.title').execute(),

    // Opens the task of every duty that has come round.
    async sweep(): Promise<number> {
      const due = await db.selectFrom('duties').innerJoin('agents', 'agents.id', 'duties.agent_id').select(['duties.id', 'duties.project_id', 'duties.agent_id', 'duties.title', 'duties.brief', 'duties.result_kind', 'duties.every_ms', 'duties.last_task_id', 'agents.status'])
        .where('duties.active', '=', true).where('duties.next_at', '<=', now()).execute();
      let opened = 0;
      for (const duty of due) {
        const last = duty.last_task_id ? await db.selectFrom('tasks').select('state').where('id', '=', duty.last_task_id).executeTakeFirst() : null;
        // Its owner is away or still on the last round: look again next time, without losing the rhythm.
        if (duty.status !== 'active' || (last && OPEN.includes(last.state))) continue;
        const day = new Date(now()).toISOString().slice(0, 10);
        const result = await storage.transaction(async tx => {
          const made = await newTask(tx, { projectId: duty.project_id, title: `${duty.title} (${day})`, brief: duty.brief, tag: 'duty', resultKind: duty.result_kind === 'change' ? 'change' : 'document', ownerId: duty.agent_id, authorAgentId: duty.agent_id, actor: { actorKind: 'system' }, now: now() });
          await tx.updateTable('duties').set({ last_task_id: made.taskId, next_at: now() + Number(duty.every_ms) }).where('id', '=', duty.id).execute();
          return { taskId: made.taskId, published: await events.append(tx, [...made.events, { type: 'duty.came_round', actorKind: 'system', projectId: duty.project_id, agentId: duty.agent_id, taskId: made.taskId, payload: { dutyId: duty.id, title: duty.title } }]) };
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
