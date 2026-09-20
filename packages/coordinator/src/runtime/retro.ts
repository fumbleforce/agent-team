import { newId } from '@agent-team/protocol';
import type { Context } from '../context.ts';
import { staffingSeat } from './staffing.ts';
import type { Turns } from './turns.ts';

const WEEK_MS = 7 * 24 * 3600_000;
const PM_DELAY_MS = 3600_000;

// The weekly retro: figures from the log, no model; then one retro turn per seat that worked this week, the PM last.
export function createRetro(context: Context, turns: Turns) {
  const { storage, events, now } = context;
  const db = storage.db;

  async function stats(projectIds: string[], since: number) {
    const rows = await db.selectFrom('turns').innerJoin('agents', 'agents.id', 'turns.agent_id').select(['agents.id', 'agents.name', 'agents.is_pm', 'turns.state', 'turns.cost_minor', 'turns.started_at', 'turns.finished_at']).where('turns.project_id', 'in', projectIds).where('turns.started_at', '>=', since).execute();
    const byAgent = new Map<string, { id: string; name: string; isPm: boolean; turns: number; failed: number; costMinor: number; busyMs: number }>();
    for (const row of rows) {
      const entry = byAgent.get(row.id) ?? { id: row.id, name: row.name, isPm: row.is_pm, turns: 0, failed: 0, costMinor: 0, busyMs: 0 };
      entry.turns++; entry.costMinor += row.cost_minor;
      if (['failed', 'timed_out', 'uncertain'].includes(row.state)) entry.failed++;
      if (row.finished_at !== null) entry.busyMs += Number(row.finished_at) - Number(row.started_at);
      byAgent.set(row.id, entry);
    }
    return [...byAgent.values()];
  }

  return {
    async ensureSchedule(projectId: string, intervalMs = WEEK_MS) {
      await db.insertInto('schedules').values({ id: newId(now()), project_id: projectId, kind: 'retro', interval_ms: intervalMs, next_at: now() + intervalMs, last_at: null }).onConflict(oc => oc.columns(['project_id', 'kind']).doNothing()).execute();
    },

    // Runs every retro that is due. A project where nobody worked gets no turns, only the next date.
    async sweep() {
      const due = await db.selectFrom('schedules').selectAll().where('kind', '=', 'retro').where('next_at', '<=', now()).execute();
      for (const schedule of due) {
        const subprojects = await db.selectFrom('projects').select('id').where('parent_id', '=', schedule.project_id).execute();
        const figures = await stats([schedule.project_id, ...subprojects.map(row => row.id)], Number(schedule.last_at ?? Number(schedule.next_at) - Number(schedule.interval_ms)));
        const thread = await db.selectFrom('threads').select('id').where('project_id', '=', schedule.project_id).where('kind', '=', 'discussion').executeTakeFirst();
        const published = await storage.transaction(async tx => {
          await tx.updateTable('schedules').set({ last_at: now(), next_at: now() + Number(schedule.interval_ms) }).where('id', '=', schedule.id).execute();
          if (!thread || figures.length === 0) return [];
          const lines = figures.map(item => `- ${item.name}: ${item.turns} turns, ${item.failed} failed, ${(item.costMinor / 100).toFixed(2)} spent, ${Math.round(item.busyMs / 60_000)} min busy`);
          await tx.insertInto('messages').values({ id: newId(now()), thread_id: thread.id, author_kind: 'system', author_id: null, kind: 'system', body: `Weekly retro. This week:\n${lines.join('\n')}`, payload: JSON.stringify({ retro: true, figures }), created_at: now() }).execute();
          return events.append(tx, [{ type: 'retro.opened', actorKind: 'system', projectId: schedule.project_id, threadId: thread.id, payload: { seats: figures.length } }, { type: 'message.posted', actorKind: 'system', projectId: schedule.project_id, threadId: thread.id, payload: { kind: 'system' } }]);
        });
        events.published(published);
        if (!thread) continue;
                // The PM's turn opens an hour later, so the seats' notes are there to read.
        // Whoever staffs the team reads the week like the PM does, after the others, and also in a week it did nothing itself.
        const hr = figures.length ? await staffingSeat(db, schedule.project_id) : null;
        for (const seat of [...figures, ...(hr && !figures.some(item => item.id === hr.id) ? [{ id: hr.id, isPm: false }] : [])]) await turns.enqueue({ agentId: seat.id, projectId: schedule.project_id, kind: 'retro', threadId: thread.id, dedupeKey: `retro:${schedule.id}:${seat.id}:${now()}`, ...(seat.isPm || seat.id === hr?.id ? { notBefore: now() + PM_DELAY_MS } : {}) });
      }
    },
  };
}
