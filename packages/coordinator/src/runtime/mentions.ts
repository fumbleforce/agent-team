import { newId, type MentionExpects, type MentionTarget } from '@agent-team/protocol';
import type { Tx } from '@agent-team/storage';
import { HttpError, type Context } from '../context.ts';
import type { Turns } from './turns.ts';

export const MAX_MENTION_DEPTH = 2;
export const MAX_WAKES_PER_HOUR = 2;
const HOUR_MS = 3600_000;
const refuse = (message: string) => new HttpError(409, 'mention', message);

export interface MentionInput { projectId: string; threadId: string; message: { id: string } | { body: string }; author: { kind: 'user' | 'agent'; id: string }; targets: MentionTarget[]; expects: MentionExpects; turnId?: string | null }
export interface MentionOutcome { mentionId: string; target: MentionTarget; agentId: string | null; state: 'woken' | 'noted' | 'overflow'; reason: string | null }

// Pure: whether a mention may wake its agent. Depth is 1 for a first request, 2 for a mention made while answering one.
export function admit(input: { depth: number; wakesLastHour: number }): 'wake' | 'depth' | 'rate' {
  return input.depth > MAX_MENTION_DEPTH ? 'depth' : input.wakesLastHour >= MAX_WAKES_PER_HOUR ? 'rate' : 'wake';
}

