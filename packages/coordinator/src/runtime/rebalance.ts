import type { RebalanceMove } from '@agent-team/protocol';
import { HttpError, type Context } from '../context.ts';

export interface QueuedWork { id: string; agentId: string; priorityClass: number; createdAt: number; started: boolean }
export interface Seat { id: string; active: boolean; running: number }

// Deterministic: the same lanes always give the same moves. Only queued work that has never started moves (a started task
// has a worktree and a session with its agent); running and bounded items stay where they are. Each step takes the
// least urgent, newest item of the fullest lane to the emptiest one, until no two lanes differ by more than one.
export function suggest(seats: readonly Seat[], queued: readonly QueuedWork[]): RebalanceMove[] {
  const active = seats.filter(seat => seat.active).map(seat => seat.id).sort();
  if (active.length < 2) return [];
  const lanes = new Map(active.map(id => [id, queued.filter(item => item.agentId === id).sort((a, b) => a.priorityClass - b.priorityClass || a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))]));
  const running = new Map(seats.map(seat => [seat.id, seat.running]));
  const load = (id: string) => (lanes.get(id)?.length ?? 0) + (running.get(id) ?? 0);
  const moves: RebalanceMove[] = [];
  for (let step = 0; step < 50; step += 1) {
    const order = [...active].sort((a, b) => load(b) - load(a) || (a < b ? -1 : 1));
    const to = order.at(-1)!, from = order.find(id => load(id) - load(to) >= 2 && lanes.get(id)!.some(item => !item.started));
    if (!from) break;
    const lane = lanes.get(from)!, index = lane.findLastIndex(item => !item.started), [item] = lane.splice(index, 1);
    lanes.get(to)!.push(item!);
    moves.push({ workItemId: item!.id, fromAgentId: from, toAgentId: to });
  }
  // An item that moved twice is one move from where it started to where it ended.
  const merged = new Map<string, RebalanceMove>();
  for (const move of moves) merged.set(move.workItemId, { workItemId: move.workItemId, fromAgentId: merged.get(move.workItemId)?.fromAgentId ?? move.fromAgentId, toAgentId: move.toAgentId });
  return [...merged.values()].filter(move => move.fromAgentId !== move.toAgentId);
}

export function createRebalance(context: Context) {
  const { storage, events, now } = context;

  return {
    async suggest(teamId: string) {
      const db = storage.db;
      const agents = await db.selectFrom('agents').select(['id', 'name', 'status']).where('team_id', '=', teamId).where('status', '!=', 'retired').execute();
      const ids = agents.map(agent => agent.id);
      if (ids.length === 0) return [];
      const items = await db.selectFrom('work_items').leftJoin('tasks', 'tasks.id', 'work_items.task_id').select(['work_items.id', 'work_items.agent_id', 'work_items.task_id', 'work_items.priority_class', 'work_items.created_at', 'tasks.key', 'tasks.title']).where('work_items.agent_id', 'in', ids).where('work_items.state', '=', 'queued').where('work_items.kind', '=', 'work').execute();
      const taskIds = items.flatMap(item => item.task_id ?? []);
      const started = new Set(taskIds.length ? (await db.selectFrom('turns').select('task_id').where('task_id', 'in', taskIds).execute()).map(turn => turn.task_id) : []);
      const running = await db.selectFrom('turns').select('agent_id').where('agent_id', 'in', ids).where('state', '=', 'running').where('lane', '=', 'work').execute();
      const moves = suggest(agents.map(agent => ({ id: agent.id, active: agent.status === 'active', running: running.filter(turn => turn.agent_id === agent.id).length })), items.map(item => ({ id: item.id, agentId: item.agent_id, priorityClass: item.priority_class, createdAt: Number(item.created_at), started: item.task_id !== null && started.has(item.task_id) })));
      const name = (id: string) => agents.find(agent => agent.id === id)?.name ?? id;
      return moves.map(move => { const item = items.find(row => row.id === move.workItemId)!; return { ...move, fromName: name(move.fromAgentId), toName: name(move.toAgentId), key: item.key, title: item.title ?? 'work' }; });
    },

    // Applies only what is still true: the item is queued, still with the agent it was suggested from, and both agents sit on this team.
    async apply(teamId: string, moves: RebalanceMove[]) {
      const result = await storage.transaction(async tx => {
        const seats = new Map((await tx.selectFrom('agents').select(['id', 'status']).where('team_id', '=', teamId).execute()).map(agent => [agent.id, agent.status]));
        const drafts = [], skipped: string[] = [];
        for (const move of moves) {
          if (seats.get(move.toAgentId) !== 'active' || !seats.has(move.fromAgentId)) throw new HttpError(400, 'invalid', 'Both agents must be on this team and the receiving one active');
          const moved = await tx.updateTable('work_items').set({ agent_id: move.toAgentId, defer_reason: null }).where('id', '=', move.workItemId).where('agent_id', '=', move.fromAgentId).where('state', '=', 'queued').where('kind', '=', 'work').executeTakeFirst();
          if (Number(moved.numUpdatedRows) === 0) { skipped.push(move.workItemId); continue; }
          const item = await tx.selectFrom('work_items').select(['task_id', 'project_id']).where('id', '=', move.workItemId).executeTakeFirstOrThrow();
          if (item.task_id) await tx.updateTable('tasks').set({ assignee_agent_id: move.toAgentId, updated_at: now() }).where('id', '=', item.task_id).where('assignee_agent_id', '=', move.fromAgentId).execute();
          await tx.updateTable('agents').set({ idle_at: null }).where('id', '=', move.toAgentId).execute();
          drafts.push({ type: 'work_item.moved', actorKind: 'user' as const, projectId: item.project_id, agentId: move.toAgentId, taskId: item.task_id, payload: { workItemId: move.workItemId, fromAgentId: move.fromAgentId, toAgentId: move.toAgentId } });
        }
        return { applied: drafts.length, skipped, published: drafts.length ? await events.append(tx, drafts) : [] };
      });
      events.published(result.published);
      return { applied: result.applied, skipped: result.skipped };
    },
  };
}
export type Rebalance = ReturnType<typeof createRebalance>;
