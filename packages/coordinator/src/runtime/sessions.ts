import type { z } from 'zod';
import { newId, type FinishBody, type SessionBody } from '@agent-team/protocol';
import type { Tx } from '@agent-team/storage';
import type { Context } from '../context.ts';
import { moveTask } from './taskMoves.ts';
import { wayOfWorking } from './wayOfWorking.ts';
import { buildResumeDelta, buildResumePacket, type Packet } from './packet.ts';
import { saysNothing } from './reports.ts';

// A session's input grows with every resumed turn; past this many tokens the next turn starts a new one from a packet.
export const ROTATE_AT_TOKENS = 120_000;
const CONTINUE = 'continue:', REQUEUE = 'resume:', CARRY = 'carry:';
const RETRYABLE = new Set(['crashed', 'context-overflow']);
// An owner carries on with its own task turn after turn. After this many turns in a row that changed nothing, the PM is brought in instead.
export const STALLED_AFTER = 3;
// However busy the turns look, a task that has taken this many of them is looked at by the PM before it takes more: carrying on is
// the owner's right, not an endless one. The count is per owner and task, and every further CHECK_IN_EVERY turns asks again.
export const CHECK_IN_EVERY = 12;

export interface Resume { sessionId: string; prompt: string; baseSha: string | null }
interface TurnRow { id: string; work_item_id: string; agent_id: string; project_id: string; task_id: string | null; kind: string; summary: string | null; session_id: string | null; context_mode: string | null; provider_id?: string | null }
type Outcome = z.infer<typeof FinishBody>['outcome'];

