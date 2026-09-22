import { newId } from '@agent-team/protocol';
import { HttpError, type Context } from '../context.ts';
import { moveTask } from './taskMoves.ts';
import type { Turns } from './turns.ts';

// What a person can do to an agent directly: stop what it is doing right now, stop a task, and talk to it in private.
export function createControls(context: Context, turns: Turns) {
  const { storage, events, now } = context;
  const db = storage.db;

  // The turn stops counting at once: its lease is void, so every tool call and report from it is refused, and the worker
  // kills the engine and everything it started at its next heartbeat. The worktree and branch are kept as they are.
  async function interrupt(tx: Parameters<Parameters<typeof storage.transaction>[0]>[0], where: { agentId?: string; taskId?: string }, userId: string) {
    let query = tx.selectFrom('turns').select(['id', 'work_item_id', 'agent_id', 'project_id', 'task_id']).where('state', '=', 'running');
    if (where.agentId) query = query.where('agent_id', '=', where.agentId);
    if (where.taskId) query = query.where('task_id', '=', where.taskId);
    const running = await query.execute();
    for (const turn of running) {
      await tx.updateTable('turns').set({ state: 'interrupted', stop_reason: 'stopped-by-user', finished_at: now(), lease_until: 0 }).where('id', '=', turn.id).execute();
      await tx.updateTable('work_items').set({ state: 'done' }).where('id', '=', turn.work_item_id).execute();
    }
    return running.map(turn => ({ type: 'turn.interrupted', actorKind: 'user' as const, userId, agentId: turn.agent_id, projectId: turn.project_id, taskId: turn.task_id, turnId: turn.id, payload: { reason: 'stopped-by-user' } }));
  }

  return {
    // "Pause now": the agent is paused and whatever it was running is cut short. Pausing after the turn is the ordinary pause.
    async stopAgent(userId: string, agentId: string) {
      const published = await storage.transaction(async tx => {
        const agent = await tx.selectFrom('agents').select('id').where('id', '=', agentId).executeTakeFirst();
        if (!agent) throw new HttpError(404, 'not_found', 'Agent not found');
        await tx.updateTable('agents').set({ status: 'paused', doing: null }).where('id', '=', agentId).execute();
        return events.append(tx, [...await interrupt(tx, { agentId }, userId), { type: 'agent.paused', category: 'audit', actorKind: 'user', userId, agentId, payload: { now: true } }]);
      });
      events.published(published);
      return { interrupted: published.filter(event => event.type === 'turn.interrupted').length };
    },

    // The task is parked: nothing queued for it runs, what is running is cut short, and its worktree, branch and draft change are kept.
    async stopTask(userId: string, taskId: string) {
      const published = await storage.transaction(async tx => {
        const task = await tx.selectFrom('tasks').select(['id', 'project_id', 'state']).where('id', '=', taskId).executeTakeFirst();
        if (!task) throw new HttpError(404, 'not_found', 'Task not found');
        if (['done', 'canceled'].includes(task.state)) throw new HttpError(409, 'conflict', 'That task is already finished');
        const moved = await moveTask(tx, taskId, 'stopped', { now: now(), actor: { actorKind: 'user', userId } });
        await tx.updateTable('work_items').set({ state: 'canceled', defer_reason: 'task-closed' }).where('task_id', '=', taskId).where('state', '=', 'queued').execute();
        return events.append(tx, [...await interrupt(tx, { taskId }, userId), { type: 'task.stopped', actorKind: 'user', userId, projectId: task.project_id, taskId, payload: {} }, ...moved]);
      });
      events.published(published);
    },

    // One private thread per person and agent. Nobody else, human or agent, can read it; the agent sees it only inside the reply turn it causes.
    async directThread(userId: string, agentId: string, projectId: string) {
      const existing = await db.selectFrom('threads').select('id').where('kind', '=', 'dm').where('owner_user_id', '=', userId).where('subject_id', '=', agentId).executeTakeFirst();
      if (existing) return existing.id;
      const agent = await db.selectFrom('agents').select('name').where('id', '=', agentId).executeTakeFirst();
      if (!agent) throw new HttpError(404, 'not_found', 'Agent not found');
      const id = newId(now());
      await db.insertInto('threads').values({ id, project_id: projectId, kind: 'dm', subject_type: 'agent', subject_id: agentId, title: `1:1 with ${agent.name}`, visibility: 'private', owner_user_id: userId, created_at: now() }).execute();
      return id;
    },

    async direct(userId: string, agentId: string, projectId: string) {
      const threadId = await this.directThread(userId, agentId, projectId);
      const messages = await db.selectFrom('messages').select(['id', 'seq', 'author_kind', 'author_id', 'kind', 'body', 'payload', 'created_at']).where('thread_id', '=', threadId).orderBy('seq').execute();
      return { threadId, messages: messages.map(row => ({ id: row.id, seq: Number(row.seq), authorKind: row.author_kind, authorId: row.author_id, kind: row.kind, body: row.body, payload: JSON.parse(row.payload) as Record<string, unknown>, createdAt: Number(row.created_at) })) };
    },

    async say(userId: string, agentId: string, projectId: string, body: string) {
      const threadId = await this.directThread(userId, agentId, projectId), id = newId(now());
      const published = await storage.transaction(async tx => {
        await tx.insertInto('messages').values({ id, thread_id: threadId, author_kind: 'user', author_id: userId, kind: 'note', body, payload: '{}', created_at: now() }).execute();
        // The event names the person, so the stream shows it to them alone.
        return events.append(tx, [{ type: 'message.posted', actorKind: 'user', userId, projectId, threadId, agentId, payload: { messageId: id, kind: 'note', private: true } }]);
      });
      events.published(published);
      await turns.enqueue({ agentId, projectId, kind: 'reply', threadId, dedupeKey: `dm:${threadId}:${id}` });
      // Direction for work in hand reaches that work: the agent's next turn on its task reads what was said. A turn already queued or running covers it.
      const inHand = await db.selectFrom('tasks').select(['id', 'project_id']).where('assignee_agent_id', '=', agentId).where('state', 'in', ['assigned', 'in_progress']).orderBy('updated_at', 'desc').executeTakeFirst();
      if (inHand) await turns.enqueue({ agentId, projectId: inHand.project_id, kind: 'work', taskId: inHand.id, dedupeKey: `work:${inHand.id}` }).catch(() => {});
      return { id };
    },
  };
}
