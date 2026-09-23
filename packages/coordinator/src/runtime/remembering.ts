import type { Context } from '../context.ts';
import { createWorkspace } from '../repos/workspace.ts';
import { createCursors } from '../sync/cursors.ts';
import type { Turns } from './turns.ts';

const SCOPE = 'org', RESOURCE = 'memory.remember';

// When the team learns something, a memory turn follows: a task finished, a review asked for changes, a work turn failed, the owner
// settled a decision. It runs on the seat that did the work (the PM where there is none), at the lowest priority, once per task at a
// time: a memory turn already queued for the task reads everything that happened since the last one. It follows the event log from a
// stored position, so a restart neither misses a trigger nor queues one twice.
export function createRemembering(context: Context, turns: Pick<Turns, 'enqueue'>) {
  const db = context.storage.db, cursors = createCursors(context), workspace = createWorkspace(context);

  return {
    async sweep(): Promise<number> {
      const stored = await cursors.cursor(SCOPE, RESOURCE);
      if (stored === null) { await cursors.ok(SCOPE, RESOURCE, String(await context.events.head())); return 0; }
      const rows = await db.selectFrom('events').select(['seq', 'id', 'type', 'project_id', 'task_id', 'thread_id', 'turn_id', 'payload']).where('seq', '>', Number(stored))
        .where('type', 'in', ['task.state_changed', 'review.recorded', 'turn.failed', 'decision.resolved']).orderBy('seq').limit(200).execute();
      let queued = 0;
      for (const row of rows) {
        if (!row.project_id) continue;
        const payload = JSON.parse(row.payload) as { to?: string; verdict?: string; decisionId?: string };
        const learns = row.type === 'task.state_changed' ? payload.to === 'done'
          : row.type === 'review.recorded' ? payload.verdict !== 'pass'
            : row.type === 'turn.failed' ? (await db.selectFrom('turns').select('kind').where('id', '=', row.turn_id ?? '').executeTakeFirst())?.kind === 'work'
              : true;
        if (!learns) continue;
        const taskId = row.task_id ?? (row.type === 'decision.resolved' && payload.decisionId ? await taskOfDecision(payload.decisionId) : null);
        const task = taskId ? await db.selectFrom('tasks').select(['assignee_agent_id']).where('id', '=', taskId).executeTakeFirst() : undefined;
        const owner = task?.assignee_agent_id ? await db.selectFrom('agents').select('id').where('id', '=', task.assignee_agent_id).where('status', '=', 'active').executeTakeFirst() : undefined;
        const agentId = owner?.id ?? await workspace.pm(row.project_id);
        if (!agentId) continue;
        if (await turns.enqueue({ agentId, projectId: row.project_id, kind: 'remember', taskId: taskId ?? null, threadId: taskId ? null : row.thread_id, dedupeKey: `remember:${taskId ?? `thread:${row.thread_id}`}`, causeEventId: row.id })) queued++;
      }
      if (rows.length) await cursors.ok(SCOPE, RESOURCE, String(rows.at(-1)!.seq));
      return queued;
    },
  };

  async function taskOfDecision(decisionId: string): Promise<string | null> {
    const decision = await db.selectFrom('decisions').select(['deliberation_id', 'thread_id']).where('id', '=', decisionId).executeTakeFirst();
    if (!decision) return null;
    const byDeliberation = decision.deliberation_id ? (await db.selectFrom('deliberations').select('task_id').where('id', '=', decision.deliberation_id).executeTakeFirst())?.task_id ?? null : null;
    const thread = byDeliberation ? null : await db.selectFrom('threads').select(['subject_type', 'subject_id']).where('id', '=', decision.thread_id).executeTakeFirst();
    return byDeliberation ?? (thread?.subject_type === 'task' ? thread.subject_id : null);
  }
}