// Engine sessions are scoped to (agent, task). Only work turns have one; bounded turns always start from a fresh packet.
export function createSessions(context: Pick<Context, 'events' | 'now'>) {
  const { events, now } = context;

  async function queueWork(tx: Tx, turn: TurnRow, dedupeKey: string) {
    const id = newId(now());
    await tx.insertInto('work_items').values({ id, agent_id: turn.agent_id, project_id: turn.project_id, kind: 'work', lane: 'work', task_id: turn.task_id, thread_id: null, priority_class: 4, state: 'queued', defer_reason: null, not_before: null, dedupe_key: dedupeKey, cause_event_id: null, created_at: now() }).execute();
    return { type: 'work_item.queued', actorKind: 'system' as const, projectId: turn.project_id, agentId: turn.agent_id, taskId: turn.task_id, payload: { workItemId: id, kind: 'work', cause: dedupeKey.split(':')[0] } };
  }

  // The owner continues: a work turn that ended with a report on a task still in progress, with nothing blocking it and nothing
  // queued for it, is followed at once by the same agent's next turn. Progress is a turn that edited something; after
  // STALLED_AFTER turns in a row without any, nothing is queued and the caller brings the PM in.
  async function carryOn(tx: Tx, turn: TurnRow): Promise<{ requeued: boolean; stalled?: boolean; drafts: Parameters<typeof events.append>[1] }> {
    const task = await tx.selectFrom('tasks').select(['state', 'blocked_reason', 'assignee_agent_id']).where('id', '=', turn.task_id!).executeTakeFirst();
    if (task?.state !== 'in_progress' || task.blocked_reason !== null || task.assignee_agent_id !== turn.agent_id) return { requeued: false, drafts: [] };
    const held = await tx.selectFrom('quarantines').select('id').where('scope', '=', 'task').where('ref_id', '=', turn.task_id!).where('released_at', 'is', null).executeTakeFirst();
    const waiting = await tx.selectFrom('work_items').select('id').where('agent_id', '=', turn.agent_id).where('task_id', '=', turn.task_id!).where('kind', '=', 'work').where('state', '=', 'queued').executeTakeFirst();
    if (held || waiting) return { requeued: false, drafts: [] };
    // Both numbers are the team's own to change, inside their limits, as a trial.
    const { knobs } = await wayOfWorking(tx, turn.project_id);
    const taken = await tx.selectFrom('turns').select(eb => eb.fn.countAll<number>().as('n')).where('task_id', '=', turn.task_id!).where('agent_id', '=', turn.agent_id).where('kind', '=', 'work').executeTakeFirstOrThrow();
    if (Number(taken.n) > 0 && Number(taken.n) % knobs.checkInEvery === 0) return { requeued: false, stalled: true, drafts: [{ actorKind: 'system' as const, projectId: turn.project_id, agentId: turn.agent_id, taskId: turn.task_id, turnId: turn.id, type: 'task.stalled', payload: { turns: Number(taken.n), reason: 'many-turns' } }] };
    const recent = await tx.selectFrom('turns').select('id').where('task_id', '=', turn.task_id!).where('agent_id', '=', turn.agent_id).where('kind', '=', 'work').orderBy('started_at', 'desc').limit(knobs.stalledAfter).execute();
    if (recent.length === knobs.stalledAfter) {
      const edited = await tx.selectFrom('trace_steps').select('turn_id').where('turn_id', 'in', recent.map(row => row.id)).where('kind', '=', 'edit').executeTakeFirst();
      if (!edited) return { requeued: false, stalled: true, drafts: [{ actorKind: 'system' as const, projectId: turn.project_id, agentId: turn.agent_id, taskId: turn.task_id, turnId: turn.id, type: 'task.stalled', payload: { turns: knobs.stalledAfter, reason: 'no-change' } }] };
    }
    return { requeued: true, drafts: [await queueWork(tx, turn, `${CARRY}${turn.id}`)] };
  }

  // A continuation belongs to whoever holds the task now: one that requeued for an owner the task has left would have the old
  // owner pick it up again. A finished task, a blocked one and a reassigned one all wait for their holder instead.
  const stillTheirs = async (tx: Tx, turn: TurnRow): Promise<boolean> => {
    const held = await tx.selectFrom('tasks').select(['state', 'blocked_reason', 'assignee_agent_id']).where('id', '=', turn.task_id!).executeTakeFirst();
    return held?.state === 'in_progress' && held.blocked_reason === null && held.assignee_agent_id === turn.agent_id;
  };

  return {
    // Called inside the claim, after the turn row exists. Decides between resuming the engine session and a packet:
    // `resume` is what a worker whose engine can resume uses, `packet` replaces the default packet when there is history to rebuild.
    async open(tx: Tx, input: { turnId: string; workItemId: string; kind: string; agentId: string; projectId: string; taskId: string | null; workerId: string; providerId: string | null; model: string | null; engine: string | null }): Promise<{ packet: Packet | null; resume: Resume | null; published: Awaited<ReturnType<typeof events.append>> }> {
      if (input.kind !== 'work' || !input.taskId) {
        await tx.updateTable('turns').set({ context_mode: 'packet' }).where('id', '=', input.turnId).execute();
        return { packet: null, resume: null, published: [] };
      }
      const scope = { agentId: input.agentId, projectId: input.projectId, taskId: input.taskId };
      // The route frozen on the turn, not the seat: a rule may have sent this turn to another provider.
      const seat = { provider_id: input.providerId, model: input.model, engine: input.engine };
      const item = await tx.selectFrom('work_items').select('dedupe_key').where('id', '=', input.workItemId).executeTakeFirst();
      const noReport = item?.dedupe_key?.startsWith(CONTINUE) ?? false;
      const active = await tx.selectFrom('agent_sessions').selectAll().where('agent_id', '=', input.agentId).where('task_id', '=', input.taskId).where('state', '=', 'active').orderBy('created_at', 'desc').executeTakeFirst();
      const rotate = !active ? null
        : active.provider_id !== seat.provider_id || active.model !== seat.model || active.engine !== (seat.engine ?? null) ? 'provider-or-model-changed'
        : Number(active.context_tokens) >= ROTATE_AT_TOKENS ? 'context-threshold'
        // The transcript lives on the worker that ran it.
        : active.worker_id !== input.workerId ? 'worker-changed'
        : !active.engine_session_id ? 'no-engine-session' : null;
      if (active && !rotate) {
        await tx.updateTable('turns').set({ session_id: active.id, context_mode: 'resume' }).where('id', '=', input.turnId).execute();
        const prompt = await buildResumeDelta(tx, { ...scope, since: Number(active.last_turn_at), noReport });
        return { packet: await buildResumePacket(tx, { ...scope, noReport }), resume: { sessionId: active.engine_session_id!, prompt, baseSha: active.base_sha }, published: [] };
      }
      if (active) await tx.updateTable('agent_sessions').set({ state: 'rotated' }).where('id', '=', active.id).execute();
      const id = newId(now());
      await tx.insertInto('agent_sessions').values({ id, agent_id: input.agentId, task_id: input.taskId, purpose: 'work', engine: seat.engine ?? null, provider_id: seat.provider_id, model: seat.model, engine_session_id: null, worker_id: input.workerId, state: 'active', context_tokens: 0, turn_count: 0, rotated_from: active?.id ?? null, base_sha: null, created_at: now(), last_turn_at: now() }).execute();
      await tx.updateTable('turns').set({ session_id: id, context_mode: 'packet' }).where('id', '=', input.turnId).execute();
      const earlier = await tx.selectFrom('turns').select('id').where('agent_id', '=', input.agentId).where('task_id', '=', input.taskId).where('kind', '=', 'work').where('id', '!=', input.turnId).executeTakeFirst();
      const published = active ? await events.append(tx, [{ type: 'session.rotated', actorKind: 'system', projectId: input.projectId, agentId: input.agentId, taskId: input.taskId, turnId: input.turnId, payload: { from: active.id, to: id, reason: rotate } }]) : [];
      return { packet: earlier ? await buildResumePacket(tx, { ...scope, noReport }) : null, resume: null, published };
    },

    // The worker names the engine session the moment it knows it, so a crash later in the turn does not lose it.
    async record(tx: Tx, turn: TurnRow, input: Pick<z.infer<typeof SessionBody>, 'sessionId' | 'baseSha'>) {
      if (!turn.session_id) return [];
      await tx.updateTable('agent_sessions').set({ engine_session_id: input.sessionId, ...(input.baseSha ? { base_sha: input.baseSha } : {}) }).where('id', '=', turn.session_id).execute();
      return events.append(tx, [{ type: 'session.recorded', category: 'trace', actorKind: 'worker', projectId: turn.project_id, agentId: turn.agent_id, taskId: turn.task_id, turnId: turn.id, payload: { sessionId: turn.session_id } }]);
    },

    // Called inside finish, before the generic effects. The two failures that continue on their own, each exactly once:
    // a resume that found no session before any output is requeued in packet mode, and a work turn that reported nothing gets one continuation.
    async afterFinish(tx: Tx, turn: TurnRow, outcome: Outcome): Promise<{ requeued: boolean; stalled?: boolean; drafts: Parameters<typeof events.append>[1] }> {
      if (turn.kind !== 'work' || !turn.task_id) return { requeued: false, drafts: [] };
      if (turn.session_id) {
        const session = await tx.selectFrom('agent_sessions').select('turn_count').where('id', '=', turn.session_id).executeTakeFirst();
        await tx.updateTable('agent_sessions').set({ turn_count: Number(session?.turn_count ?? 0) + 1, context_tokens: outcome.contextTokens ?? 0, last_turn_at: now() }).where('id', '=', turn.session_id).execute();
      }
      const base = { actorKind: 'system' as const, projectId: turn.project_id, agentId: turn.agent_id, taskId: turn.task_id, turnId: turn.id };
      if (outcome.stopReason === 'resume-missing') {
        if (turn.session_id) await tx.updateTable('agent_sessions').set({ state: 'lost' }).where('id', '=', turn.session_id).execute();
        const lost = { ...base, type: 'session.lost', payload: { sessionId: turn.session_id } };
        const output = (outcome.tokensOut ?? 0) > 0 || await tx.selectFrom('trace_steps').select('seq').where('turn_id', '=', turn.id).executeTakeFirst();
        // Only a resumed turn can be requeued, and the requeued one has no session to miss: once, by construction — and only while the task is still this agent's.
        if (turn.context_mode !== 'resume' || output || !(await stillTheirs(tx, turn))) return { requeued: false, drafts: [lost] };
        return { requeued: true, drafts: [lost, await queueWork(tx, turn, `${REQUEUE}${turn.id}`)] };
      }
      // Running out of time is not a failure: the process is known to be gone and the worktree holds the work, so the owner carries on
      // from its journal. Twice in a row without a report in between is a task too big for its turns, and that is a person's to see.
      if (outcome.state === 'timed_out') {
        const item = await tx.selectFrom('work_items').select('dedupe_key').where('id', '=', turn.work_item_id).executeTakeFirst();
        if (item?.dedupe_key?.startsWith(`${CARRY}timeout:`) || !(await stillTheirs(tx, turn))) return { requeued: false, drafts: [] };
        return { requeued: true, drafts: [await queueWork(tx, turn, `${CARRY}timeout:${turn.id}`)] };
      }
      // A tool signed out on the worker: the work goes back in the queue behind its provider, which rests until someone may have signed in.
      if (outcome.state === 'failed' && outcome.stopReason === 'auth' && turn.provider_id && await stillTheirs(tx, turn)) return { requeued: true, drafts: [await queueWork(tx, turn, `${CARRY}auth:${turn.id}`)] };
      // A work turn that failed on its own terms (the engine crashed, the context ran over) runs once more with the failure in its packet;
      // a second failure in a row sets the task aside. What cannot change by trying again (a sign-in, the worker's setup, a write outside
      // the task's scope, a push) is not retried. A turn whose outcome is unknown never reaches here: its lease expired instead.
      if (outcome.state === 'failed' && RETRYABLE.has(outcome.stopReason ?? 'crashed')) {
        const item = await tx.selectFrom('work_items').select('dedupe_key').where('id', '=', turn.work_item_id).executeTakeFirst();
        if (item?.dedupe_key?.startsWith(`${CARRY}failed:`) || !(await stillTheirs(tx, turn))) return { requeued: false, drafts: [] };
        // A session that ran out of room is not resumed: the retry starts from the packet in a new one.
        if (outcome.stopReason === 'context-overflow' && turn.session_id) await tx.updateTable('agent_sessions').set({ state: 'rotated' }).where('id', '=', turn.session_id).execute();
        return { requeued: true, drafts: [await queueWork(tx, turn, `${CARRY}failed:${turn.id}`)] };
      }
      // task.update writes the turn's summary; an engine without platform tools reports through its final summary — unless that
      // summary is bare, which is no report at all.
      if (outcome.state === 'completed' && (turn.summary?.trim() || (outcome.summary?.trim() && !saysNothing(outcome.summary)))) return carryOn(tx, turn);
      if (outcome.state !== 'completed') return { requeued: false, drafts: [] };
      if (!(await stillTheirs(tx, turn))) return { requeued: false, drafts: [] };
      const item = await tx.selectFrom('work_items').select('dedupe_key').where('id', '=', turn.work_item_id).executeTakeFirst();
      if (item?.dedupe_key?.startsWith(CONTINUE)) {
        return { requeued: false, drafts: await moveTask(tx, turn.task_id, 'blocked', { set: { blocked_reason: 'no-report' }, now: now(), actor: { actorKind: 'system', agentId: turn.agent_id, turnId: turn.id }, payload: { reason: 'no-report' } }) };
      }
      const waiting = await tx.selectFrom('work_items').select('id').where('agent_id', '=', turn.agent_id).where('task_id', '=', turn.task_id).where('kind', '=', 'work').where('state', '=', 'queued').executeTakeFirst();
      return { requeued: false, drafts: waiting ? [] : [await queueWork(tx, turn, `${CONTINUE}${turn.id}`)] };
    },

    // An orphan found at worker start: its lease is given up at once, so the ordinary expiry marks it uncertain and quarantines what it could have changed.
    async orphaned(tx: Tx, turn: TurnRow) { await tx.updateTable('turns').set({ lease_until: now() - 1 }).where('id', '=', turn.id).execute(); },
  };
}
export type Sessions = ReturnType<typeof createSessions>;
