import type { z } from 'zod';
import { newId, type FinishBody, type SessionBody } from '@agent-team/protocol';
import type { Tx } from '@agent-team/storage';
import type { Context } from '../context.ts';
import { buildResumeDelta, buildResumePacket, type Packet } from './packet.ts';

// A session's input grows with every resumed turn; past this many tokens the next turn starts a new one from a packet.
export const ROTATE_AT_TOKENS = 120_000;
const CONTINUE = 'continue:', REQUEUE = 'resume:';

export interface Resume { sessionId: string; prompt: string; baseSha: string | null }
interface TurnRow { id: string; work_item_id: string; agent_id: string; project_id: string; task_id: string | null; kind: string; summary: string | null; session_id: string | null; context_mode: string | null }
type Outcome = z.infer<typeof FinishBody>['outcome'];

// Engine sessions are scoped to (agent, task). Only work turns have one; bounded turns always start from a fresh packet.
export function createSessions(context: Pick<Context, 'events' | 'now'>) {
  const { events, now } = context;

  async function queueWork(tx: Tx, turn: TurnRow, dedupeKey: string) {
    const id = newId(now());
    await tx.insertInto('work_items').values({ id, agent_id: turn.agent_id, project_id: turn.project_id, kind: 'work', lane: 'work', task_id: turn.task_id, thread_id: null, priority_class: 4, state: 'queued', defer_reason: null, not_before: null, dedupe_key: dedupeKey, cause_event_id: null, created_at: now() }).execute();
    return { type: 'work_item.queued', actorKind: 'system' as const, projectId: turn.project_id, agentId: turn.agent_id, taskId: turn.task_id, payload: { workItemId: id, kind: 'work', cause: dedupeKey.split(':')[0] } };
  }

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
    async afterFinish(tx: Tx, turn: TurnRow, outcome: Outcome): Promise<{ requeued: boolean; drafts: Parameters<typeof events.append>[1] }> {
      if (turn.kind !== 'work' || !turn.task_id) return { requeued: false, drafts: [] };
      if (turn.session_id) {
        const session = await tx.selectFrom('agent_sessions').select('turn_count').where('id', '=', turn.session_id).executeTakeFirst();
        await tx.updateTable('agent_sessions').set({ turn_count: Number(session?.turn_count ?? 0) + 1, context_tokens: outcome.tokensIn ?? 0, last_turn_at: now() }).where('id', '=', turn.session_id).execute();
      }
      const base = { actorKind: 'system' as const, projectId: turn.project_id, agentId: turn.agent_id, taskId: turn.task_id, turnId: turn.id };
      if (outcome.stopReason === 'resume-missing') {
        if (turn.session_id) await tx.updateTable('agent_sessions').set({ state: 'lost' }).where('id', '=', turn.session_id).execute();
        const lost = { ...base, type: 'session.lost', payload: { sessionId: turn.session_id } };
        const output = (outcome.tokensOut ?? 0) > 0 || await tx.selectFrom('trace_steps').select('seq').where('turn_id', '=', turn.id).executeTakeFirst();
        // Only a resumed turn can be requeued, and the requeued one has no session to miss: once, by construction.
        if (turn.context_mode !== 'resume' || output) return { requeued: false, drafts: [lost] };
        return { requeued: true, drafts: [lost, await queueWork(tx, turn, `${REQUEUE}${turn.id}`)] };
      }
      // task.update writes the turn's summary; an engine without platform tools reports through its final summary.
      if (outcome.state !== 'completed' || turn.summary?.trim() || outcome.summary?.trim()) return { requeued: false, drafts: [] };
      const item = await tx.selectFrom('work_items').select('dedupe_key').where('id', '=', turn.work_item_id).executeTakeFirst();
      if (item?.dedupe_key?.startsWith(CONTINUE)) {
        await tx.updateTable('tasks').set({ state: 'blocked', blocked_reason: 'no-report', updated_at: now() }).where('id', '=', turn.task_id).execute();
        return { requeued: false, drafts: [{ ...base, type: 'task.state_changed', payload: { to: 'blocked', reason: 'no-report' } }] };
      }
      const waiting = await tx.selectFrom('work_items').select('id').where('agent_id', '=', turn.agent_id).where('task_id', '=', turn.task_id).where('kind', '=', 'work').where('state', '=', 'queued').executeTakeFirst();
      return { requeued: false, drafts: waiting ? [] : [await queueWork(tx, turn, `${CONTINUE}${turn.id}`)] };
    },

    // An orphan found at worker start: its lease is given up at once, so the ordinary expiry marks it uncertain and quarantines what it could have changed.
    async orphaned(tx: Tx, turn: TurnRow) { await tx.updateTable('turns').set({ lease_until: now() - 1 }).where('id', '=', turn.id).execute(); },
  };
}
export type Sessions = ReturnType<typeof createSessions>;
