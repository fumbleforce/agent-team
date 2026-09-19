import type { Db, Tx } from '@agent-team/storage';
import type { Context } from '../context.ts';
import type { Turns } from '../runtime/turns.ts';
import { createCursors } from '../sync/cursors.ts';

const SCOPE = 'org', RESOURCE = 'check.wake';

// A failing run on a task's branch wakes whoever works on it, whatever reported the run: the code host, an upload or an agent.
// It follows the event log from a stored position, so a restart neither misses a failure nor wakes anyone twice.
export function createCheckWake(context: Context, turns: Pick<Turns, 'enqueue'>) {
  const db = context.storage.db;
  const cursors = createCursors(context);

  return {
    async sweep(): Promise<number> {
      const stored = await cursors.cursor(SCOPE, RESOURCE);
      if (stored === null) { await cursors.ok(SCOPE, RESOURCE, String(await context.events.head())); return 0; }
      const rows = await db.selectFrom('events').select(['seq', 'id', 'project_id', 'payload']).where('type', '=', 'check.failed').where('seq', '>', Number(stored)).orderBy('seq').limit(100).execute();
      let woken = 0;
      for (const row of rows) {
        const payload = JSON.parse(row.payload) as { runId?: string; branch?: string };
        const task = row.project_id && payload.branch ? await db.selectFrom('tasks').select(['id', 'assignee_agent_id', 'author_agent_id']).where('project_id', '=', row.project_id).where('branch', '=', payload.branch).where('state', 'not in', ['done', 'canceled', 'stopped', 'quarantined']).orderBy('updated_at', 'desc').executeTakeFirst() : undefined;
        const agentId = task?.assignee_agent_id ?? task?.author_agent_id;
        if (task && agentId && await turns.enqueue({ agentId, projectId: row.project_id!, kind: 'work', taskId: task.id, dedupeKey: `check:${task.id}`, causeEventId: row.id })) woken++;
      }
      if (rows.length) await cursors.ok(SCOPE, RESOURCE, String(rows.at(-1)!.seq));
      return woken;
    },
  };
}

// What the woken agent reads: the failing cases of the latest failed run on the task's branch, if that run is the branch's latest.
export async function failingChecks(db: Db | Tx, taskId: string): Promise<string | null> {
  const task = await db.selectFrom('tasks').select(['project_id', 'branch']).where('id', '=', taskId).executeTakeFirst();
  if (!task?.branch) return null;
  const runs = await db.selectFrom('check_runs').select(['id', 'suite', 'status', 'failed', 'sha']).where('project_id', '=', task.project_id).where('branch', '=', task.branch).orderBy('created_at', 'desc').orderBy('id', 'desc').limit(40).execute();
  const latest = runs.filter((run, index) => runs.findIndex(other => other.suite === run.suite) === index).filter(run => run.status === 'failed');
  if (!latest.length) return null;
  const cases = await db.selectFrom('check_cases').select(['run_id', 'name', 'message']).where('run_id', 'in', latest.map(run => run.id)).where('status', '=', 'failed').limit(20).execute();
  return `# Failing checks on ${task.branch}\n${latest.map(run => [`- ${run.suite}: ${run.failed} failing${run.sha ? ` at ${run.sha.slice(0, 10)}` : ''}`, ...cases.filter(item => item.run_id === run.id).map(item => `  - ${item.name}${item.message ? `: ${item.message.slice(0, 300)}` : ''}`)].join('\n')).join('\n')}`;
}
