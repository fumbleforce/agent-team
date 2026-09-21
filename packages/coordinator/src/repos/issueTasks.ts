import { newId } from '@agent-team/protocol';
import type { EventDraft } from '@agent-team/protocol';
import type { Tx } from '@agent-team/storage';

// The team a project works with: its own, or its parent's.
export async function teamIdOf(tx: Tx, projectId: string): Promise<string | null> {
  const project = await tx.selectFrom('projects').select(['team_id', 'parent_id']).where('id', '=', projectId).executeTakeFirst();
  return project?.team_id ?? (project?.parent_id ? (await tx.selectFrom('projects').select('team_id').where('id', '=', project.parent_id).executeTakeFirst())?.team_id ?? null : null);
}

// A task that starts on the platform rather than in a tracker or an issue. Its key counts up within the project.
export async function newTask(tx: Tx, input: { projectId: string; title: string; brief: string; tag?: string | null; resultKind?: 'change' | 'document'; ownerId: string | null; authorAgentId: string | null; actor: Pick<EventDraft, 'actorKind' | 'agentId' | 'userId' | 'turnId'>; now: number }): Promise<{ taskId: string; key: string; events: EventDraft[] }> {
  const taskId = newId(input.now);
  const made = await tx.selectFrom('tasks').select(eb => eb.fn.countAll<number>().as('n')).where('project_id', '=', input.projectId).where('key', 'like', 'TASK-%').executeTakeFirstOrThrow();
  const lowest = await tx.selectFrom('tasks').select(eb => eb.fn.max('priority').as('n')).where('project_id', '=', input.projectId).executeTakeFirst();
  const key = `TASK-${Number(made.n) + 1}`;
  await tx.insertInto('tasks').values({ id: taskId, project_id: input.projectId, key, source: 'internal', title: input.title, brief: input.brief, tag: input.tag ?? null, priority: Number(lowest?.n ?? -1) + 1, milestone_id: null, state: input.ownerId ? 'assigned' : 'backlog', assignee_agent_id: input.ownerId, author_agent_id: input.authorAgentId, branch: null, head_sha: null, pr_url: null, blocked_reason: null, result_kind: input.resultKind ?? 'change', created_at: input.now, updated_at: input.now }).execute();
  return { taskId, key, events: [{ ...input.actor, type: input.ownerId ? 'task.assigned' : 'task.created', ...(input.ownerId ? { agentId: input.ownerId } : {}), projectId: input.projectId, taskId, payload: { key, title: input.title } }] };
}

// What is raised is a task from the start: it sits in the board's inbox, with the report's thread as its own, until someone settles it.
export async function inboxTask(tx: Tx, input: { issue: { id: string; number: number; title: string; body: string; project_id: string }; authorAgentId: string | null; now: number }): Promise<string> {
  const taskId = newId(input.now);
  await tx.insertInto('tasks').values({ id: taskId, project_id: input.issue.project_id, key: `ISSUE-${input.issue.number}`, source: 'internal', title: input.issue.title, brief: input.issue.body, tag: null, priority: 0, milestone_id: null, state: 'inbox', assignee_agent_id: null, author_agent_id: input.authorAgentId, branch: null, head_sha: null, pr_url: null, blocked_reason: null, created_at: input.now, updated_at: input.now }).execute();
  await tx.insertInto('links').values({ from_type: 'issue', from_id: input.issue.id, to_type: 'task', to_id: taskId, rel: 'fixes', created_at: input.now }).execute();
  return taskId;
}

// An accepted issue becomes work: one task for its owner, linked to the issue. Accepting twice keeps the first task.
// Used by the PM's triage and by a person who makes the call themselves; returns the new task and the events that tell of it.
export async function taskFromIssue(tx: Tx, input: { issue: { id: string; number: number; title: string; body: string; project_id: string }; ownerId: string; authorAgentId: string | null; actor: Pick<EventDraft, 'actorKind' | 'agentId' | 'userId' | 'turnId'>; now: number }): Promise<{ taskId: string | null; events: EventDraft[] }> {
  const { issue, ownerId, now } = input;
  const linked = await tx.selectFrom('links').select('to_id').where('from_type', '=', 'issue').where('from_id', '=', issue.id).where('to_type', '=', 'task').where('rel', '=', 'fixes').executeTakeFirst();
  if (linked) {
    // It has waited in the inbox: accepting gives it its owner and lets work start. Anything further along was accepted before.
    const waiting = await tx.selectFrom('tasks').select('id').where('id', '=', linked.to_id).where('state', '=', 'inbox').executeTakeFirst();
    if (!waiting) return { taskId: null, events: [] };
    const lowest = await tx.selectFrom('tasks').select(eb => eb.fn.max('priority').as('n')).where('project_id', '=', issue.project_id).executeTakeFirst();
    await tx.updateTable('tasks').set({ state: 'assigned', assignee_agent_id: ownerId, priority: Number(lowest?.n ?? -1) + 1, updated_at: now }).where('id', '=', waiting.id).execute();
    return { taskId: waiting.id, events: [{ ...input.actor, type: 'task.assigned', agentId: ownerId, projectId: issue.project_id, taskId: waiting.id, payload: { fromIssue: issue.id } }] };
  }
  const taskId = newId(now);
  const lowest = await tx.selectFrom('tasks').select(eb => eb.fn.max('priority').as('n')).where('project_id', '=', issue.project_id).executeTakeFirst();
  await tx.insertInto('tasks').values({ id: taskId, project_id: issue.project_id, key: `ISSUE-${issue.number}`, source: 'internal', title: issue.title, brief: issue.body, tag: null, priority: Number(lowest?.n ?? -1) + 1, milestone_id: null, state: 'assigned', assignee_agent_id: ownerId, author_agent_id: input.authorAgentId, branch: null, head_sha: null, pr_url: null, blocked_reason: null, created_at: now, updated_at: now }).execute();
  await tx.insertInto('links').values({ from_type: 'issue', from_id: issue.id, to_type: 'task', to_id: taskId, rel: 'fixes', created_at: now }).execute();
  return { taskId, events: [
    { ...input.actor, type: 'task.assigned', agentId: ownerId, projectId: issue.project_id, taskId, payload: { fromIssue: issue.id } },
    { ...input.actor, type: 'link.added', projectId: issue.project_id, payload: { from: { type: 'issue', id: issue.id }, to: { type: 'task', id: taskId }, rel: 'fixes' } },
  ] };
}
