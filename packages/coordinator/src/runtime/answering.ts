import type { Context } from '../context.ts';
import { threadPending } from '../repos/workspace.ts';
import type { Workspace } from '../repos/workspace.ts';
import type { Turns } from './turns.ts';

// Pure: the words a thread gets when nobody was scheduled to answer what was raised in it. `pm` is the team's PM
// seat whatever its status, so a paused one is named rather than reported as missing.
export function unscheduled(team: { hasTeam: boolean; pm: { name: string; status: string } | null }): string {
  if (!team.hasTeam) return 'Nobody was given this: the project has no team yet. Add a team on the Team page and raise it again.';
  if (!team.pm) return 'Nobody was given this: the team has no PM to sort out what comes in. Make someone the PM on the Team page, or ask a teammate directly with @name.';
  if (team.pm.status !== 'active') return `Nobody was given this: ${team.pm.name} sorts out what comes in and is ${team.pm.status}. Resume that seat on the Team page, or ask a teammate directly with @name.`;
  return `Nobody was given this: ${team.pm.name} is the PM but is not on this project. Ask a teammate directly with @name, or move that seat onto this project.`;
}

// What a person writes in a team thread is either picked up by somebody or told why it was not. The PM's triage turn
// is the pick-up; everything that stops one from being scheduled is said in the thread itself, so silence never stands
// for latency. Whoever was named with @ already has it, so the PM is not woken on top of them.
export function createAnswering(context: Context, deps: { turns: Turns; workspace: Workspace }) {
  const db = context.storage.db;

  return {
    // `raisedBy` is the agent that raised this, if an agent did: the PM raising something already has it in hand.
    async triage(input: { projectId: string; threadId: string; named?: number; raisedBy?: string | null }): Promise<string | null> {
      if (input.named) return null;
      const pm = await deps.workspace.pm(input.projectId);
      if (pm && pm === input.raisedBy) return null;
      const queued = pm ? await deps.turns.enqueue({ agentId: pm, projectId: input.projectId, kind: 'triage', threadId: input.threadId, dedupeKey: `triage:${input.threadId}` }) : null;
      if (queued) return queued;
      // A refused enqueue is not always a failure: a triage item already waiting on this thread absorbs the new one,
      // and the thread's pending state already names it.
      if (await threadPending(db, input.threadId)) return null;
      const project = await db.selectFrom('projects').select(['team_id', 'parent_id']).where('id', '=', input.projectId).executeTakeFirst();
      const teamId = project?.team_id ?? (project?.parent_id ? (await db.selectFrom('projects').select('team_id').where('id', '=', project.parent_id).executeTakeFirst())?.team_id ?? null : null);
      const seat = teamId ? await db.selectFrom('agents').select(['name', 'status']).where('team_id', '=', teamId).where('is_pm', '=', true).where('status', '!=', 'retired').executeTakeFirst() : undefined;
      await deps.workspace.postMessage({ kind: 'system', id: null }, { id: input.threadId, project_id: input.projectId }, { body: unscheduled({ hasTeam: teamId !== null, pm: seat ?? null }), kind: 'system' });
      return null;
    },
  };
}
export type Answering = ReturnType<typeof createAnswering>;
