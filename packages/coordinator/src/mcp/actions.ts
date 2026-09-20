import { newId, type ToolInput } from '@agent-team/protocol';
import type { Tx } from '@agent-team/storage';
import { HttpError, type Context } from '../context.ts';
import type { Turns } from '../runtime/turns.ts';
import { indexMessage } from '../knowledge/indexing.ts';
import { taskFromIssue, teamIdOf } from '../repos/issueTasks.ts';

interface Actor { id: string; agent_id: string; project_id: string; task_id: string | null }
const refuse = (code: string, message: string) => new HttpError(409, code, message);

// What an agent does through a tool and no other module already does: triage decisions, retro notes, task claims and
// handoffs between seats, and issue links. Each is one transaction with its events.
export function createActions(context: Context, turns: Turns) {
  const { storage, events, now } = context;

  async function teammate(tx: Tx, projectId: string, agentId: string) {
    const teamId = await teamIdOf(tx, projectId);
    const seat = teamId ? await tx.selectFrom('agents').select(['id', 'name']).where('id', '=', agentId).where('team_id', '=', teamId).where('status', '=', 'active').executeTakeFirst() : null;
    if (!seat) throw refuse('agent', 'That agent is not an active seat of this team');
    return seat;
  }

  async function post(tx: Tx, threadId: string, agentId: string, kind: string, body: string, payload: Record<string, unknown>) {
    const id = newId(now());
    await tx.insertInto('messages').values({ id, thread_id: threadId, author_kind: 'agent', author_id: agentId, kind, body, payload: JSON.stringify(payload), created_at: now() }).execute();
    await indexMessage(storage, tx, { id, threadId, body });
    return id;
  }

  return {
    // Triage is a deliberation with no reviewers: the decision is a message in the thread, and on an issue it sets owner and priority.
    async triage(turn: Actor, input: ToolInput<'triage.decide'>) {
      const result = await storage.transaction(async tx => {
        const owner = input.ownerAgentId ? await teammate(tx, turn.project_id, input.ownerAgentId) : null;
        if (input.outcome === 'accept' && !owner) throw refuse('triage', 'Accepting needs an owner: pass ownerAgentId');
        const issue = await tx.selectFrom('issues').select(['id', 'state', 'number', 'title', 'body', 'project_id']).where('thread_id', '=', input.threadId).executeTakeFirst();
        const needsHuman = input.outcome === 'escalate', decisionId = newId(now());
        const messageId = await post(tx, input.threadId, turn.agent_id, 'decision', input.decision, { triage: true, outcome: input.outcome, ownerAgentId: owner?.id ?? null, priority: input.priority ?? null });
        await tx.insertInto('decisions').values({ id: decisionId, project_id: turn.project_id, thread_id: input.threadId, message_id: messageId, deliberation_id: null, kind: 'triage', outcome: input.outcome, summary: input.decision, needs_human: needsHuman, resolved_by_user: null, resolved_at: null, created_at: now() }).execute();
        const closes = input.outcome === 'decline' || input.outcome === 'duplicate';
        if (issue) await tx.updateTable('issues').set({ ...(owner ? { owner_agent_id: owner.id } : {}), ...(input.priority ? { priority: input.priority } : {}), ...(closes && issue.state === 'open' ? { state: 'closed', closed_at: now() } : {}) }).where('id', '=', issue.id).execute();
        const made = issue && owner && input.outcome === 'accept' ? await taskFromIssue(tx, { issue, ownerId: owner.id, authorAgentId: turn.agent_id, actor: { actorKind: 'agent', agentId: turn.agent_id, turnId: turn.id }, now: now() }) : { taskId: null, events: [] };
        const taskId = made.taskId;
        const drafts = [{ type: 'decision.recorded', actorKind: 'agent' as const, agentId: turn.agent_id, projectId: turn.project_id, threadId: input.threadId, turnId: turn.id, payload: { decisionId, outcome: input.outcome, needsHuman, issueId: issue?.id ?? null } }, { type: 'message.posted', actorKind: 'agent' as const, agentId: turn.agent_id, projectId: turn.project_id, threadId: input.threadId, payload: { messageId, kind: 'decision' } }];
        const more = [...(issue && closes && issue.state === 'open' ? [{ type: 'issue.closed', actorKind: 'agent' as const, agentId: turn.agent_id, projectId: turn.project_id, threadId: input.threadId, payload: { issueId: issue.id } }] : []), ...made.events];
        return { decisionId, messageId, taskId, ownerId: owner?.id ?? null, projectId: issue?.project_id ?? turn.project_id, published: await events.append(tx, [...drafts, ...more]) };
      });
      events.published(result.published);
      // The owner starts on it like on any assigned task.
      if (result.taskId && result.ownerId) await turns.enqueue({ agentId: result.ownerId, projectId: result.projectId, kind: 'work', taskId: result.taskId, dedupeKey: `work:${result.taskId}` });
      return { decisionId: result.decisionId, messageId: result.messageId, taskId: result.taskId };
    },

    // One structured note per seat in the retro thread; the PM reads them and turns at most three into proposals.
    async retro(turn: Actor, threadId: string, input: ToolInput<'retro.submit'>) {
      const result = await storage.transaction(async tx => {
        const body = [`Went well: ${input.wentWell}`, ...input.problems.map((item, index) => `${index + 1}. ${item.problem}\n   Evidence: ${item.evidence}\n   Suggestion: ${item.suggestion}`)].join('\n');
        const messageId = await post(tx, threadId, turn.agent_id, 'note', body, { retro: true, ...input });
        return { messageId, published: await events.append(tx, [{ type: 'retro.submitted', actorKind: 'agent', agentId: turn.agent_id, projectId: turn.project_id, threadId, turnId: turn.id, payload: { messageId, problems: input.problems.length } }, { type: 'message.posted', actorKind: 'agent', agentId: turn.agent_id, projectId: turn.project_id, threadId, payload: { messageId, kind: 'note' } }]) };
      });
      events.published(result.published);
      return { messageId: result.messageId };
    },

    // Atomic: the update only matches a task nobody holds, so of two claimants exactly one gets it.
    async claim(turn: Actor, taskId: string) {
      const result = await storage.transaction(async tx => {
        const task = await tx.selectFrom('tasks').select(['id', 'key', 'state']).where('id', '=', taskId).where('project_id', '=', turn.project_id).executeTakeFirst();
        if (!task) throw refuse('task', 'Task not found in this project');
        const claimed = await tx.updateTable('tasks').set({ assignee_agent_id: turn.agent_id, state: 'assigned', updated_at: now() }).where('id', '=', taskId).where('assignee_agent_id', 'is', null).where('state', '=', 'backlog').executeTakeFirst();
        if (Number(claimed.numUpdatedRows) !== 1) throw refuse('task', `${task.key} is already taken or no longer in the backlog`);
        return { key: task.key, published: await events.append(tx, [{ type: 'task.assigned', actorKind: 'agent', agentId: turn.agent_id, projectId: turn.project_id, taskId, turnId: turn.id, payload: { claimed: true } }]) };
      });
      events.published(result.published);
      await turns.enqueue({ agentId: turn.agent_id, projectId: turn.project_id, kind: 'work', taskId, dedupeKey: `work:${taskId}` });
      return { taskId, key: result.key, state: 'assigned' };
    },

    // The task changes seat with a note of what was done and what is left; the receiver starts from that summary.
    async handoff(turn: Actor, input: ToolInput<'task.handoff'>) {
      if (!turn.task_id) throw refuse('task', 'This turn has no task');
      const taskId = turn.task_id;
      if (input.toAgentId === turn.agent_id) throw refuse('task', 'You already hold this task');
      const published = await storage.transaction(async tx => {
        const to = await teammate(tx, turn.project_id, input.toAgentId);
        const task = await tx.selectFrom('tasks').select(['key', 'assignee_agent_id']).where('id', '=', taskId).executeTakeFirstOrThrow();
        if (task.assignee_agent_id !== turn.agent_id) throw refuse('task', `${task.key} is not yours to hand over`);
        await tx.updateTable('tasks').set({ assignee_agent_id: to.id, updated_at: now() }).where('id', '=', taskId).execute();
        await tx.updateTable('turns').set({ summary: input.summary }).where('id', '=', turn.id).execute();
        const thread = await tx.selectFrom('threads').select('id').where('project_id', '=', turn.project_id).where('kind', '=', 'discussion').executeTakeFirst();
        const drafts = [{ type: 'task.handed_off', actorKind: 'agent' as const, agentId: turn.agent_id, projectId: turn.project_id, taskId, turnId: turn.id, payload: { to: to.id, summary: input.summary } }];
        if (!thread) return events.append(tx, drafts);
        const messageId = await post(tx, thread.id, turn.agent_id, 'handoff', `${task.key} goes to ${to.name}. ${input.summary}`, { taskId, to: to.id });
        return events.append(tx, [...drafts, { type: 'message.posted', actorKind: 'agent' as const, agentId: turn.agent_id, projectId: turn.project_id, threadId: thread.id, payload: { messageId, kind: 'handoff' } }]);
      });
      events.published(published);
      await turns.enqueue({ agentId: input.toAgentId, projectId: turn.project_id, kind: 'work', taskId, dedupeKey: `work:${taskId}:${input.toAgentId}` });
      return { taskId, assigneeAgentId: input.toAgentId };
    },

    // Both ends are checked by the caller to be in the turn's project; linking twice is the same link.
    async link(turn: Actor, issueId: string, to: { type: string; id: string }, rel: string) {
      const published = await storage.transaction(async tx => {
        await tx.insertInto('links').values({ from_type: 'issue', from_id: issueId, to_type: to.type, to_id: to.id, rel, created_at: now() }).onConflict(oc => oc.columns(['from_type', 'from_id', 'to_type', 'to_id', 'rel']).doNothing()).execute();
        return events.append(tx, [{ type: 'link.added', actorKind: 'agent', agentId: turn.agent_id, projectId: turn.project_id, turnId: turn.id, payload: { from: { type: 'issue', id: issueId }, to, rel } }]);
      });
      events.published(published);
    },
  };
}
export type Actions = ReturnType<typeof createActions>;
