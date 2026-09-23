import type { Tx } from '@agent-team/storage';
import { teamIdOf } from '../repos/issueTasks.ts';
import { WORKER_FRESH_MS } from './scheduler.ts';
import { rule } from './turnRules.ts';

// The front desk is a seat like any other, told apart by the role it wears. A team that has one hears from it first:
// it answers what it can from what is going on, and passes work and decisions to the PM. A team without one is answered by the PM.
export const DESK_ROLE = 'front-desk';

type Reader = Pick<Tx, 'selectFrom'>;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export async function deskOf(db: Reader, projectId: string): Promise<string | null> {
  const teamId = await teamIdOf(db as Tx, projectId);
  if (!teamId) return null;
  const seat = await db.selectFrom('agents').innerJoin('agent_roles', 'agent_roles.agent_id', 'agents.id').select('agents.id').where('agents.team_id', '=', teamId).where('agents.status', '=', 'active').where('agent_roles.role_slug', '=', DESK_ROLE).orderBy('agents.sort').executeTakeFirst();
  return seat?.id ?? null;
}
export const wearsDesk = async (db: Reader, agentId: string): Promise<boolean> => Boolean(await db.selectFrom('agent_roles').select('agent_id').where('agent_id', '=', agentId).where('role_slug', '=', DESK_ROLE).executeTakeFirst());

export const DESK_RULE = rule('desk');

// What a receptionist knows: who is doing what right now, what waits and why, what needs the owner, and whether anything can run at all.
export async function goingOn(tx: Reader, projectId: string, now: number): Promise<string> {
  const teamId = await teamIdOf(tx as Tx, projectId);
  const agents = teamId ? await tx.selectFrom('agents').select(['id', 'name', 'title', 'status', 'doing', 'is_pm']).where('team_id', '=', teamId).where('status', '!=', 'retired').orderBy('sort').execute() : [];
  const name = (id: string | null) => agents.find(agent => agent.id === id)?.name ?? 'nobody';
  const running = await tx.selectFrom('turns').leftJoin('tasks', 'tasks.id', 'turns.task_id').select(['turns.agent_id', 'turns.kind', 'turns.started_at', 'tasks.key']).where('turns.project_id', '=', projectId).where('turns.state', '=', 'running').execute();
  const queued = await tx.selectFrom('work_items').leftJoin('tasks', 'tasks.id', 'work_items.task_id').select(['work_items.agent_id', 'work_items.kind', 'work_items.defer_reason', 'tasks.key']).where('work_items.project_id', '=', projectId).where('work_items.state', '=', 'queued').limit(30).execute();
  const tasks = await tx.selectFrom('tasks').select(['key', 'title', 'state', 'assignee_agent_id', 'blocked_reason', 'pr_url']).where('project_id', '=', projectId).where('state', 'not in', ['done', 'canceled']).orderBy('updated_at', 'desc').limit(25).execute();
  const done = await tx.selectFrom('tasks').select(['key', 'title']).where('project_id', '=', projectId).where('state', '=', 'done').orderBy('updated_at', 'desc').limit(4).execute();
  const waiting = await tx.selectFrom('decisions').select('summary').where('project_id', '=', projectId).where('needs_human', '=', true).where('resolved_at', 'is', null).limit(5).execute();
  const issues = await tx.selectFrom('issues').select(['number', 'title']).where('project_id', '=', projectId).where('state', '=', 'open').orderBy('number', 'desc').limit(6).execute();
  const workers = await tx.selectFrom('workers').select(['name', 'projects']).where('last_seen_at', '>', now - WORKER_FRESH_MS).execute();
  const serving = workers.filter(worker => (JSON.parse(worker.projects) as string[]).includes(projectId));
  const last = await tx.selectFrom('turns').innerJoin('agents', 'agents.id', 'turns.agent_id').select(['agents.name', 'turns.kind', 'turns.state', 'turns.summary']).where('turns.project_id', '=', projectId).where('turns.state', '!=', 'running').where('turns.kind', 'in', ['work', 'review', 'deliver']).orderBy('turns.started_at', 'desc').limit(4).execute();

  const minutes = (at: number) => `${Math.max(1, Math.round((now - Number(at)) / 60_000))} min`;
  return [
    '# What is going on',
    serving.length ? `Workers running: ${serving.map(worker => worker.name).join(', ')}.` : 'No worker is running for this project right now, so nothing can start until one is.',
    `## The team\n${agents.map(agent => { const turn = running.find(item => item.agent_id === agent.id), next = queued.filter(item => item.agent_id === agent.id); return `- ${agent.name}, ${agent.title}${agent.is_pm ? ' (PM)' : ''}${agent.status === 'paused' ? ', paused' : ''}: ${turn ? `${turn.kind}${turn.key ? ` on ${turn.key}` : ''} for ${minutes(Number(turn.started_at))}` : next.length ? `waiting to start ${next.map(item => `${item.kind}${item.key ? ` on ${item.key}` : ''}${item.defer_reason ? ` (held: ${item.defer_reason})` : ''}`).join(', ')}` : 'nothing in hand'}`; }).join('\n') || '- nobody yet'}`,
    `## Tasks not finished\n${tasks.map(task => `- ${task.key} ${clip(task.title, 90)}: ${task.state}${task.blocked_reason ? ` (${clip(task.blocked_reason, 80)})` : ''}, ${task.assignee_agent_id ? name(task.assignee_agent_id) : 'unassigned'}${task.pr_url ? ', change is up' : ''}`).join('\n') || '- none'}`,
    done.length ? `## Finished lately\n${done.map(task => `- ${task.key} ${clip(task.title, 90)}`).join('\n')}` : '',
    last.length ? `## Last things done\n${last.map(turn => `- ${turn.name}, ${turn.kind}, ${turn.state}: ${clip(turn.summary ?? 'no summary', 200)}`).join('\n')}` : '',
    waiting.length ? `## Waiting for the owner\n${waiting.map(row => `- ${clip(row.summary, 160)}`).join('\n')}` : 'Nothing is waiting for the owner.',
    issues.length ? `## Open issues\n${issues.map(issue => `- #${issue.number} ${clip(issue.title, 90)}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
}
