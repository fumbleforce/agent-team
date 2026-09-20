import { newId } from '@agent-team/protocol';
import type { EventDraft } from '@agent-team/protocol';
import type { Tx } from '@agent-team/storage';

// The team a project works with: its own, or its parent's.
export async function teamIdOf(tx: Tx, projectId: string): Promise<string | null> {
  const project = await tx.selectFrom('projects').select(['team_id', 'parent_id']).where('id', '=', projectId).executeTakeFirst();
  return project?.team_id ?? (project?.parent_id ? (await tx.selectFrom('projects').select('team_id').where('id', '=', project.parent_id).executeTakeFirst())?.team_id ?? null : null);
}

// An accepted issue becomes work: one task for its owner, linked to the issue. Accepting twice keeps the first task.
// Used by the PM's triage and by a person who makes the call themselves; returns the new task and the events that tell of it.
export async function taskFromIssue(tx: Tx, input: { issue: { id: string; number: number; title: string; body: string; project_id: string }; ownerId: string; authorAgentId: string | null; actor: Pick<EventDraft, 'actorKind' | 'agentId' | 'userId' | 'turnId'>; now: number }): Promise<{ taskId: string | null; events: EventDraft[] }> {
  const { issue, ownerId, now } = input;
  const linked = await tx.selectFrom('links').select('to_id').where('from_type', '=', 'issue').where('from_id', '=', issue.id).where('to_type', '=', 'task').where('rel', '=', 'fixes').executeTakeFirst();
  if (linked) return { taskId: null, events: [] };
  const taskId = newId(now);
  const lowest = await tx.selectFrom('tasks').select(eb => eb.fn.max('priority').as('n')).where('project_id', '=', issue.project_id).executeTakeFirst();
  await tx.insertInto('tasks').values({ id: taskId, project_id: issue.project_id, key: `ISSUE-${issue.number}`, source: 'internal', title: issue.title, brief: issue.body, tag: null, priority: Number(lowest?.n ?? -1) + 1, milestone_id: null, state: 'assigned', assignee_agent_id: ownerId, author_agent_id: input.authorAgentId, branch: null, head_sha: null, pr_url: null, blocked_reason: null, created_at: now, updated_at: now }).execute();
  await tx.insertInto('links').values({ from_type: 'issue', from_id: issue.id, to_type: 'task', to_id: taskId, rel: 'fixes', created_at: now }).execute();
  return { taskId, events: [
    { ...input.actor, type: 'task.assigned', agentId: ownerId, projectId: issue.project_id, taskId, payload: { fromIssue: issue.id } },
    { ...input.actor, type: 'link.added', projectId: issue.project_id, payload: { from: { type: 'issue', id: issue.id }, to: { type: 'task', id: taskId }, rel: 'fixes' } },
  ] };
}
