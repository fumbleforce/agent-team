import type { z } from 'zod';
import { categoryOf, DelegationRules, LibraryAgent, newId, ProposalChange, TeamTemplate, withinBounds, type EventDraft, type ProposalInput, type ProposalVote, type StaffingDecision, type ToolOutput } from '@agent-team/protocol';
import type { Tx } from '@agent-team/storage';
import { HttpError, notFound, type Context } from '../context.ts';
import { teamIdOf } from '../repos/issueTasks.ts';
import { hireInto, retireSeat, stampTemplate } from '../repos/org.ts';
import type { Turns } from './turns.ts';

const refuse = (message: string) => new HttpError(409, 'proposal', message);
const LIBRARY = { scope_type: 'library', scope_id: '' } as const;
const DAY_MS = 24 * 3600_000;

type Actor = { actorKind: 'agent'; by: string } | { actorKind: 'user'; userId: string } | { actorKind: 'system' };
interface Applied { agentIds: string[]; drafts: EventDraft[]; returned: { key: string; projectId: string }[]; retiredName: string | null }

// The team proposes changes to itself. Inside the delegated bounds a majority applies them; outside, a human decides.
// The seat that staffs the team decides who is on it without a vote, inside the limits the owner set for it.
export function createProposals(context: Context, turns?: Turns) {
  const { storage, events, now } = context;
  const db = storage.db;

  async function rulesFor(tx: Pick<Tx, 'selectFrom'>, projectId: string): Promise<DelegationRules> {
    const project = await tx.selectFrom('projects').select(['id', 'parent_id']).where('id', '=', projectId).executeTakeFirst();
    const row = await tx.selectFrom('versioned_docs').select('doc').where('kind', '=', 'delegation_rules').where('scope_type', '=', 'project').where('scope_id', '=', project?.parent_id ?? projectId).executeTakeFirst();
    return DelegationRules.parse(row ? JSON.parse(row.doc) : {});
  }

  async function doc(tx: Tx, kind: 'library_agent' | 'team_template', slug: string) {
    return tx.selectFrom('versioned_docs').select(['slug', 'version', 'doc']).where('kind', '=', kind).where('scope_type', '=', LIBRARY.scope_type).where('scope_id', '=', LIBRARY.scope_id).where('slug', '=', slug).executeTakeFirst();
  }

  async function roster(tx: Tx, projectId: string) {
    const teamId = await teamIdOf(tx, projectId);
    const seats = teamId ? await tx.selectFrom('agents').select(['id', 'name', 'is_pm', 'status']).where('team_id', '=', teamId).where('status', '!=', 'retired').execute() : [];
    const roles = seats.length ? await tx.selectFrom('agent_roles').select(['agent_id', 'role_slug']).where('agent_id', 'in', seats.map(seat => seat.id)).execute() : [];
    return seats.map(seat => ({ ...seat, roles: roles.filter(role => role.agent_id === seat.id).map(role => role.role_slug) }));
  }

  // What a change names must exist and sit on this team. Refused before anything is recorded, so nothing waits for the owner that could never apply.
  async function check(tx: Tx, projectId: string, change: ProposalChange) {
    const team = await roster(tx, projectId);
    const seat = 'agentId' in change ? team.find(item => item.id === change.agentId) : null;
    if ('agentId' in change && !seat) throw refuse('That agent is not a seat of this team');
    if (change.kind === 'retire_agent' && seat?.is_pm === true) throw refuse(`${seat.name} is the team's PM. Someone else has to be the PM before this seat can be retired, and that is the owner's to change.`);
    if (change.kind === 'hire_agent' && !await doc(tx, 'library_agent', change.library)) throw refuse(`Nobody called ${change.library} is in the agent library`);
    if (change.kind === 'staff_from_template' && !await doc(tx, 'team_template', change.template)) throw refuse(`There is no team template called ${change.template}`);
    const named = change.kind === 'create_agent' ? change.seat.roles : change.kind === 'change_seat' ? change.roles ?? [] : change.kind === 'add_role' ? [change.role] : [];
    const known = named.length ? (await tx.selectFrom('versioned_docs').select('slug').where('kind', '=', 'role').where('scope_type', '=', LIBRARY.scope_type).where('slug', 'in', named).execute()).map(row => row.slug) : [];
    const unknown = named.filter(role => !known.includes(role));
    if (unknown.length) throw refuse(`${unknown.join(', ')} is not in the role library`);
    return team;
  }

  // Why a staffing decision has to wait for the owner, in words the owner reads; null when it may take effect at once.
  async function beyond(tx: Tx, projectId: string, by: string, change: ProposalChange, team: Awaited<ReturnType<typeof roster>>): Promise<string | null> {
    const rules = await rulesFor(tx, projectId);
    if (!rules.staffing.decides) return 'The owner decides who is on this team';
    const seat = 'agentId' in change ? team.find(item => item.id === change.agentId)! : null;
    if (seat?.id === by && change.kind !== 'set_daily_cap') return 'A seat does not decide about itself';
    const adds = change.kind === 'hire_agent' || change.kind === 'create_agent' ? 1 : change.kind === 'staff_from_template' ? TeamTemplate.parse(JSON.parse((await doc(tx, 'team_template', change.template))!.doc)).seats.length : 0;
    if (adds && team.length + adds > rules.staffing.maxSeats) return `The team would grow to ${team.length + adds} seats; it may have ${rules.staffing.maxSeats}`;
    if (change.kind === 'set_daily_cap' && change.capMinor > rules.maxDailyCapMinor) return 'The cap is above what the team may set by itself';
    if (change.kind === 'set_status' && change.status === 'paused' && seat?.is_pm === true) return `${seat.name} is the PM`;
    // A role nobody else wears would leave the team with it: its reviews or its answers would wait for ever.
    const leaving = change.kind === 'retire_agent' || (change.kind === 'set_status' && change.status === 'paused') ? seat!.roles : change.kind === 'change_seat' && change.roles ? seat!.roles.filter(role => !change.roles!.includes(role)) : [];
    const last = leaving.find(role => !team.some(other => other.id !== seat!.id && other.status === 'active' && other.roles.includes(role)));
    return last ? `${seat!.name} is the only ${last} on the team` : null;
  }

  // The same functions a human action uses, so an applied proposal and a manual change cannot differ.
  async function apply(tx: Tx, projectId: string, proposalId: string, change: ProposalChange, actor: Actor): Promise<Applied> {
    const who = actor.actorKind === 'user' ? { actorKind: 'user' as const, userId: actor.userId } : { actorKind: actor.actorKind };
    const event = (type: string, agentId: string | null, payload: Record<string, unknown>): EventDraft => ({ type, category: 'audit', ...who, ...(agentId ? { agentId } : {}), projectId, payload: { ...payload, proposalId, ...(actor.actorKind === 'agent' ? { by: actor.by } : {}) } });
    const done = (agentIds: string[], drafts: EventDraft[]): Applied => ({ agentIds, drafts, returned: [], retiredName: null });
    await check(tx, projectId, change);
    if (change.kind === 'set_daily_cap') { await tx.updateTable('agents').set({ daily_cap_minor: change.capMinor }).where('id', '=', change.agentId).execute(); return done([change.agentId], [event('agent.updated', change.agentId, { changed: ['dailyCap'] })]); }
    if (change.kind === 'add_role') { await tx.insertInto('agent_roles').values({ agent_id: change.agentId, role_slug: change.role }).onConflict(oc => oc.columns(['agent_id', 'role_slug']).doNothing()).execute(); return done([change.agentId], [event('agent.updated', change.agentId, { changed: ['roles'] })]); }
    if (change.kind === 'retire_agent') {
      const gone = await retireSeat(tx, now, change.agentId);
      return { agentIds: [change.agentId], drafts: [event('agent.retired', change.agentId, { name: gone.name, returned: gone.returned.map(task => task.key) })], returned: gone.returned, retiredName: gone.name };
    }
    if (change.kind === 'hire_agent') {
      const library = (await doc(tx, 'library_agent', change.library))!, seat = LibraryAgent.parse(JSON.parse(library.doc));
      const { agentId } = await hireInto(tx, now, projectId, { name: change.name ?? seat.name, title: seat.title, persona: seat.persona, roles: seat.roles });
      return done([agentId], [event('agent.hired', agentId, { library: library.slug, name: change.name ?? seat.name })]);
    }
    if (change.kind === 'create_agent') {
      const { agentId } = await hireInto(tx, now, projectId, change.seat);
      return done([agentId], [event('agent.created', agentId, { name: change.seat.name, title: change.seat.title, roles: change.seat.roles, isPm: false })]);
    }
    if (change.kind === 'change_seat') {
      const set = { ...(change.title !== undefined ? { title: change.title } : {}), ...(change.persona !== undefined ? { persona: change.persona } : {}) };
      if (Object.keys(set).length) await tx.updateTable('agents').set(set).where('id', '=', change.agentId).execute();
      if (change.roles) {
        await tx.deleteFrom('agent_roles').where('agent_id', '=', change.agentId).execute();
        for (const role of new Set(change.roles)) await tx.insertInto('agent_roles').values({ agent_id: change.agentId, role_slug: role }).execute();
      }
      return done([change.agentId], [event('agent.updated', change.agentId, { changed: Object.keys(change).filter(key => key !== 'kind' && key !== 'agentId') })]);
    }
    if (change.kind === 'set_status') { await tx.updateTable('agents').set({ status: change.status }).where('id', '=', change.agentId).execute(); return done([change.agentId], [event(change.status === 'paused' ? 'agent.paused' : 'agent.resumed', change.agentId, {})]); }
    if (change.kind === 'staff_from_template') {
      const stored = (await doc(tx, 'team_template', change.template))!, template = TeamTemplate.parse(JSON.parse(stored.doc));
      const made = await stampTemplate(tx, now, projectId, { slug: stored.slug, version: stored.version, name: template.name, seats: template.seats }, (await roster(tx, projectId)).length ? 'append' : 'create');
      return done(made.agentIds, [event('team.created_from_template', null, { teamId: made.teamId, template: stored.slug, version: stored.version, seats: made.agentIds.length })]);
    }
    return done([], []);
  }

  // What a retired seat had not finished is back in the backlog: the PM is told where the team reads, and woken to give it to someone.
  async function handBack(projectId: string, applied: Applied) {
    if (!applied.returned.length || !applied.retiredName) return;
    const thread = await db.selectFrom('threads').select('id').where('project_id', '=', projectId).where('kind', '=', 'discussion').executeTakeFirst();
    const pm = (await storage.transaction(tx => roster(tx, projectId))).find(seat => seat.is_pm === true && seat.status === 'active');
    if (!thread || !pm) return;
    const published = await storage.transaction(async tx => {
      const id = newId(now());
      await tx.insertInto('messages').values({ id, thread_id: thread.id, author_kind: 'system', author_id: null, kind: 'system', body: `${applied.retiredName} has left the team. Back in the backlog without an owner: ${applied.returned.map(task => task.key).join(', ')}. ${pm.name}: give each to a teammate who may do it with task.assign.`, payload: JSON.stringify({ staffing: true }), created_at: now() }).execute();
      return events.append(tx, [{ type: 'message.posted', actorKind: 'system', projectId, threadId: thread.id, payload: { messageId: id, kind: 'system' } }]);
    });
    events.published(published);
    await turns?.enqueue({ agentId: pm.id, projectId, kind: 'triage', threadId: thread.id, dedupeKey: `handback:${projectId}` });
  }

  async function seats(tx: Tx, projectId: string) {
    return (await roster(tx, projectId)).filter(seat => seat.status === 'active').map(seat => seat.id);
  }

  return {
    rules: (projectId: string) => rulesFor(db, projectId),

    async create(turn: { agent_id: string; project_id: string }, input: ProposalInput) {
      const id = newId(now());
      const published = await storage.transaction(async tx => {
        await check(tx, turn.project_id, input.change);
        const category = categoryOf(input.change, input.category);
        await tx.insertInto('proposals').values({ id, project_id: turn.project_id, category, title: input.title, why: input.why, what_changes: input.whatChanges, change: JSON.stringify(input.change), evidence: JSON.stringify(input.evidence), proposer_agent_id: turn.agent_id, state: 'voting', resolved_by_user: null, resolution_note: null, created_at: now(), resolved_at: null }).execute();
        return events.append(tx, [{ type: 'proposal.created', actorKind: 'agent', agentId: turn.agent_id, projectId: turn.project_id, payload: { proposalId: id, category } }]);
      });
      events.published(published);
      return { proposalId: id };
    },

    // One staffing decision, recorded like a proposal so the owner sees what was done and why. Inside the owner's limits it is applied in
    // the same transaction; beyond them it waits where every other proposal waits.
    async staff(turn: { agent_id: string; project_id: string }, input: StaffingDecision): Promise<ToolOutput<'staffing.decide'>> {
      const id = newId(now());
      const result = await storage.transaction(async tx => {
        const team = await check(tx, turn.project_id, input.change);
        const note = await beyond(tx, turn.project_id, turn.agent_id, input.change, team);
        const state = note ? 'needs_you' : 'auto_applied', category = categoryOf(input.change, 'composition');
        // Someone from the library is called by their name, never by how the library files them.
        const hired = input.change.kind === 'hire_agent' ? input.change.name ?? LibraryAgent.parse(JSON.parse((await doc(tx, 'library_agent', input.change.library))!.doc)).name : null;
        await tx.insertInto('proposals').values({ id, project_id: turn.project_id, category, title: input.title, why: input.why, what_changes: describe(input.change, team, hired), change: JSON.stringify(input.change), evidence: JSON.stringify(input.evidence), proposer_agent_id: turn.agent_id, state, resolved_by_user: null, resolution_note: note, created_at: now(), resolved_at: note ? null : now() }).execute();
        const applied = note ? null : await apply(tx, turn.project_id, id, input.change, { actorKind: 'agent', by: turn.agent_id });
        return { note, applied, published: await events.append(tx, [{ type: 'proposal.created', actorKind: 'agent', agentId: turn.agent_id, projectId: turn.project_id, payload: { proposalId: id, category, staffing: true } }, { type: `proposal.${state}`, actorKind: 'agent', agentId: turn.agent_id, projectId: turn.project_id, payload: { proposalId: id } }, ...(applied?.drafts ?? [])]) };
      });
      events.published(result.published);
      if (result.applied) await handBack(turn.project_id, result.applied);
      return { proposalId: id, state: result.note ? 'needs_owner' : 'applied', note: result.note, agentIds: result.applied?.agentIds ?? [] };
    },

    // Everything a staffing decision is made from, in one read: the seats with their figures, the limits, and who and what can be brought in.
    async review(turn: { project_id: string }, days: number): Promise<ToolOutput<'staffing.review'>> {
      return storage.transaction(async tx => {
        const rules = await rulesFor(tx, turn.project_id), team = await roster(tx, turn.project_id), ids = team.map(seat => seat.id), since = now() - days * DAY_MS;
        const details = ids.length ? await tx.selectFrom('agents').select(['id', 'title', 'daily_cap_minor']).where('id', 'in', ids).execute() : [];
        const ran = ids.length ? await tx.selectFrom('turns').select(['agent_id', 'state', 'cost_minor']).where('agent_id', 'in', ids).where('started_at', '>=', since).execute() : [];
        const tasks = ids.length ? await tx.selectFrom('tasks').select(['id', 'assignee_agent_id', 'state', 'updated_at']).where('assignee_agent_id', 'in', ids).execute() : [];
        const waiting = ids.length ? await tx.selectFrom('work_items').select('agent_id').where('agent_id', 'in', ids).where('kind', '=', 'work').where('state', '=', 'queued').execute() : [];
        const asked = tasks.length ? await tx.selectFrom('approvals').select('task_id').where('task_id', 'in', tasks.map(task => task.id)).where('verdict', '!=', 'pass').where('created_at', '>=', since).execute() : [];
        const library = await tx.selectFrom('versioned_docs').select(['slug', 'kind', 'doc']).where('kind', 'in', ['library_agent', 'team_template', 'role']).where('scope_type', '=', LIBRARY.scope_type).orderBy('slug').execute();
        const of = (kind: string) => library.filter(row => row.kind === kind).map(row => ({ slug: row.slug, doc: JSON.parse(row.doc) as Record<string, unknown> }));
        return {
          limits: { decides: rules.staffing.decides, maxSeats: rules.staffing.maxSeats, maxDailyCapMinor: rules.maxDailyCapMinor },
          seats: team.map(seat => {
            const mine = ran.filter(row => row.agent_id === seat.id), own = tasks.filter(task => task.assignee_agent_id === seat.id), detail = details.find(row => row.id === seat.id);
            return { agentId: seat.id, name: seat.name, title: detail?.title ?? '', roles: seat.roles, status: seat.status, isPm: seat.is_pm === true, dailyCapMinor: detail?.daily_cap_minor ?? null,
              turns: mine.length, failed: mine.filter(row => ['failed', 'timed_out', 'uncertain'].includes(row.state)).length, spentMinor: mine.reduce((sum, row) => sum + row.cost_minor, 0),
              tasksDone: own.filter(task => task.state === 'done' && Number(task.updated_at) >= since).length, tasksOpen: own.filter(task => !['done', 'canceled'].includes(task.state)).length,
              waiting: waiting.filter(row => row.agent_id === seat.id).length, changesRequested: asked.filter(row => own.some(task => task.id === row.task_id)).length };
          }),
          library: of('library_agent').map(({ slug, doc: item }) => { const parsed = LibraryAgent.parse(item); return { slug, name: parsed.name, title: parsed.title, roles: parsed.roles, summary: parsed.summary }; }),
          templates: of('team_template').map(({ slug, doc: item }) => { const parsed = TeamTemplate.parse(item); return { slug, name: parsed.name, summary: parsed.summary, seats: parsed.seats.length }; }),
          roles: of('role').map(({ slug, doc: item }) => ({ slug, summary: String(item.summary ?? '') })),
        };
      });
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
        const applied = state === 'auto_applied' ? await apply(tx, proposal.project_id, proposalId, change, { actorKind: 'system' }) : null;
        await tx.updateTable('proposals').set({ state, resolved_at: state === 'needs_you' ? null : now(), resolution_note: state === 'declined' ? 'The team voted against it' : null }).where('id', '=', proposalId).execute();
        return { state, published: await events.append(tx, [{ type: `proposal.${state}`, actorKind: 'system', projectId: proposal.project_id, payload: { proposalId } }, ...(applied?.drafts ?? [])]) };
      });
      events.published(result.published);
      return { state: result.state };
    },

    async decide(userId: string, proposalId: string, decision: 'approve' | 'decline', note: string | null) {
      const result = await storage.transaction(async tx => {
        const proposal = await tx.selectFrom('proposals').selectAll().where('id', '=', proposalId).executeTakeFirst();
        if (!proposal) throw notFound('Proposal');
        if (proposal.state !== 'needs_you') throw refuse(`The proposal is ${proposal.state}`);
        const applied = decision === 'approve' ? await apply(tx, proposal.project_id, proposalId, ProposalChange.parse(JSON.parse(proposal.change)), { actorKind: 'user', userId }) : null;
        await tx.updateTable('proposals').set({ state: decision === 'approve' ? 'approved' : 'declined', resolved_by_user: userId, resolution_note: note, resolved_at: now() }).where('id', '=', proposalId).execute();
        return { projectId: proposal.project_id, applied, published: await events.append(tx, [{ type: `proposal.${decision === 'approve' ? 'approved' : 'declined'}`, category: 'audit', actorKind: 'user', userId, projectId: proposal.project_id, payload: { proposalId, note } }, ...(applied?.drafts ?? [])]) };
      });
      events.published(result.published);
      if (result.applied) await handBack(result.projectId, result.applied);
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

// What changes, said once by the platform from the change itself, so the record never depends on how the decision was worded.
function describe(change: ProposalChange, team: { id: string; name: string }[], hired: string | null): string {
  const name = 'agentId' in change ? team.find(seat => seat.id === change.agentId)?.name ?? 'A seat' : '';
  switch (change.kind) {
    case 'hire_agent': return `${hired ?? change.library} joins the team from the agent library.`;
    case 'create_agent': return `${change.seat.name} joins the team as ${change.seat.title || change.seat.roles.join(', ')}, wearing ${change.seat.roles.join(', ')}.`;
    case 'retire_agent': return `${name} leaves the team for good. Unfinished tasks go back to the backlog.`;
    case 'change_seat': return `${name} changes: ${[change.title !== undefined ? `title to "${change.title}"` : '', change.roles ? `roles to ${change.roles.join(', ')}` : '', change.persona !== undefined ? 'a new persona' : ''].filter(Boolean).join(', ')}.`;
    case 'set_status': return change.status === 'paused' ? `${name} is paused and takes no new work.` : `${name} works again.`;
    case 'set_daily_cap': return `${name} may spend ${(change.capMinor / 100).toFixed(2)} a day.`;
    case 'add_role': return `${name} also wears ${change.role}.`;
    case 'staff_from_template': return `The seats of the ${change.template} template join the team.`;
    default: return '';
  }
}
