import { newId } from '@agent-team/protocol';
import type { Context } from '../context.ts';
import { teamIdOf } from '../repos/issueTasks.ts';
import type { Turns } from './turns.ts';

const WAITING_MS = 8 * 60_000, AGAIN_MS = 60 * 60_000, clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// A teammate with work piling up behind it is the PM's business, without anyone having to say so. When tasks have waited a while behind
// their owner's other work, the PM is shown the picture in the project's discussion and woken to act on it: give a waiting task to a
// teammate who is free and may do it, or, when nobody can, propose hiring. At most once an hour per project.
export function createWorkload(context: Context, turns: Turns) {
  const { storage, events, now } = context, db = storage.db;
  return {
    async nudge(): Promise<number> {
      let nudged = 0;
      const waiting = await db.selectFrom('work_items').innerJoin('tasks', 'tasks.id', 'work_items.task_id').select(['work_items.agent_id', 'work_items.project_id', 'work_items.created_at', 'tasks.key', 'tasks.title'])
        .where('work_items.kind', '=', 'work').where('work_items.state', '=', 'queued').where('work_items.created_at', '<', now() - WAITING_MS).execute();
      for (const projectId of new Set(waiting.map(item => item.project_id))) {
        const mine = waiting.filter(item => item.project_id === projectId), byAgent = new Map<string, typeof mine>();
        for (const item of mine) byAgent.set(item.agent_id, [...(byAgent.get(item.agent_id) ?? []), item]);
        const piled = [...byAgent].filter(([, items]) => items.length >= 2);
        if (piled.length === 0) continue;
        const thread = await db.selectFrom('threads').select('id').where('project_id', '=', projectId).where('kind', '=', 'discussion').executeTakeFirst();
        const teamId = await storage.transaction(tx => teamIdOf(tx, projectId));
        if (!thread || !teamId) continue;
        // Said once an hour at most: the same picture again and again is noise.
        const said = await db.selectFrom('messages').select('id').where('thread_id', '=', thread.id).where('kind', '=', 'system').where('payload', 'like', '%"workload":true%').where('created_at', '>', now() - AGAIN_MS).executeTakeFirst();
        if (said) continue;
        const team = await db.selectFrom('agents').select(['id', 'name', 'title', 'is_pm']).where('team_id', '=', teamId).where('status', '=', 'active').orderBy('sort').execute();
        const pm = team.find(agent => agent.is_pm);
        if (!pm) continue;
        const busy = new Set((await db.selectFrom('work_items').select('agent_id').where('project_id', '=', projectId).where('kind', '=', 'work').where('state', 'in', ['queued', 'leased']).execute()).map(item => item.agent_id));
        const lines = piled.map(([agentId, items]) => `${team.find(agent => agent.id === agentId)?.name ?? 'Someone'} has ${items.length} tasks waiting behind the one in hand (${items.map(item => item.key).join(', ')}); the oldest has waited ${Math.round((now() - Math.min(...items.map(item => Number(item.created_at)))) / 60_000)} minutes.`);
        const free = team.filter(agent => !busy.has(agent.id) && !agent.is_pm).map(agent => `${agent.name} (${agent.title})`);
        const body = clip(`Workload: ${lines.join(' ')} With no work in hand: ${free.join(', ') || 'nobody'}. ${pm.name}: give waiting tasks to a teammate who may do them with task.assign; if nobody free can, propose a hire with proposal.create so the owner can decide.`, 1500);
        const published = await storage.transaction(async tx => {
          const id = newId(now());
          await tx.insertInto('messages').values({ id, thread_id: thread.id, author_kind: 'system', author_id: null, kind: 'system', body, payload: JSON.stringify({ workload: true }), created_at: now() }).execute();
          return events.append(tx, [{ type: 'message.posted', actorKind: 'system', projectId, threadId: thread.id, payload: { messageId: id, kind: 'system' } }]);
        });
        events.published(published);
        await turns.enqueue({ agentId: pm.id, projectId, kind: 'triage', threadId: thread.id, dedupeKey: `workload:${projectId}` });
        nudged++;
      }
      return nudged;
    },

    // Everything the team is doing and just did, in one stream, newest first: what runs now with its latest step, and how recent turns ended.
    async feed(projectId: string, limit = 60) {
      const names = new Map((await db.selectFrom('agents').select(['id', 'name', 'initials', 'tint']).execute()).map(agent => [agent.id, agent]));
      const turnsNow = await db.selectFrom('turns').leftJoin('tasks', 'tasks.id', 'turns.task_id').select(['turns.id', 'turns.agent_id', 'turns.kind', 'turns.state', 'turns.summary', 'turns.stop_reason', 'turns.started_at', 'turns.finished_at', 'tasks.id as task_id', 'tasks.key', 'tasks.title'])
        .where('turns.project_id', '=', projectId).orderBy('turns.started_at', 'desc').limit(40).execute();
      const running = turnsNow.filter(turn => turn.state === 'running');
      const steps = running.length ? await db.selectFrom('trace_steps').select(['turn_id', 'seq', 'at', 'kind', 'title']).where('turn_id', 'in', running.map(turn => turn.id)).orderBy('at', 'desc').limit(limit).execute() : [];
      const who = (id: string) => { const agent = names.get(id); return { id, name: agent?.name ?? 'Someone', initials: agent?.initials ?? '·', tint: agent?.tint ?? '8' }; };
      const task = (turn: (typeof turnsNow)[number]) => (turn.task_id ? { id: turn.task_id, key: turn.key!, title: turn.title! } : null);
      const items = [
        ...steps.map(step => { const turn = running.find(item => item.id === step.turn_id)!; return { id: `${step.turn_id}:${step.seq}`, at: Number(step.at), agent: who(turn.agent_id), task: task(turn), kind: 'step' as const, turnKind: turn.kind, stepKind: step.kind, text: clip(step.title, 220), state: 'running' }; }),
        ...turnsNow.map(turn => ({ id: `${turn.id}:start`, at: Number(turn.started_at), agent: who(turn.agent_id), task: task(turn), kind: 'started' as const, turnKind: turn.kind, stepKind: null, text: '', state: turn.state })),
        ...turnsNow.filter(turn => turn.finished_at).map(turn => ({ id: `${turn.id}:end`, at: Number(turn.finished_at), agent: who(turn.agent_id), task: task(turn), kind: 'finished' as const, turnKind: turn.kind, stepKind: null, text: clip((turn.summary ?? turn.stop_reason ?? '').replace(/\s+/g, ' '), 260), state: turn.state })),
      ].sort((a, b) => b.at - a.at).slice(0, limit);
      return { items, running: running.length };
    },
  };
}
