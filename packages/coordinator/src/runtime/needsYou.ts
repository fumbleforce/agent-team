import { newId } from '@agent-team/protocol';
import { HttpError, type Context } from '../context.ts';
import { indexMessage } from '../knowledge/indexing.ts';
import type { Turns } from './turns.ts';

export type NeedsYouKind = 'decision' | 'quarantine' | 'delivery' | 'proposal' | 'blocked';
export interface NeedsYouItem { kind: NeedsYouKind; id: string; projectId: string; title: string; detail: string; since: number; taskKey: string | null; href: string | null;
  // What it is about, so a person can tell without looking anything up: the task by its title, who was on it and what they last said, and where the change is.
  about?: { taskHref: string | null; taskTitle: string | null; who: string | null; doing: string | null; lastReport: string | null; branch: string | null; changeUrl: string | null } }

// The one queue of what only a person can settle: decisions outside the delegated bounds, work whose outcome is unknown,
// a delivery cut off mid-merge, proposals waiting for a yes or no, and tasks the team could not move.
export function createNeedsYou(context: Context, turns: Turns) {
  const { storage, events, now } = context;
  const db = storage.db;

  return {
    async list(): Promise<NeedsYouItem[]> {
      const slugs = new Map((await db.selectFrom('projects').select(['id', 'slug']).execute()).map(row => [row.id, row.slug]));
      const tasks = new Map((await db.selectFrom('tasks').select(['id', 'key', 'title', 'project_id', 'branch', 'pr_url', 'assignee_agent_id']).execute()).map(row => [row.id, row]));
      const names = new Map((await db.selectFrom('agents').select(['id', 'name']).execute()).map(row => [row.id, row.name]));
      const DOING: Record<string, string> = { work: 'working on it', review: 'reviewing it', deliver: 'merging it', publish: 'publishing the change', triage: 'sorting it out', reply: 'answering' };
      const about = async (taskId: string | null, turnId: string | null): Promise<NonNullable<NeedsYouItem['about']>> => {
        const task = taskId ? tasks.get(taskId) : undefined, turn = turnId ? await db.selectFrom('turns').select(['agent_id', 'kind']).where('id', '=', turnId).executeTakeFirst() : undefined;
        // The last thing anyone reported on the task tells what state the work is likely in.
        const last = taskId ? await db.selectFrom('turns').select(['summary', 'agent_id']).where('task_id', '=', taskId).where('summary', 'is not', null).orderBy('started_at', 'desc').executeTakeFirst() : undefined;
        return { taskHref: task ? `/p/${slugs.get(task.project_id)}/tasks/${task.id}` : null, taskTitle: task?.title ?? null, who: names.get(turn?.agent_id ?? task?.assignee_agent_id ?? '') ?? null, doing: turn ? DOING[turn.kind] ?? turn.kind : null, lastReport: last?.summary ? `${names.get(last.agent_id) ?? 'Someone'}: ${last.summary.slice(0, 400)}` : null, branch: task?.branch ?? null, changeUrl: task?.pr_url ?? null };
      };
      const items: NeedsYouItem[] = [];
      for (const row of await db.selectFrom('decisions').selectAll().where('needs_human', '=', true).where('resolved_at', 'is', null).execute())
        items.push({ kind: 'decision', id: row.id, projectId: row.project_id, title: 'The team needs your call', detail: row.summary, since: Number(row.created_at), taskKey: null, href: `/p/${slugs.get(row.project_id)}/tasks` });
      for (const row of await db.selectFrom('quarantines').selectAll().where('released_at', 'is', null).execute()) {
        const task = row.scope === 'task' ? tasks.get(row.ref_id) : undefined;
        const turn = await db.selectFrom('turns').select('project_id').where('id', '=', row.turn_id).executeTakeFirst();
        const projectId = task?.project_id ?? turn?.project_id;
        if (!projectId) continue;
        const facts = await about(task?.id ?? null, row.turn_id);
        items.push({ kind: 'quarantine', id: row.id, projectId, title: task ? `${task.key} · ${task.title}` : 'A worker’s copy of the repository is in an unknown state', detail: task ? `${facts.who ?? 'An agent'} was ${facts.doing ?? 'on it'} when the worker lost contact, so how far it got is not known.` : row.reason, since: Number(row.opened_at), taskKey: task?.key ?? null, href: null, about: facts });
      }
      for (const row of await db.selectFrom('merge_queue').selectAll().where('state', '=', 'uncertain').execute()) {
        const task = tasks.get(row.task_id);
        const facts = await about(task?.id ?? null, null);
        items.push({ kind: 'delivery', id: row.id, projectId: row.project_id, title: task ? `${task.key} · ${task.title}` : 'A merge was cut off', detail: 'The worker lost contact while merging this change, so it is not known whether the merge went through. Open the change to see, then say which it was; nothing else merges in this project until you do.', since: Number(row.created_at), taskKey: task?.key ?? null, href: null, about: facts });
      }
      for (const row of await db.selectFrom('proposals').select(['id', 'project_id', 'title', 'why', 'created_at']).where('state', '=', 'needs_you').execute())
        items.push({ kind: 'proposal', id: row.id, projectId: row.project_id, title: row.title, detail: row.why, since: Number(row.created_at), taskKey: null, href: `/proposals/${row.id}` });
      for (const row of await db.selectFrom('tasks').select(['id', 'project_id', 'key', 'title', 'blocked_reason', 'updated_at']).where('state', '=', 'blocked').execute())
        items.push({ kind: 'blocked', id: row.id, projectId: row.project_id, title: `${row.key} · ${row.title}`, detail: row.blocked_reason ?? 'The team could not move this on.', since: Number(row.updated_at), taskKey: row.key, href: null, about: await about(row.id, null) });
      return items.sort((a, b) => a.since - b.since);
    },

    async projectOf(kind: NeedsYouKind, id: string): Promise<string | null> { return (await this.list()).find(item => item.kind === kind && item.id === id)?.projectId ?? null; },

    // An escalated decision is settled in the person's own words; the answer is posted to the thread it came from.
    async resolveDecision(userId: string, decisionId: string, answer: string) {
      const published = await storage.transaction(async tx => {
        const decision = await tx.selectFrom('decisions').selectAll().where('id', '=', decisionId).where('resolved_at', 'is', null).executeTakeFirst();
        if (!decision) throw new HttpError(404, 'not_found', 'That decision is already settled');
        const messageId = newId(now());
        await tx.insertInto('messages').values({ id: messageId, thread_id: decision.thread_id, author_kind: 'user', author_id: userId, kind: 'decision', body: answer, payload: JSON.stringify({ resolves: decisionId }), created_at: now() }).execute();
        await indexMessage(storage, tx, { id: messageId, threadId: decision.thread_id, body: answer });
        await tx.updateTable('decisions').set({ resolved_by_user: userId, resolved_at: now() }).where('id', '=', decisionId).execute();
        // Work that was waiting on the decision can go on.
        await tx.updateTable('tasks').set({ state: 'in_progress', updated_at: now() }).where('project_id', '=', decision.project_id).where('state', '=', 'awaiting_decision').execute();
        return events.append(tx, [{ type: 'message.posted', actorKind: 'user', userId, projectId: decision.project_id, threadId: decision.thread_id, payload: { messageId, kind: 'decision' } }, { type: 'decision.resolved', actorKind: 'user', userId, projectId: decision.project_id, threadId: decision.thread_id, payload: { decisionId } }]);
      });
      events.published(published);
    },

    // Only a person who looked may release work whose outcome is unknown. Nothing is retried on its own: "continue" queues a fresh turn, "stop" parks the task.
    async releaseQuarantine(userId: string | null, quarantineId: string, resolution: 'continue' | 'stop', note: string) {
      const released = await storage.transaction(async tx => {
        const row = await tx.selectFrom('quarantines').selectAll().where('id', '=', quarantineId).where('released_at', 'is', null).executeTakeFirst();
        if (!row) throw new HttpError(404, 'not_found', 'That is already released');
        await tx.updateTable('quarantines').set({ released_by: userId, released_at: now() }).where('id', '=', quarantineId).execute();
        const task = row.scope === 'task' ? await tx.selectFrom('tasks').select(['id', 'project_id', 'assignee_agent_id']).where('id', '=', row.ref_id).executeTakeFirst() : undefined;
        if (task) await tx.updateTable('tasks').set({ state: resolution === 'continue' ? 'in_progress' : 'stopped', blocked_reason: null, updated_at: now() }).where('id', '=', task.id).execute();
        const turn = await tx.selectFrom('turns').select('project_id').where('id', '=', row.turn_id).executeTakeFirst();
        const published = await events.append(tx, [{ type: 'quarantine.released', category: 'audit', ...(userId ? { actorKind: 'user' as const, userId } : { actorKind: 'system' as const }), projectId: task?.project_id ?? turn?.project_id ?? null, taskId: task?.id ?? null, payload: { quarantineId, scope: row.scope, resolution, note } }]);
        return { published, task };
      });
      events.published(released.published);
      if (released.task?.assignee_agent_id && resolution === 'continue') await turns.enqueue({ agentId: released.task.assignee_agent_id, projectId: released.task.project_id, kind: 'work', taskId: released.task.id, dedupeKey: `release:${quarantineId}` });
    },

    // The person checked the code host: the change either went in or it did not. Either answer unfreezes the project's merge queue.
    async reconcileDelivery(userId: string, entryId: string, merged: boolean) {
      const published = await storage.transaction(async tx => {
        const entry = await tx.selectFrom('merge_queue').selectAll().where('id', '=', entryId).where('state', '=', 'uncertain').executeTakeFirst();
        if (!entry) throw new HttpError(404, 'not_found', 'That delivery is already settled');
        await tx.updateTable('merge_queue').set({ state: merged ? 'merged' : 'queued', reason: merged ? 'Confirmed merged by a person' : 'Confirmed not merged; queued again', finished_at: merged ? now() : null }).where('id', '=', entryId).execute();
        if (merged) await tx.updateTable('tasks').set({ state: 'done', updated_at: now() }).where('id', '=', entry.task_id).execute();
        return events.append(tx, [{ type: 'delivery.reconciled', category: 'audit', actorKind: 'user', userId, projectId: entry.project_id, taskId: entry.task_id, payload: { entryId, merged } }]);
      });
      events.published(published);
    },
  };
}
