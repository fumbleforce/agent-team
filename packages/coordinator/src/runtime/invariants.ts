import type { Context } from '../context.ts';

// The safety rules of AGENTS.md that can be read back from a database at any moment, as the seeded simulation does after every
// claim. Run against real data they are row S1 of the scorecard: each violation names the rule and the rows that break it.
export interface Violation {
  rule: string;
  detail: string;
}

// A lease this far past its end should have been swept; anything older means the sweep is not running.
const SWEEP_GRACE_MS = 5 * 60_000;

export async function checkInvariants(context: Pick<Context, 'storage' | 'now'>): Promise<Violation[]> {
  const db = context.storage.db;
  const now = context.now();
  const violations: Violation[] = [];
  const repeated = (keys: string[]) => [...new Set(keys.filter((key, index) => keys.indexOf(key) !== index))];

  const running = await db.selectFrom('turns').select(['id', 'agent_id', 'lane', 'task_id', 'project_id', 'kind', 'access', 'lease_until', 'started_at']).where('state', '=', 'running').execute();
  for (const key of repeated(running.map(turn => `${turn.agent_id}/${turn.lane}`))) {
    violations.push({ rule: 'one running turn per agent and lane', detail: `agent and lane ${key} has more than one` });
  }
  for (const taskId of repeated(running.filter(turn => turn.access === 'write' && turn.task_id).map(turn => turn.task_id!))) {
    violations.push({ rule: 'one writer per task', detail: `task ${taskId} has more than one running write turn` });
  }
  for (const projectId of repeated(running.filter(turn => turn.kind === 'deliver').map(turn => turn.project_id))) {
    violations.push({ rule: 'one running delivery per project', detail: `project ${projectId} has more than one` });
  }
  for (const turn of running) {
    if (Number(turn.lease_until) < now - SWEEP_GRACE_MS) violations.push({ rule: 'an expired lease is swept', detail: `turn ${turn.id} still runs ${Math.round((now - Number(turn.lease_until)) / 60_000)} minutes past its lease` });
  }

  const open = await db.selectFrom('quarantines').select(['ref_id', 'opened_at']).where('scope', '=', 'task').where('released_at', 'is', null).execute();
  for (const quarantine of open) {
    const started = running.find(turn => turn.task_id === quarantine.ref_id && Number(turn.started_at) > Number(quarantine.opened_at));
    if (started) violations.push({ rule: 'nothing starts on a quarantined task', detail: `turn ${started.id} started on task ${quarantine.ref_id} after it was quarantined` });
  }

  // An uncertain turn is never tried again: its work item is spent and no later turn ran for it.
  const uncertain = await db.selectFrom('turns').select(['id', 'work_item_id', 'started_at']).where('state', '=', 'uncertain').execute();
  for (const turn of uncertain) {
    const again = await db.selectFrom('turns').select('id').where('work_item_id', '=', turn.work_item_id).where('started_at', '>', turn.started_at).executeTakeFirst();
    if (again) violations.push({ rule: 'an uncertain turn is never retried', detail: `turn ${again.id} ran the work item of uncertain turn ${turn.id} again` });
  }

  // What was merged had passing, valid approvals at that very revision, and nobody approved their own work.
  const merged = await db.selectFrom('merge_queue').select(['task_id', 'head_sha']).where('state', '=', 'merged').execute();
  for (const entry of merged) {
    const pass = await db.selectFrom('approvals').select('id').where('task_id', '=', entry.task_id).where('head_sha', '=', entry.head_sha).where('verdict', '=', 'pass').where('state', '=', 'valid').executeTakeFirst();
    if (!pass) violations.push({ rule: 'nothing merges without approval at that revision', detail: `task ${entry.task_id} merged at ${String(entry.head_sha).slice(0, 10)} with no valid passing approval` });
  }
  const own = await db.selectFrom('approvals').innerJoin('tasks', 'tasks.id', 'approvals.task_id').select(['approvals.id', 'approvals.task_id'])
    .where('approvals.verdict', '=', 'pass').where('approvals.state', '=', 'valid').whereRef('approvals.agent_id', '=', 'tasks.assignee_agent_id').execute();
  for (const approval of own) {
    violations.push({ rule: 'an author does not approve their own work', detail: `approval ${approval.id} on task ${approval.task_id} is by its assignee` });
  }

  return violations;
}
