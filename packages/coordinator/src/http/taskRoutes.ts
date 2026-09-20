import type { Context as Hc, Hono } from 'hono';
import { z } from 'zod';
import { newId } from '@agent-team/protocol';
import { can, type Action, type Viewer } from '../auth/rbac.ts';
import { forbidden, HttpError, type Context } from '../context.ts';
import type { Turns } from '../runtime/turns.ts';
import { parseBody } from './conventions.ts';

type Env = { Variables: { viewer: Viewer } };

// One task, opened from its card: what it asks for, who has it, where the change is, what was done on it so far,
// and what people wrote on it. Writing on a task is direction for whoever works on it: their next turn reads it.
export function mountTaskRoutes(app: Hono<Env>, context: Context, turns: Turns) {
  const { storage, events, now } = context, db = storage.db;
  const found = async (c: Hc<Env>, action: Action) => {
    const task = await db.selectFrom('tasks').innerJoin('projects', 'projects.id', 'tasks.project_id').select(['tasks.id', 'tasks.project_id', 'tasks.key', 'tasks.title', 'tasks.brief', 'tasks.state', 'tasks.tag', 'tasks.source', 'tasks.assignee_agent_id', 'tasks.branch', 'tasks.pr_url', 'tasks.blocked_reason', 'tasks.updated_at', 'projects.parent_id', 'projects.slug']).where('tasks.id', '=', c.req.param('id')!).executeTakeFirst();
    if (!task) throw new HttpError(404, 'not_found', 'Task not found');
    if (!can(c.get('viewer'), action, task.parent_id ?? task.project_id)) throw forbidden();
    return task;
  };
  const threadOf = (taskId: string) => db.selectFrom('threads').select('id').where('subject_type', '=', 'task').where('subject_id', '=', taskId).executeTakeFirst();

  app.get('/api/tasks/:id', async c => {
    const task = await found(c, 'project.read'), thread = await threadOf(task.id);
    const issue = await db.selectFrom('links').innerJoin('issues', 'issues.id', 'links.from_id').select(['issues.number', 'issues.title']).where('links.from_type', '=', 'issue').where('links.to_type', '=', 'task').where('links.to_id', '=', task.id).executeTakeFirst();
    const tracker = await db.selectFrom('external_refs').select('url').where('entity_type', '=', 'task').where('entity_id', '=', task.id).executeTakeFirst();
    const done = await db.selectFrom('turns').innerJoin('agents', 'agents.id', 'turns.agent_id').select(['turns.id', 'turns.kind', 'turns.state', 'turns.summary', 'turns.started_at', 'agents.name as agent']).where('turns.task_id', '=', task.id).orderBy('turns.started_at', 'desc').limit(12).execute();
    const queued = await db.selectFrom('work_items').innerJoin('agents', 'agents.id', 'work_items.agent_id').select(['work_items.kind', 'work_items.state', 'work_items.defer_reason', 'agents.name as agent']).where('work_items.task_id', '=', task.id).where('work_items.state', 'in', ['queued', 'leased']).execute();
    const messages = thread ? await db.selectFrom('messages').select(['id', 'author_kind', 'author_id', 'body', 'created_at']).where('thread_id', '=', thread.id).orderBy('seq', 'desc').limit(30).execute() : [];
    const { parent_id: _parent, ...rest } = task;
    return c.json({ task: { ...rest, updated_at: Number(task.updated_at) }, issue: issue ?? null, trackerUrl: tracker?.url ?? null, turns: done.map(turn => ({ ...turn, started_at: Number(turn.started_at) })), queued, messages: messages.reverse().map(message => ({ ...message, created_at: Number(message.created_at) })), canWrite: can(c.get('viewer'), 'project.contribute', task.parent_id ?? task.project_id) });
  });

  app.post('/api/tasks/:id/say', async c => {
    const task = await found(c, 'project.contribute'), input = await parseBody(c, z.object({ body: z.string().trim().min(1).max(8000) })), userId = c.get('viewer').userId;
    const published = await storage.transaction(async tx => {
      let thread = await tx.selectFrom('threads').select('id').where('subject_type', '=', 'task').where('subject_id', '=', task.id).executeTakeFirst();
      if (!thread) { thread = { id: newId(now()) }; await tx.insertInto('threads').values({ id: thread.id, project_id: task.project_id, kind: 'issue', subject_type: 'task', subject_id: task.id, title: `${task.key} ${task.title}`.slice(0, 200), visibility: 'team', owner_user_id: null, created_at: now() }).execute(); }
      const id = newId(now());
      await tx.insertInto('messages').values({ id, thread_id: thread.id, author_kind: 'user', author_id: userId, kind: 'note', body: input.body, payload: '{}', created_at: now() }).execute();
      return events.append(tx, [{ type: 'message.posted', actorKind: 'user', userId, projectId: task.project_id, threadId: thread.id, taskId: task.id, payload: { messageId: id, kind: 'note' } }]);
    });
    events.published(published);
    // Whoever has the task reads it on their next turn; one is started unless one is already queued or running.
    if (task.assignee_agent_id && !['done', 'canceled', 'stopped'].includes(task.state)) await turns.enqueue({ agentId: task.assignee_agent_id, projectId: task.project_id, kind: 'work', taskId: task.id, dedupeKey: `work:${task.id}` }).catch(() => {});
    return c.json({ ok: true });
  });
}
