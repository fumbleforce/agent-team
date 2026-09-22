import type { EventDraft, TaskState } from '@agent-team/protocol';
import type { Schema, Tx } from '@agent-team/storage';
import type { Updateable } from 'kysely';

type Actor = Pick<EventDraft, 'actorKind' | 'agentId' | 'userId' | 'turnId'>;
type Changes = Omit<Updateable<Schema['tasks']>, 'state' | 'updated_at'>;
interface Move { now: number; actor: Actor; /* Only a task in one of these states moves. */ from?: readonly TaskState[]; /* A task in one of these stays where it is. */ unless?: readonly TaskState[]; set?: Changes; payload?: Record<string, unknown> }

// The one way a task changes state. It returns the event that says so, with where the task came from, for the caller to append
// in the same transaction: the task's log reads from it, and so does anything that mirrors the board. A task that is already in
// that state still takes the other changes, and says nothing, since nothing moved.
export async function moveTask(tx: Tx, taskId: string, to: TaskState, move: Move): Promise<EventDraft[]> {
  let query = tx.selectFrom('tasks').select(['project_id', 'state']).where('id', '=', taskId);
  if (move.from) query = query.where('state', 'in', [...move.from]);
  if (move.unless) query = query.where('state', 'not in', [...move.unless]);
  const task = await query.executeTakeFirst();
  if (!task) return [];
  await tx.updateTable('tasks').set({ ...move.set, state: to, updated_at: move.now }).where('id', '=', taskId).execute();
  return task.state === to ? [] : [{ type: 'task.state_changed', ...move.actor, projectId: task.project_id, taskId, payload: { from: task.state, to, ...move.payload } }];
}

// Every task of a project in one state, moved to another: one event for each.
export async function moveTasksOf(tx: Tx, projectId: string, from: TaskState, to: TaskState, move: Omit<Move, 'from' | 'unless'>): Promise<EventDraft[]> {
  const ids = await tx.selectFrom('tasks').select('id').where('project_id', '=', projectId).where('state', '=', from).execute();
  const drafts: EventDraft[] = [];
  for (const { id } of ids) drafts.push(...await moveTask(tx, id, to, { ...move, from: [from] }));
  return drafts;
}
