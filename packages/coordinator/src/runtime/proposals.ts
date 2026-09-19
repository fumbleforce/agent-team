import type { z } from 'zod';
import { DelegationRules, newId, ProposalChange, withinBounds, type ProposalInput, type ProposalVote } from '@agent-team/protocol';
import type { Tx } from '@agent-team/storage';
import { HttpError, notFound, type Context } from '../context.ts';

const refuse = (message: string) => new HttpError(409, 'proposal', message);

// The team proposes changes to itself. Inside the delegated bounds a majority applies them; outside, a human decides.
export function createProposals(context: Context) {
  const { storage, events, now } = context;
  const db = storage.db;

  async function rulesFor(tx: Tx, projectId: string): Promise<DelegationRules> {
    const row = await tx.selectFrom('versioned_docs').select('doc').where('kind', '=', 'delegation_rules').where('scope_type', '=', 'project').where('scope_id', '=', projectId).executeTakeFirst();
    return DelegationRules.parse(row ? JSON.parse(row.doc) : {});
  }

  // The same functions a human action uses, so an applied proposal and a manual change cannot differ.
  async function apply(tx: Tx, change: ProposalChange) {
    if (change.kind === 'set_daily_cap') await tx.updateTable('agents').set({ daily_cap_minor: change.capMinor }).where('id', '=', change.agentId).execute();
    if (change.kind === 'retire_agent') await tx.updateTable('agents').set({ status: 'retired' }).where('id', '=', change.agentId).execute();
    if (change.kind === 'add_role') await tx.insertInto('agent_roles').values({ agent_id: change.agentId, role_slug: change.role }).onConflict(oc => oc.columns(['agent_id', 'role_slug']).doNothing()).execute();
  }

  async function seats(tx: Tx, projectId: string) {
    const project = await tx.selectFrom('projects').select(['team_id', 'parent_id']).where('id', '=', projectId).executeTakeFirstOrThrow();
    const teamId = project.team_id ?? (project.parent_id ? (await tx.selectFrom('projects').select('team_id').where('id', '=', project.parent_id).executeTakeFirst())?.team_id : null);
    return teamId ? (await tx.selectFrom('agents').select('id').where('team_id', '=', teamId).where('status', '=', 'active').execute()).map(row => row.id) : [];
  }

  return {
    async create(turn: { agent_id: string; project_id: string }, input: ProposalInput) {
      const id = newId(now());
      const published = await storage.transaction(async tx => {
        await tx.insertInto('proposals').values({ id, project_id: turn.project_id, category: input.category, title: input.title, why: input.why, what_changes: input.whatChanges, change: JSON.stringify(input.change), evidence: JSON.stringify(input.evidence), proposer_agent_id: turn.agent_id, state: 'voting', resolved_by_user: null, resolution_note: null, created_at: now(), resolved_at: null }).execute();
        return events.append(tx, [{ type: 'proposal.created', actorKind: 'agent', agentId: turn.agent_id, projectId: turn.project_id, payload: { proposalId: id, category: input.category } }]);
      });
      events.published(published);
      return { proposalId: id };
    },

    // One vote per seat. Once every other seat has voted, a majority in favour settles it: applied if inside the bounds, otherwise handed to a human.
    async vote(turn: { agent_id: string }, proposalId: string, input: z.infer<typeof ProposalVote>) {
      const result = await storage.transaction(async tx => {
        const proposal = await tx.selectFrom('proposals').selectAll().where('id', '=', proposalId).executeTakeFirst();
        if (!proposal) throw notFound('Proposal');
        if (proposal.state !== 'voting') throw refuse(`Voting is closed; the proposal is ${proposal.state}`);
        if (proposal.proposer_agent_id === turn.agent_id) throw refuse('The proposer does not vote on its own proposal');
        await tx.insertInto('proposal_votes').values({ proposal_id: proposalId, agent_id: turn.agent_id, stance: input.stance, note: input.note }).onConflict(oc => oc.columns(['proposal_id', 'agent_id']).doUpdateSet({ stance: input.stance, note: input.note })).execute();
        const voters = (await seats(tx, proposal.project_id)).filter(id => id !== proposal.proposer_agent_id);
        const votes = await tx.selectFrom('proposal_votes').select(['agent_id', 'stance']).where('proposal_id', '=', proposalId).execute();
        if (!voters.every(id => votes.some(vote => vote.agent_id === id))) return { state: 'voting', published: [] };
        const inFavour = votes.filter(vote => vote.stance === 'for').length * 2 > votes.length;
        const change = ProposalChange.parse(JSON.parse(proposal.change));
        const state = !inFavour ? 'declined' : withinBounds(await rulesFor(tx, proposal.project_id), proposal.category as ProposalInput['category'], change) ? 'auto_applied' : 'needs_you';
        if (state === 'auto_applied') await apply(tx, change);
        await tx.updateTable('proposals').set({ state, resolved_at: state === 'needs_you' ? null : now(), resolution_note: state === 'declined' ? 'The team voted against it' : null }).where('id', '=', proposalId).execute();
        return { state, published: await events.append(tx, [{ type: `proposal.${state}`, actorKind: 'system', projectId: proposal.project_id, payload: { proposalId } }]) };
      });
      events.published(result.published);
      return { state: result.state };
    },

    async decide(userId: string, proposalId: string, decision: 'approve' | 'decline', note: string | null) {
      const published = await storage.transaction(async tx => {
        const proposal = await tx.selectFrom('proposals').selectAll().where('id', '=', proposalId).executeTakeFirst();
        if (!proposal) throw notFound('Proposal');
        if (proposal.state !== 'needs_you') throw refuse(`The proposal is ${proposal.state}`);
        if (decision === 'approve') await apply(tx, ProposalChange.parse(JSON.parse(proposal.change)));
        await tx.updateTable('proposals').set({ state: decision === 'approve' ? 'approved' : 'declined', resolved_by_user: userId, resolution_note: note, resolved_at: now() }).where('id', '=', proposalId).execute();
        return events.append(tx, [{ type: `proposal.${decision === 'approve' ? 'approved' : 'declined'}`, category: 'audit', actorKind: 'user', userId, projectId: proposal.project_id, payload: { proposalId, note } }]);
      });
      events.published(published);
    },

    async list(projectIds: string[]) {
      if (projectIds.length === 0) return [];
      const rows = await db.selectFrom('proposals').selectAll().where('project_id', 'in', projectIds).orderBy('created_at', 'desc').limit(100).execute();
      const votes = rows.length ? await db.selectFrom('proposal_votes').selectAll().where('proposal_id', 'in', rows.map(row => row.id)).execute() : [];
      return rows.map(row => ({ id: row.id, projectId: row.project_id, category: row.category, title: row.title, why: row.why, whatChanges: row.what_changes, evidence: JSON.parse(row.evidence) as { label: string; value: string }[], proposerAgentId: row.proposer_agent_id, state: row.state, resolutionNote: row.resolution_note, createdAt: Number(row.created_at), votes: votes.filter(vote => vote.proposal_id === row.id).map(vote => ({ agentId: vote.agent_id, stance: vote.stance, note: vote.note })) }));
    },
  };
}
export type Proposals = ReturnType<typeof createProposals>;