// @name tokens of a message, as written. What they name is resolved against the team, so an unknown word is just text.
export const mentionTokens = (body: string): string[] => [...new Set([...body.matchAll(/(?:^|[\s(])@([A-Za-z][\w-]{0,40})/g)].map(match => match[1]!.toLowerCase()))];

// A mention is a directed request with exactly one reply turn. Chains stop at depth two and an agent is woken at most
// twice an hour per thread; whatever exceeds that becomes one triage item for the PM instead of more wakes.
export function createMentions(context: Context, turns: Turns) {
  const { storage, events, now } = context;

  async function team(tx: Tx, projectId: string) {
    const project = await tx.selectFrom('projects').select(['team_id', 'parent_id']).where('id', '=', projectId).executeTakeFirstOrThrow();
    const teamId = project.team_id ?? (project.parent_id ? (await tx.selectFrom('projects').select('team_id').where('id', '=', project.parent_id).executeTakeFirst())?.team_id ?? null : null);
    return teamId ? tx.selectFrom('agents').select(['id', 'name', 'is_pm']).where('team_id', '=', teamId).where('status', '=', 'active').orderBy('sort').execute() : [];
  }

  async function resolve(tx: Tx, seats: { id: string; name: string }[], target: MentionTarget): Promise<string[]> {
    if (target.type === 'agent') return seats.filter(seat => seat.id === target.id || seat.name.toLowerCase() === target.id.toLowerCase()).map(seat => seat.id);
    if (target.type === 'team') return seats.map(seat => seat.id);
    if (target.type === 'user') return [];
    const holders = seats.length ? await tx.selectFrom('agent_roles').select('agent_id').where('role_slug', '=', target.id).where('agent_id', 'in', seats.map(seat => seat.id)).execute() : [];
    return seats.filter(seat => holders.some(holder => holder.agent_id === seat.id)).map(seat => seat.id);
  }

  async function mention(input: MentionInput): Promise<{ messageId: string; mentions: MentionOutcome[] }> {
    const result = await storage.transaction(async tx => {
      const seats = await team(tx, input.projectId);
      // A mention made from the reply turn of another mention is one level deeper than the one being answered.
      const turn = input.turnId ? await tx.selectFrom('turns').select('work_item_id').where('id', '=', input.turnId).executeTakeFirst() : null;
      const parent = turn ? await tx.selectFrom('mentions').select('depth').where('work_item_id', '=', turn.work_item_id).executeTakeFirst() : null;
      const depth = (parent?.depth ?? 0) + 1;
      const outcomes: MentionOutcome[] = [], drafts = [];
      // An agent's mention is its message: both are written here, so a refused target leaves nothing behind.
      const messageId = 'id' in input.message ? input.message.id : newId(now());
      if ('body' in input.message) {
        await tx.insertInto('messages').values({ id: messageId, thread_id: input.threadId, author_kind: input.author.kind, author_id: input.author.id, kind: 'question', body: input.message.body, payload: JSON.stringify({ mentions: input.targets, expects: input.expects }), created_at: now() }).execute();
        drafts.push({ type: 'message.posted', actorKind: input.author.kind, userId: input.author.kind === 'user' ? input.author.id : null, agentId: input.author.kind === 'agent' ? input.author.id : null, projectId: input.projectId, threadId: input.threadId, payload: { messageId, kind: 'question' } });
      }
      const planned = new Map<string, number>();
      for (const target of input.targets) {
        const agentIds = (await resolve(tx, seats, target)).filter(id => !(input.author.kind === 'agent' && id === input.author.id));
        if (target.type !== 'user' && agentIds.length === 0) throw refuse(`Nobody on this team answers to ${target.type} ${target.id}`);
        for (const agentId of target.type === 'user' ? [null] : agentIds) {
          if (agentId && outcomes.some(outcome => outcome.agentId === agentId)) continue;
          const mentionId = newId(now());
          let state: MentionOutcome['state'] = 'noted', reason: string | null = null;
          if (agentId && input.expects === 'reply') {
            // Every queued reason to run in this thread counts as a wake, whatever caused it.
            const recent = await tx.selectFrom('work_items').select(eb => eb.fn.countAll<number>().as('n')).where('agent_id', '=', agentId).where('thread_id', '=', input.threadId).where('created_at', '>', now() - HOUR_MS).executeTakeFirstOrThrow();
            const verdict = admit({ depth, wakesLastHour: Number(recent.n) + (planned.get(agentId) ?? 0) });
            state = verdict === 'wake' ? 'woken' : 'overflow';
            reason = verdict === 'wake' ? null : verdict;
            if (verdict === 'wake') planned.set(agentId, (planned.get(agentId) ?? 0) + 1);
          }
          await tx.insertInto('mentions').values({ id: mentionId, message_id: messageId, thread_id: input.threadId, project_id: input.projectId, author_kind: input.author.kind, author_id: input.author.id, target_type: target.type, target_id: target.id, agent_id: agentId, expects: input.expects, state: state === 'woken' ? 'pending' : state, depth, work_item_id: null, reply_message_id: null, created_at: now() }).execute();
          drafts.push({ type: state === 'overflow' ? 'mention.overflowed' : 'mention.created', actorKind: input.author.kind, userId: input.author.kind === 'user' ? input.author.id : null, agentId: input.author.kind === 'agent' ? input.author.id : agentId, projectId: input.projectId, threadId: input.threadId, payload: { mentionId, target, agentId, depth, reason } });
          outcomes.push({ mentionId, target, agentId, state, reason });
        }
      }
      return { messageId, outcomes, pm: seats.find(seat => seat.is_pm)?.id ?? null, published: drafts.length ? await events.append(tx, drafts) : [] };
    });
    events.published(result.published);
    // The work item and the mention that caused it are written together, so a reply turn always finds its mention.
    for (const outcome of result.outcomes) if (outcome.state === 'woken' && outcome.agentId) await turns.enqueue({ agentId: outcome.agentId, projectId: input.projectId, kind: 'reply', threadId: input.threadId, dedupeKey: `mention:${outcome.mentionId}`, prepare: async (tx, workItemId) => { await tx.updateTable('mentions').set({ state: 'woken', work_item_id: workItemId }).where('id', '=', outcome.mentionId).execute(); } });
    if (result.pm && result.outcomes.some(outcome => outcome.state === 'overflow')) await turns.enqueue({ agentId: result.pm, projectId: input.projectId, kind: 'triage', threadId: input.threadId, dedupeKey: `triage:${input.threadId}` });
    return { messageId: result.messageId, mentions: result.outcomes };
  }

  return {
    mention,

    // What a human types: @name and @role tokens that name someone on the team become mentions; the rest stays text.
    async fromText(input: Omit<MentionInput, 'targets' | 'expects'> & { body: string }): Promise<MentionOutcome[]> {
      const tokens = mentionTokens(input.body);
      if (tokens.length === 0) return [];
      const targets = await storage.transaction(async tx => {
        const seats = await team(tx, input.projectId);
        const found: MentionTarget[] = [];
        for (const token of tokens) {
          const seat = seats.find(item => item.name.toLowerCase() === token);
          if (seat) found.push({ type: 'agent', id: seat.id });
          else if (token === 'team') found.push({ type: 'team', id: 'team' });
          else if ((await resolve(tx, seats, { type: 'role', id: token })).length) found.push({ type: 'role', id: token });
        }
        return found;
      });
      const { body: _body, ...rest } = input;
      return targets.length ? (await mention({ ...rest, targets, expects: 'reply' })).mentions : [];
    },

    // The mention a reply turn owes its one answer to, if any.
    async owedBy(turnId: string) {
      return (await storage.db.selectFrom('mentions').innerJoin('turns', 'turns.work_item_id', 'mentions.work_item_id').select(['mentions.id', 'mentions.state', 'mentions.thread_id']).where('turns.id', '=', turnId).executeTakeFirst()) ?? null;
    },

    // Exactly one reply: the first answer closes the mention, a second is refused.
    async answer(mentionId: string, messageId: string) {
      const published = await storage.transaction(async tx => {
        const row = await tx.selectFrom('mentions').selectAll().where('id', '=', mentionId).executeTakeFirst();
        if (!row || row.state !== 'woken') throw refuse('This mention is already answered; a mention gets one reply');
        await tx.updateTable('mentions').set({ state: 'answered', reply_message_id: messageId }).where('id', '=', mentionId).execute();
        return events.append(tx, [{ type: 'mention.answered', actorKind: 'agent', agentId: row.agent_id, projectId: row.project_id, threadId: row.thread_id, payload: { mentionId, messageId } }]);
      });
      events.published(published);
    },
  };
}
export type Mentions = ReturnType<typeof createMentions>;
