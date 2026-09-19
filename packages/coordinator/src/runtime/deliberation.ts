import { FEEDBACK_WINDOW_MS, MAX_REVIEWERS, needsRevision, newId, quorum, type Conclusion, type FeedbackBlock, type MessageKind, type Proposal } from '@agent-team/protocol';
import type { z } from 'zod';
import type { Revision } from '@agent-team/protocol';
import type { Tx } from '@agent-team/storage';
import { HttpError, type Context } from '../context.ts';
import type { Turns } from './turns.ts';

const conflict = (message: string) => new HttpError(409, 'deliberation', message);

// Proposal, one feedback block per reviewer in parallel, at most one revision, then a decision by the PM.
export function createDeliberation(context: Context, turns: Turns) {
  const { storage, events, now } = context;
  const db = storage.db;

  async function post(tx: Tx, threadId: string, agentId: string, kind: MessageKind, body: string, payload: Record<string, unknown>) {
    const id = newId(now());
    await tx.insertInto('messages').values({ id, thread_id: threadId, author_kind: 'agent', author_id: agentId, kind, body, payload: JSON.stringify(payload), created_at: now() }).execute();
    return id;
  }

  // Deterministic, no model: named reviewers first, then teammates by seat order; never the proposer or the decider.
  async function selectReviewers(tx: Tx, projectId: string, proposerId: string, deciderId: string | null, named: string[]) {
    const project = await tx.selectFrom('projects').select(['team_id', 'parent_id']).where('id', '=', projectId).executeTakeFirstOrThrow();
    const teamId = project.team_id ?? (project.parent_id ? (await tx.selectFrom('projects').select('team_id').where('id', '=', project.parent_id).executeTakeFirst())?.team_id : null);
    if (!teamId) return [];
    const seats = await tx.selectFrom('agents').select(['id', 'name']).where('team_id', '=', teamId).where('status', '=', 'active').orderBy('sort').execute();
    const eligible = seats.filter(seat => seat.id !== proposerId && seat.id !== deciderId);
    const wanted = eligible.filter(seat => named.includes(seat.id) || named.includes(seat.name));
    return [...wanted, ...eligible.filter(seat => !wanted.includes(seat))].slice(0, MAX_REVIEWERS).map(seat => seat.id);
  }

  // Moves an open deliberation on once feedback is in (or its window closed): a single revision if asked for, else the decision.
  async function advance(tx: Tx, deliberationId: string) {
    const row = await tx.selectFrom('deliberations').selectAll().where('id', '=', deliberationId).executeTakeFirstOrThrow();
    if (row.state !== 'open') return [];
    const participants = await tx.selectFrom('deliberation_participants').selectAll().where('deliberation_id', '=', deliberationId).execute();
    const answered = participants.filter(participant => participant.state === 'answered');
    const closed = Number(row.feedback_deadline) <= now();
    if (answered.length < participants.length && !closed) return [];
    if (closed && answered.length < quorum(participants.length) && !row.extended) {
      await tx.updateTable('deliberations').set({ extended: true, feedback_deadline: now() + (Number(row.feedback_deadline) - Number(row.created_at)) / 2 }).where('id', '=', deliberationId).execute();
      return [];
    }
    // A reviewer who never answered counts as an abstention; its turn is not retried.
    await tx.updateTable('deliberation_participants').set({ state: 'abstained' }).where('deliberation_id', '=', deliberationId).where('state', '=', 'pending').execute();
    const blocks = [];
    for (const participant of answered) {
      const message = participant.message_id ? await tx.selectFrom('messages').select('payload').where('id', '=', participant.message_id).executeTakeFirst() : null;
      blocks.push({ stance: participant.stance ?? 'neutral', blocking: participant.is_blocking, conditions: ((JSON.parse(message?.payload ?? '{}') as { conditions?: unknown[] }).conditions ?? []).length });
    }
    const revise = !row.revised && needsRevision(blocks);
    await tx.updateTable('deliberations').set({ state: revise ? 'revising' : 'deciding' }).where('id', '=', deliberationId).execute();
    return events.append(tx, [{ type: revise ? 'deliberation.revision_requested' : 'deliberation.feedback_closed', actorKind: 'system', projectId: row.project_id, threadId: row.thread_id, payload: { deliberationId, next: revise ? row.proposer_agent_id : row.decider_agent_id } }]);
  }

  async function wake(deliberationId: string) {
    const row = await db.selectFrom('deliberations').selectAll().where('id', '=', deliberationId).executeTakeFirstOrThrow();
    const next = row.state === 'revising' ? { agentId: row.proposer_agent_id, kind: 'revise' as const } : row.state === 'deciding' && row.decider_agent_id ? { agentId: row.decider_agent_id, kind: 'conclude' as const } : null;
    if (next) await turns.enqueue({ ...next, projectId: row.project_id, threadId: row.thread_id, taskId: row.task_id, dedupeKey: `${next.kind}:${deliberationId}` });
  }

  return {
    async propose(turn: { agent_id: string; project_id: string; task_id: string | null }, threadId: string, input: Proposal) {
      const result = await storage.transaction(async tx => {
        if (turn.task_id && await tx.selectFrom('deliberations').select('id').where('task_id', '=', turn.task_id).where('state', 'in', ['open', 'revising', 'deciding']).executeTakeFirst()) throw conflict('This task already has an open deliberation');
        const project = await tx.selectFrom('projects').select(['team_id', 'parent_id']).where('id', '=', turn.project_id).executeTakeFirstOrThrow();
        const teamId = project.team_id ?? (project.parent_id ? (await tx.selectFrom('projects').select('team_id').where('id', '=', project.parent_id).executeTakeFirst())?.team_id ?? null : null);
        const pm = teamId ? await tx.selectFrom('agents').select('id').where('team_id', '=', teamId).where('is_pm', '=', true).where('status', '=', 'active').executeTakeFirst() : null;
        const reviewers = await selectReviewers(tx, turn.project_id, turn.agent_id, pm?.id ?? null, input.reviewers);
        const id = newId(now());
        await tx.insertInto('deliberations').values({ id, project_id: turn.project_id, thread_id: threadId, kind: 'design', task_id: turn.task_id, question: input.question, proposer_agent_id: turn.agent_id, decider_agent_id: pm?.id ?? null, state: reviewers.length ? 'open' : 'deciding', revised: false, blocking: input.urgency === 'blocking', feedback_deadline: now() + FEEDBACK_WINDOW_MS[input.urgency], extended: false, created_at: now() }).execute();
        for (const agentId of reviewers) await tx.insertInto('deliberation_participants').values({ deliberation_id: id, agent_id: agentId, state: 'pending', stance: null, is_blocking: false, message_id: null }).execute();
        await post(tx, threadId, turn.agent_id, 'proposal', `${input.question}\n\n${input.summary}`, { deliberationId: id, ...input });
        if (input.urgency === 'blocking' && turn.task_id) await tx.updateTable('tasks').set({ state: 'awaiting_decision', updated_at: now() }).where('id', '=', turn.task_id).execute();
        const published = await events.append(tx, [{ type: 'deliberation.opened', actorKind: 'agent', agentId: turn.agent_id, projectId: turn.project_id, threadId, taskId: turn.task_id, payload: { deliberationId: id, reviewers } }, { type: 'message.posted', actorKind: 'agent', agentId: turn.agent_id, projectId: turn.project_id, threadId, payload: { kind: 'proposal' } }]);
        return { id, reviewers, published };
      });
      events.published(result.published);
      // Feedback turns run in parallel; each reviewer answers once, without seeing the others.
      for (const agentId of result.reviewers) await turns.enqueue({ agentId, projectId: turn.project_id, kind: 'feedback', threadId, taskId: turn.task_id, dedupeKey: `feedback:${result.id}:${agentId}` });
      if (result.reviewers.length === 0) await wake(result.id);
      return { deliberationId: result.id, reviewers: result.reviewers, endTurn: input.urgency === 'blocking' };
    },

    async feedback(turn: { agent_id: string }, deliberationId: string, block: FeedbackBlock) {
      const published = await storage.transaction(async tx => {
        const row = await tx.selectFrom('deliberations').selectAll().where('id', '=', deliberationId).executeTakeFirst();
        const seat = await tx.selectFrom('deliberation_participants').selectAll().where('deliberation_id', '=', deliberationId).where('agent_id', '=', turn.agent_id).executeTakeFirst();
        if (!row || !seat) throw conflict('You are not a reviewer of this deliberation');
        if (row.state !== 'open' || seat.state !== 'pending') throw conflict('Feedback is closed; one block per reviewer');
        const messageId = await post(tx, row.thread_id, turn.agent_id, 'feedback', block.points.join(' '), { deliberationId, ...block });
        await tx.updateTable('deliberation_participants').set({ state: 'answered', stance: block.stance, is_blocking: block.blocking, message_id: messageId }).where('deliberation_id', '=', deliberationId).where('agent_id', '=', turn.agent_id).execute();
        const posted = await events.append(tx, [{ type: 'message.posted', actorKind: 'agent', agentId: turn.agent_id, projectId: row.project_id, threadId: row.thread_id, payload: { kind: 'feedback' } }]);
        return [...posted, ...await advance(tx, deliberationId)];
      });
      events.published(published);
      await wake(deliberationId);
    },

    // Standing aside is a reviewer's one answer too: an abstention with its reason on the record, and the deliberation moves on.
    async stand(turn: { agent_id: string }, deliberationId: string, reason: string) {
      const published = await storage.transaction(async tx => {
        const row = await tx.selectFrom('deliberations').selectAll().where('id', '=', deliberationId).executeTakeFirst();
        const seat = await tx.selectFrom('deliberation_participants').selectAll().where('deliberation_id', '=', deliberationId).where('agent_id', '=', turn.agent_id).executeTakeFirst();
        if (!row || !seat) throw conflict('You are not a reviewer of this deliberation');
        if (row.state !== 'open' || seat.state !== 'pending') throw conflict('Feedback is closed; one block per reviewer');
        await tx.updateTable('deliberation_participants').set({ state: 'abstained' }).where('deliberation_id', '=', deliberationId).where('agent_id', '=', turn.agent_id).execute();
        const stood = await events.append(tx, [{ type: 'deliberation.stood_aside', actorKind: 'agent', agentId: turn.agent_id, projectId: row.project_id, threadId: row.thread_id, payload: { deliberationId, reason } }]);
        return [...stood, ...await advance(tx, deliberationId)];
      });
      events.published(published);
      await wake(deliberationId);
    },

    async revise(turn: { agent_id: string }, deliberationId: string, input: z.infer<typeof Revision>) {
      const published = await storage.transaction(async tx => {
        const row = await tx.selectFrom('deliberations').selectAll().where('id', '=', deliberationId).executeTakeFirst();
        if (!row || row.proposer_agent_id !== turn.agent_id) throw conflict('Only the proposer revises');
        if (row.state !== 'revising' || row.revised) throw conflict('A proposal is revised at most once');
        await post(tx, row.thread_id, turn.agent_id, 'revision', `${input.summary}\n\nChanged: ${input.changes}`, { deliberationId, ...input });
        await tx.updateTable('deliberations').set({ revised: true, state: 'deciding' }).where('id', '=', deliberationId).execute();
        return events.append(tx, [{ type: 'message.posted', actorKind: 'agent', agentId: turn.agent_id, projectId: row.project_id, threadId: row.thread_id, payload: { kind: 'revision' } }]);
      });
      events.published(published);
      await wake(deliberationId);
    },

    async conclude(turn: { agent_id: string }, deliberationId: string, input: Conclusion) {
      const published = await storage.transaction(async tx => {
        const row = await tx.selectFrom('deliberations').selectAll().where('id', '=', deliberationId).executeTakeFirst();
        if (!row || row.decider_agent_id !== turn.agent_id) throw conflict('Only the decider concludes');
        if (row.state !== 'deciding') throw conflict(`The deliberation is ${row.state}`);
        // Every objection must be answered in the decision, so disagreement is never silently dropped.
        const objectors = await tx.selectFrom('deliberation_participants').select('agent_id').where('deliberation_id', '=', deliberationId).where(eb => eb.or([eb('stance', '=', 'against'), eb('is_blocking', '=', true)])).execute();
        const missing = objectors.filter(objector => !input.dissent.some(item => item.agentId === objector.agent_id));
        if (missing.length) throw conflict(`Address the dissent of: ${missing.map(item => item.agent_id).join(', ')}`);
        const needsHuman = input.outcome === 'escalate';
        const messageId = await post(tx, row.thread_id, turn.agent_id, 'decision', input.decision, { deliberationId, ...input });
        const decisionId = newId(now());
        await tx.insertInto('decisions').values({ id: decisionId, project_id: row.project_id, thread_id: row.thread_id, message_id: messageId, deliberation_id: deliberationId, kind: row.kind, outcome: input.outcome, summary: input.decision, needs_human: needsHuman, resolved_by_user: null, resolved_at: null, created_at: now() }).execute();
        await tx.updateTable('deliberations').set({ state: needsHuman ? 'escalated' : 'decided' }).where('id', '=', deliberationId).execute();
        if (row.task_id && !needsHuman) await tx.updateTable('tasks').set({ state: 'in_progress', updated_at: now() }).where('id', '=', row.task_id).where('state', '=', 'awaiting_decision').execute();
        return events.append(tx, [{ type: 'decision.recorded', actorKind: 'agent', agentId: turn.agent_id, projectId: row.project_id, threadId: row.thread_id, taskId: row.task_id, payload: { decisionId, outcome: input.outcome, needsHuman } }, { type: 'message.posted', actorKind: 'agent', agentId: turn.agent_id, projectId: row.project_id, threadId: row.thread_id, payload: { kind: 'decision' } }]);
      });
      events.published(published);
    },

    // Closes feedback windows that ran out; called on a timer.
    async sweep() {
      const due = await db.selectFrom('deliberations').select('id').where('state', '=', 'open').where('feedback_deadline', '<=', now()).execute();
      for (const row of due) { events.published(await storage.transaction(tx => advance(tx, row.id))); await wake(row.id); }
    },
  };
}
export type Deliberation = ReturnType<typeof createDeliberation>;
