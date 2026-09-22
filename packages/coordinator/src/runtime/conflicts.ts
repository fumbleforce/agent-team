import { newId, type EventDraft, type TaskState } from '@agent-team/protocol';
import type { Tx } from '@agent-team/storage';
import { moveTask } from './taskMoves.ts';

const UPDATE_BRANCH = (approved: boolean) => `${approved ? 'This change was approved, but it' : 'This change'} no longer merges into the base branch: the base moved on since you started. Bring your branch up to date: fetch the base branch from origin and MERGE it into your branch (do not rebase and do not rewrite history: your branch is published and is never force-pushed). Resolve every conflict by reading both sides, run the tests, commit, and report ready_for_review; it will be reviewed again at the new revision. First check whether the base already contains what this task was for: if it does, change nothing and report not_needed with one line saying where it was done.`;

// A change that no longer merges into the base is its author's to put right, not a person's: the task goes back to its owner
// with the instruction to merge the base in, and its owner is started on it. Once per revision: when the same revision is found
// colliding again, the author was already told, nothing is sent, and whoever finds it next (the merge gate) asks a person.
// Returns who to start, or null when nothing was sent.
export async function sendBackToMerge(tx: Tx, taskId: string, input: { now: number; approved: boolean; /* Only a task in one of these states is sent back. */ from?: readonly TaskState[]; actor: Pick<EventDraft, 'actorKind' | 'agentId' | 'turnId'>; drafts: EventDraft[] }): Promise<{ agentId: string; projectId: string; taskId: string } | null> {
  const task = await tx.selectFrom('tasks').select(['project_id', 'assignee_agent_id', 'head_sha', 'state']).where('id', '=', taskId).executeTakeFirst();
  if (!task?.assignee_agent_id || !task.head_sha || (input.from && !input.from.includes(task.state as TaskState))) return null;
  const told = await tx.selectFrom('messages').innerJoin('threads', 'threads.id', 'messages.thread_id').select('messages.id').where('threads.subject_type', '=', 'task').where('threads.subject_id', '=', taskId).where('messages.kind', '=', 'system').where('messages.payload', 'like', `%${task.head_sha}%`).executeTakeFirst();
  if (told) return null;
  let thread = await tx.selectFrom('threads').select('id').where('subject_type', '=', 'task').where('subject_id', '=', taskId).executeTakeFirst();
  if (!thread) { thread = { id: newId(input.now) }; await tx.insertInto('threads').values({ id: thread.id, project_id: task.project_id, kind: 'issue', subject_type: 'task', subject_id: taskId, title: 'Task thread', visibility: 'team', owner_user_id: null, created_at: input.now }).execute(); }
  await tx.insertInto('messages').values({ id: newId(input.now), thread_id: thread.id, author_kind: 'system', author_id: null, kind: 'system', body: UPDATE_BRANCH(input.approved), payload: JSON.stringify({ unmergeableAt: task.head_sha }), created_at: input.now }).execute();
  input.drafts.push(...await moveTask(tx, taskId, 'in_progress', { set: { blocked_reason: null }, now: input.now, actor: input.actor, payload: { reason: 'conflicts-with-base', headSha: task.head_sha } }));
  return { agentId: task.assignee_agent_id, projectId: task.project_id, taskId };
}
