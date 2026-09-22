import { Charter, deliverableWords, LibraryAgent, newId, OrgPlan, TeamTemplate, type EventDraft, type OrgChange, type ToolOutput } from '@agent-team/protocol';
import type { Tx } from '@agent-team/storage';
import { CATALOG } from '../../../../adapters/integration/catalog.ts';
import { HttpError, notFound, type Context } from '../context.ts';
import { hireInto, retireSeat, stampTemplate, teamOf } from '../repos/org.ts';
import { createVersionedDocs } from '../repos/versionedDocs.ts';
import { createDeliverables } from './deliverables.ts';
import { setDuty } from './duties.ts';
import type { Turns } from './turns.ts';

// The organisation above the teams has a home of its own: a project nobody lists, whose one seat is the chief of staff. Turns,
// threads, costs and the MCP confinement all need a project, and this gives them one without a second kind of turn. What the seat
// does is propose: a plan of changes the owner reads step by step and applies or dismisses whole. Applying runs every step in one
// transaction with the same helpers a person's own actions use, so a plan never leaves the organisation half changed.
export const ORG_KIND = 'org';
export const ORG_ROLE = 'chief-of-staff';
const LIBRARY = { type: 'library' as const, id: '' };
const DAY_MS = 24 * 3600_000;
const refuse = (message: string) => new HttpError(409, 'plan', message);
// Thrown at the end of a trial run, so the transaction it ran in is rolled back and nothing it did stays.
class TrialRun extends Error { lines: string[]; constructor(lines: string[]) { super('trial run'); this.lines = lines; } }

export const ORG_RULE = 'You are the chief of staff: the owner asks you to change the organisation itself (start a team, add people to one, give a team a standing target, connect a tool, hand an area of work to a team) and you turn that into one plan they can check. Read org.review first. Then either ask one short question, when the request could mean two quite different things, or put the plan to the owner with org.plan: the fewest steps that do what they asked, an existing team before a new one, someone from the library before a new seat, a template when one fits. A team that is to deliver something every day gets a duty per kind of deliverable with its number (records, messages to send, cards, changes, pieces of material, campaigns). A tool the team needs goes in as connect_integration; the owner pastes its token afterwards, never you. For work a team should take on without changing who is on it, use org.handover instead of a plan. After org.plan, answer with discussion.post in one or two sentences saying what the plan does; the owner sees each step next to your answer.';

const every = (hours: number) => (hours === 24 ? 'every day' : hours === 168 ? 'every week' : hours % 24 === 0 ? `every ${hours / 24} days` : `every ${hours} hours`);

export async function orgHome(db: Pick<Tx, 'selectFrom'>): Promise<{ projectId: string; agentId: string | null } | null> {
  const project = await db.selectFrom('projects').select(['id', 'team_id']).where('kind', '=', ORG_KIND).executeTakeFirst();
  if (!project) return null;
  const seat = project.team_id ? await db.selectFrom('agents').select('id').where('team_id', '=', project.team_id).where('status', '=', 'active').orderBy('is_pm', 'desc').orderBy('sort').executeTakeFirst() : null;
  return { projectId: project.id, agentId: seat?.id ?? null };
}

export function createOrgPlans(context: Context, turns: Turns) {
  const { storage, events, now } = context;
  const db = storage.db;
  const docs = createVersionedDocs(context), deliverables = createDeliverables(context, turns);

  async function libraryDoc(tx: Pick<Tx, 'selectFrom'>, kind: 'library_agent' | 'team_template', slug: string) {
    return tx.selectFrom('versioned_docs').select(['slug', 'version', 'doc']).where('kind', '=', kind).where('scope_type', '=', LIBRARY.type).where('scope_id', '=', LIBRARY.id).where('slug', '=', slug).executeTakeFirst();
  }

  // Makes the home the first time the organisation is spoken to: its project, its thread, and its one seat.
  async function ensureHome(): Promise<{ projectId: string; agentId: string }> {
    const found = await orgHome(db);
    if (found?.agentId) return { projectId: found.projectId, agentId: found.agentId };
    const result = await storage.transaction(async tx => {
      const again = await orgHome(tx);
      let projectId = again?.projectId ?? null;
      if (!projectId) {
        projectId = newId(now());
        const org = await tx.selectFrom('org').select('name').executeTakeFirst();
        let slug = 'org';
        for (let n = 2; await tx.selectFrom('projects').select('id').where('slug', '=', slug).executeTakeFirst(); n++) slug = `org-${n}`;
        await tx.insertInto('projects').values({ id: projectId, slug, name: org?.name ?? 'Organisation', kind: ORG_KIND, parent_id: null, status: 'active', manifest: JSON.stringify({ name: org?.name ?? 'Organisation' }), manifest_sha: null, team_id: null, sort: 0, created_at: now() }).execute();
        await tx.insertInto('threads').values({ id: newId(now()), project_id: projectId, kind: 'discussion', subject_type: null, subject_id: null, title: '#org', visibility: 'team', owner_user_id: null, created_at: now() }).execute();
      }
      const stored = await libraryDoc(tx, 'library_agent', 'nora');
      const seat = stored ? LibraryAgent.parse(JSON.parse(stored.doc)) : { name: 'Nora', title: 'Chief of staff', persona: 'Brisk and exact. Asks one question when a request could mean two things, then comes back with a short plan.', roles: [ORG_ROLE] };
      const made = await stampTemplate(tx, now, projectId, { slug: 'org', version: 1, name: 'Organisation', seats: [{ name: seat.name, title: seat.title, persona: seat.persona, roles: seat.roles, isPm: true }] }, 'create');
      return { projectId, agentId: made.agentIds[0]! };
    });
    return result;
  }

  // The top-level teams by the short name the seat uses, and the teams an earlier step of the plan made, by their $name.
  async function teams(tx: Pick<Tx, 'selectFrom'>) {
    return tx.selectFrom('projects').select(['id', 'slug', 'name', 'team_id', 'manifest']).where('parent_id', 'is', null).where('kind', '!=', ORG_KIND).where('status', '!=', 'archived').orderBy('sort').orderBy('name').execute();
  }

  // Every step of a plan, in order, inside the transaction it is given. Returns what each step did in plain words, and the events.
  async function run(tx: Tx, plan: OrgPlan, actor: { actorKind: 'user'; userId: string } | { actorKind: 'agent'; agentId: string }) {
    const known = await teams(tx);
    const made = new Map<string, { id: string; name: string }>();
    const lines: string[] = [], drafts: EventDraft[] = [], started: { projectId: string; name: string; charter: Charter }[] = [];
    const who = actor.actorKind === 'user' ? { actorKind: 'user' as const, userId: actor.userId } : { actorKind: 'agent' as const, agentId: actor.agentId };
    const team = (ref: string) => {
      const found = ref.startsWith('$') ? made.get(ref) : known.find(row => row.slug === ref);
      if (!found) throw refuse(ref.startsWith('$') ? `${ref} is not made by an earlier step of this plan` : `There is no team called ${ref}`);
      return { id: found.id, name: found.name };
    };
    const seatOf = async (agentId: string) => {
      const row = await tx.selectFrom('agents').innerJoin('projects', 'projects.team_id', 'agents.team_id').select(['agents.id', 'agents.name', 'agents.status', 'projects.id as project_id', 'projects.name as team', 'projects.kind']).where('agents.id', '=', agentId).where('projects.parent_id', 'is', null).executeTakeFirst();
      if (!row || row.status === 'retired' || row.kind === ORG_KIND) throw refuse(`There is no seat ${agentId} on any team`);
      return row;
    };
    const slugFor = async (name: string) => {
      const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'team';
      let slug = base;
      for (let n = 2; await tx.selectFrom('projects').select('id').where('slug', '=', slug).executeTakeFirst(); n++) slug = `${base}-${n}`;
      return slug;
    };
    const manifestOf = async (projectId: string) => JSON.parse((await tx.selectFrom('projects').select('manifest').where('id', '=', projectId).executeTakeFirstOrThrow()).manifest) as Record<string, unknown>;

    for (const [index, step] of plan.steps.entries()) {
      try { lines.push(await apply(step)); } catch (error) {
        if (error instanceof HttpError) throw refuse(`Step ${index + 1} cannot be done: ${error.message}`);
        throw error;
      }
    }
    return { lines, drafts, started };

    async function apply(step: OrgChange): Promise<string> {
      switch (step.kind) {
        case 'create_team': {
          if (made.has(step.ref)) throw refuse(`${step.ref} is made twice`);
          if (!step.template && !step.seats) throw refuse('A new team starts from a template or from seats');
          const id = newId(now()), slug = await slugFor(step.name);
          const host = step.code ? CATALOG.find(item => item.target === 'scm' && (item.adapterKind ?? item.kind) === step.code!.host) : null;
          if (step.code && !host) throw refuse(`${step.code.host} is not a code host this platform works with`);
          const code = step.code && host ? { scm: { kind: host.adapterKind ?? host.kind }, delivery: { repository: step.code.repository, baseBranch: 'main', requiredChecks: [], autoMergeAuthorized: false } } : {};
          await tx.insertInto('projects').values({ id, slug, name: step.name, kind: step.code ? 'repo' : 'team', parent_id: null, status: 'active', manifest: JSON.stringify({ name: step.name, charter: step.charter, ...code }), manifest_sha: null, team_id: null, sort: 0, created_at: now() }).execute();
          await tx.insertInto('threads').values({ id: newId(now()), project_id: id, kind: 'discussion', subject_type: null, subject_id: null, title: `#${slug}`, visibility: 'team', owner_user_id: null, created_at: now() }).execute();
          let names: string[], from = '';
          if (step.template) {
            const stored = await libraryDoc(tx, 'team_template', step.template);
            if (!stored) throw refuse(`There is no team template called ${step.template}`);
            const template = TeamTemplate.parse(JSON.parse(stored.doc));
            await stampTemplate(tx, now, id, { slug: stored.slug, version: stored.version, name: `${step.name} team`, seats: template.seats }, 'create');
            names = template.seats.map(seat => seat.name);
            from = ` from the ${template.name} template`;
          } else {
            // A team has one PM: the seat marked so, or else the first.
            const seats = step.seats!.map((seat, at) => ({ ...seat, isPm: step.seats!.some(other => other.isPm) ? seat.isPm && step.seats!.findIndex(other => other.isPm) === at : at === 0 }));
            await stampTemplate(tx, now, id, { slug: 'custom', version: 1, name: `${step.name} team`, seats }, 'create');
            names = seats.map(seat => seat.name);
          }
          made.set(step.ref, { id, name: step.name });
          started.push({ projectId: id, name: step.name, charter: step.charter });
          drafts.push({ type: 'project.registered', ...who, projectId: id, payload: { slug } }, { type: 'settings.changed', category: 'audit', ...who, projectId: id, payload: { what: 'project.created', slug } });
          return `Start a team called ${step.name}${from}: ${names.join(', ')}. It owns ${step.charter.area}.`;
        }
        case 'hire': {
          const target = team(step.team);
          const stored = step.library ? await libraryDoc(tx, 'library_agent', step.library) : null;
          if (step.library && !stored) throw refuse(`Nobody called ${step.library} is in the agent library`);
          const seat = stored ? LibraryAgent.parse(JSON.parse(stored.doc)) : step.seat!;
          const known = await tx.selectFrom('versioned_docs').select('slug').where('kind', '=', 'role').where('slug', 'in', seat.roles).execute();
          const unknown = seat.roles.filter(role => !known.some(row => row.slug === role));
          if (unknown.length) throw refuse(`${unknown.join(', ')} is not in the role library`);
          for (let n = 0; n < step.count; n++) {
            const { agentId } = await hireInto(tx, now, target.id, { name: seat.name, title: seat.title, persona: seat.persona, roles: seat.roles });
            drafts.push({ type: stored ? 'agent.hired' : 'agent.created', category: 'audit', ...who, agentId, projectId: target.id, payload: { name: seat.name, ...(stored ? { library: stored.slug } : { roles: seat.roles }) } });
          }
          return `${step.count === 1 ? seat.name : `${step.count} × ${seat.name}`} (${seat.title || seat.roles.join(', ')}) ${step.count === 1 ? 'joins' : 'join'} ${target.name}.`;
        }
        case 'retire': {
          const seat = await seatOf(step.agentId);
          const gone = await retireSeat(tx, now, step.agentId);
          drafts.push({ type: 'agent.retired', category: 'audit', ...who, agentId: step.agentId, projectId: seat.project_id, payload: { name: gone.name, returned: gone.returned.map(task => task.key) } }, ...gone.drafts);
          return `${seat.name} leaves ${seat.team}.${gone.returned.length ? ` ${gone.returned.length} unfinished ${gone.returned.length === 1 ? 'task goes' : 'tasks go'} back to the backlog.` : ''}`;
        }
        case 'change_seat': {
          const seat = await seatOf(step.agentId);
          const set = { ...(step.title !== undefined ? { title: step.title } : {}), ...(step.persona !== undefined ? { persona: step.persona } : {}) };
          if (Object.keys(set).length) await tx.updateTable('agents').set(set).where('id', '=', step.agentId).execute();
          if (step.roles) {
            await tx.deleteFrom('agent_roles').where('agent_id', '=', step.agentId).execute();
            for (const role of new Set(step.roles)) await tx.insertInto('agent_roles').values({ agent_id: step.agentId, role_slug: role }).execute();
          }
          drafts.push({ type: 'agent.updated', category: 'audit', ...who, agentId: step.agentId, projectId: seat.project_id, payload: { changed: Object.keys(step).filter(key => key !== 'kind' && key !== 'agentId') } });
          return `${seat.name} on ${seat.team} changes: ${[step.title !== undefined ? `title to ${step.title}` : '', step.roles ? `roles to ${step.roles.join(', ')}` : '', step.persona !== undefined ? 'a new persona' : ''].filter(Boolean).join(', ')}.`;
        }
        case 'set_team_model': {
          const target = team(step.team), provider = await tx.selectFrom('providers').select(['id', 'name', 'models']).where('id', '=', step.providerId).executeTakeFirst();
          if (!provider) throw refuse('That provider is not set up');
          if (!(JSON.parse(provider.models) as string[]).includes(step.model)) throw refuse(`${provider.name} does not offer ${step.model}`);
          const { teamId } = await teamOf(tx, target.id);
          await tx.updateTable('teams').set({ default_provider_id: provider.id, default_model: step.model }).where('id', '=', teamId!).execute();
          drafts.push({ type: 'team.default_changed', category: 'audit', ...who, projectId: target.id, payload: { providerId: provider.id, model: step.model } });
          return `${target.name} works on ${step.model} from ${provider.name}, except seats that have their own.`;
        }
        case 'set_charter': {
          const target = team(step.team);
          await tx.updateTable('projects').set({ manifest: JSON.stringify({ ...await manifestOf(target.id), charter: step.charter }) }).where('id', '=', target.id).execute();
          started.push({ projectId: target.id, name: target.name, charter: step.charter });
          return `${target.name} owns ${step.charter.area}.`;
        }
        case 'set_duty': {
          const target = team(step.team), { teamId } = await teamOf(tx, target.id);
          const seats = teamId ? await tx.selectFrom('agents').select(['id', 'name']).where('team_id', '=', teamId).where('status', '=', 'active').orderBy('sort').execute() : [];
          const owner = seats.find(seat => seat.id === step.owner) ?? seats.find(seat => seat.name.toLowerCase() === step.owner.toLowerCase());
          if (!owner) throw refuse(`Nobody called ${step.owner} sits on ${target.name}`);
          await setDuty(tx, now, target.id, { title: step.title, brief: step.brief, ownerAgentId: owner.id, everyHours: step.everyHours, result: 'document', deliverable: step.deliverable });
          return step.everyHours === 0 ? `${owner.name} on ${target.name} stops "${step.title}".` : `${owner.name} on ${target.name}: ${step.title}, ${every(step.everyHours)}, ${step.deliverable.target} ${deliverableWords(step.deliverable.kind, step.deliverable.target)}.`;
        }
        case 'connect_integration': {
          const target = team(step.team), entry = CATALOG.find(item => item.kind === step.integration && item.target === 'connection');
          if (!entry) throw refuse(`${step.integration} is not something a team can be connected to here`);
          const existing = await tx.selectFrom('connections').select('id').where('project_id', '=', target.id).where('kind', '=', entry.kind).executeTakeFirst();
          if (!existing) await tx.insertInto('connections').values({ id: newId(now()), project_id: target.id, kind: entry.kind, name: entry.title, category: entry.category, mode: entry.mode, config: JSON.stringify(step.roles.length ? { roles: step.roles.join(',') } : {}), status: 'warning', status_detail: 'Waiting for the token', credential_ref: entry.credential?.variable ?? null, last_sync_at: null, created_at: now() }).execute();
          drafts.push({ type: 'connection.added', category: 'audit', ...who, projectId: target.id, payload: { kind: entry.kind, name: entry.title } });
          // Who will use it, by name: a role is how the platform files them, not what the owner calls them.
          const { teamId } = await teamOf(tx, target.id);
          const users = step.roles.length && teamId ? (await tx.selectFrom('agents').innerJoin('agent_roles', 'agent_roles.agent_id', 'agents.id').select('agents.name').distinct().where('agents.team_id', '=', teamId).where('agents.status', '=', 'active').where('agent_roles.role_slug', 'in', step.roles).orderBy('agents.name').execute()).map(row => row.name) : [];
          const named = users.length > 1 ? `${users.slice(0, -1).join(', ')} and ${users.at(-1)}` : users[0];
          return `Connect ${entry.title} to ${target.name}${named ? `, for ${named}` : ''}. You paste its token afterwards.`;
        }
        case 'link_teams': {
          const from = team(step.from), to = team(step.to);
          if (from.id === to.id) throw refuse('A team cannot depend on itself');
          if (!await tx.selectFrom('project_links').select('id').where('from_project_id', '=', from.id).where('to_project_id', '=', to.id).where('kind', '=', step.link).executeTakeFirst())
            await tx.insertInto('project_links').values({ id: newId(now()), from_project_id: from.id, to_project_id: to.id, kind: step.link, note: step.note, created_by: actor.actorKind === 'user' ? actor.userId : null, created_at: now() }).execute();
          return `${from.name} ${{ depends_on: 'depends on', blocks: 'blocks', relates_to: 'relates to' }[step.link]} ${to.name}.`;
        }
        case 'lend_seat': {
          const seat = await seatOf(step.agentId), to = team(step.to);
          if (seat.project_id === to.id) throw refuse(`${seat.name} already works on ${to.name}`);
          if (!await tx.selectFrom('seat_loans').select('id').where('agent_id', '=', step.agentId).where('to_project_id', '=', to.id).where('state', '=', 'active').executeTakeFirst())
            await tx.insertInto('seat_loans').values({ id: newId(now()), agent_id: step.agentId, to_project_id: to.id, state: 'active', note: step.note, created_by: actor.actorKind === 'user' ? actor.userId : null, created_at: now(), ended_at: null }).execute();
          drafts.push({ type: 'agent.lent', ...who, agentId: step.agentId, projectId: to.id, payload: { from: seat.project_id } });
          return `${seat.name} from ${seat.team} also works for ${to.name}.`;
        }
        case 'add_template': {
          await docs.writeWithin(tx, 'team_template', LIBRARY, step.slug, step.template, actor.actorKind === 'user' ? 'owner' : 'chief of staff', 'from an organisation plan');
          return `Keep a team template called ${step.template.name}: ${step.template.seats.map(seat => seat.name).join(', ')}.`;
        }
      }
    }
  }

  async function plan(id: string) {
    const row = await db.selectFrom('proposals').selectAll().where('id', '=', id).where('category', '=', 'organisation').executeTakeFirst();
    if (!row) throw notFound('Plan');
    const stored = JSON.parse(row.change) as { threadId: string; plan: unknown; steps: string[]; outcome?: string[] };
    return { row, threadId: stored.threadId, plan: OrgPlan.parse(stored.plan), steps: stored.steps, outcome: stored.outcome ?? null };
  }

  // A plan is posted in the thread it was asked in; the note says what came of it once it is applied or dismissed.
  async function note(threadId: string, projectId: string, body: string, payload: Record<string, unknown>) {
    const published = await storage.transaction(async tx => {
      const id = newId(now());
      await tx.insertInto('messages').values({ id, thread_id: threadId, author_kind: 'system', author_id: null, kind: 'system', body, payload: JSON.stringify(payload), created_at: now() }).execute();
      return events.append(tx, [{ type: 'message.posted', actorKind: 'system', projectId, threadId, payload: { messageId: id, kind: 'system', private: true } }]);
    });
    events.published(published);
  }

  // Work or an area for a team: said in the team's discussion, and its PM decides what it becomes.
  async function handover(projectId: string, wants: string) {
    const thread = await db.selectFrom('threads').select('id').where('project_id', '=', projectId).where('kind', '=', 'discussion').executeTakeFirst();
    const { teamId } = await teamOf(db, projectId);
    const pm = teamId ? await db.selectFrom('agents').select(['id', 'name']).where('team_id', '=', teamId).where('is_pm', '=', true).where('status', '=', 'active').executeTakeFirst() : null;
    if (!thread || !pm) throw refuse('That team has no PM to take it');
    const messageId = newId(now());
    const published = await storage.transaction(async tx => {
      await tx.insertInto('messages').values({ id: messageId, thread_id: thread.id, author_kind: 'system', author_id: null, kind: 'system', body: `From the organisation: ${wants}`, payload: JSON.stringify({ org: true }), created_at: now() }).execute();
      return events.append(tx, [{ type: 'message.posted', actorKind: 'system', projectId, threadId: thread.id, payload: { messageId, kind: 'system' } }]);
    });
    events.published(published);
    await turns.enqueue({ agentId: pm.id, projectId, kind: 'triage', threadId: thread.id, dedupeKey: `org:${projectId}:${messageId}` });
    return { messageId, passedTo: pm.name };
  }

  return {
    ensureHome,

    async review(days: number): Promise<ToolOutput<'org.review'>> {
      const since = now() - days * DAY_MS, rows = await teams(db);
      const ids = rows.map(row => row.id), teamIds = rows.flatMap(row => (row.team_id ? [row.team_id] : []));
      const agents = teamIds.length ? await db.selectFrom('agents').select(['id', 'team_id', 'name', 'title', 'status', 'is_pm']).where('team_id', 'in', teamIds).where('status', '!=', 'retired').orderBy('sort').execute() : [];
      const roles = agents.length ? await db.selectFrom('agent_roles').select(['agent_id', 'role_slug']).where('agent_id', 'in', agents.map(agent => agent.id)).execute() : [];
      const duties = ids.length ? await db.selectFrom('duties').innerJoin('agents', 'agents.id', 'duties.agent_id').select(['duties.project_id', 'duties.title', 'duties.every_ms', 'duties.deliverable_kind', 'duties.target', 'agents.name']).where('duties.project_id', 'in', ids).where('duties.active', '=', true).execute() : [];
      const progress = await deliverables.progress(ids);
      const connections = ids.length ? await db.selectFrom('connections').select(['project_id', 'name', 'status']).where('project_id', 'in', ids).execute() : [];
      const open = ids.length ? await db.selectFrom('tasks').select('project_id').select(eb => eb.fn.countAll<number>().as('n')).where('project_id', 'in', ids).where('state', 'not in', ['done', 'canceled']).groupBy('project_id').execute() : [];
      const spent = ids.length ? await db.selectFrom('cost_entries').select('project_id').select(eb => eb.fn.sum<number>('amount_minor').as('n')).where('project_id', 'in', ids).where('at', '>=', since).groupBy('project_id').execute() : [];
      const library = await db.selectFrom('versioned_docs').select(['slug', 'kind', 'doc']).where('kind', 'in', ['library_agent', 'team_template', 'role']).where('scope_type', '=', LIBRARY.type).orderBy('slug').execute();
      const of = (kind: string) => library.filter(row => row.kind === kind).map(row => ({ slug: row.slug, doc: JSON.parse(row.doc) as Record<string, unknown> }));
      const providers = await db.selectFrom('providers').select(['id', 'name', 'models']).orderBy('name').execute();
      return {
        teams: rows.map(row => {
          const charter = Charter.safeParse((JSON.parse(row.manifest) as { charter?: unknown }).charter);
          return {
            team: row.slug, name: row.name, charter: charter.success ? charter.data : null,
            seats: agents.filter(agent => agent.team_id === row.team_id).map(agent => ({ agentId: agent.id, name: agent.name, title: agent.title, roles: roles.filter(role => role.agent_id === agent.id).map(role => role.role_slug), status: agent.status, isPm: agent.is_pm === true })),
            duties: duties.filter(duty => duty.project_id === row.id).map(duty => ({ title: duty.title, owner: duty.name, everyHours: Number(duty.every_ms) / 3600_000, deliverable: duty.deliverable_kind && duty.target ? { kind: duty.deliverable_kind as 'record', target: Number(duty.target) } : null, today: progress.find(item => item.projectId === row.id && item.title === duty.title)?.approved ?? 0 })),
            connected: connections.filter(item => item.project_id === row.id).map(item => `${item.name}${item.status === 'connected' ? '' : ' (waiting for its token)'}`),
            openTasks: Number(open.find(item => item.project_id === row.id)?.n ?? 0), spentMinor: Number(spent.find(item => item.project_id === row.id)?.n ?? 0),
          };
        }),
        library: of('library_agent').flatMap(({ slug, doc }) => { const parsed = LibraryAgent.safeParse(doc); return parsed.success && !parsed.data.roles.includes(ORG_ROLE) ? [{ slug, name: parsed.data.name, title: parsed.data.title, roles: parsed.data.roles, summary: parsed.data.summary }] : []; }),
        templates: of('team_template').flatMap(({ slug, doc }) => { const parsed = TeamTemplate.safeParse(doc); return parsed.success ? [{ slug, name: parsed.data.name, summary: parsed.data.summary, seats: parsed.data.seats.map(seat => `${seat.name} (${seat.title || seat.roles.join(', ')}${seat.isPm ? ', PM' : ''})`) }] : []; }),
        roles: of('role').filter(({ slug }) => slug !== ORG_ROLE).map(({ slug, doc }) => ({ slug, summary: String(doc.summary ?? '') })),
        integrations: CATALOG.filter(entry => entry.target === 'connection').map(entry => ({ integration: entry.kind, title: entry.title, summary: entry.summary })),
        models: providers.map(provider => ({ providerId: provider.id, provider: provider.name, models: JSON.parse(provider.models) as string[] })),
      };
    },

    // The plan is tried in full and rolled back, so what the owner is shown is exactly what applying it would do, and a plan that
    // cannot be applied is refused to the seat that made it instead of failing in front of the owner.
    async propose(turn: { id: string; agent_id: string; project_id: string }, input: OrgPlan & { threadId: string }): Promise<ToolOutput<'org.plan'>> {
      const { threadId, ...plan } = input;
      let steps: string[] = [];
      try { await storage.transaction(async tx => { throw new TrialRun((await run(tx, plan, { actorKind: 'agent', agentId: turn.agent_id })).lines); }); } catch (error) {
        if (!(error instanceof TrialRun)) throw error;
        steps = error.lines;
      }
      const id = newId(now());
      const published = await storage.transaction(async tx => {
        // One plan waits per conversation: a new one replaces what was not applied yet.
        const waiting = await tx.selectFrom('proposals').select(['id', 'change']).where('project_id', '=', turn.project_id).where('category', '=', 'organisation').where('state', '=', 'waiting').execute();
        const replaced = waiting.filter(row => (JSON.parse(row.change) as { threadId: string }).threadId === threadId).map(row => row.id);
        if (replaced.length) await tx.updateTable('proposals').set({ state: 'replaced', resolved_at: now() }).where('id', 'in', replaced).execute();
        await tx.insertInto('proposals').values({ id, project_id: turn.project_id, category: 'organisation', title: plan.title, why: plan.why, what_changes: steps.join('\n'), change: JSON.stringify({ threadId, plan, steps }), evidence: '[]', proposer_agent_id: turn.agent_id, state: 'waiting', resolved_by_user: null, resolution_note: null, created_at: now(), resolved_at: null }).execute();
        const messageId = newId(now());
        await tx.insertInto('messages').values({ id: messageId, thread_id: threadId, author_kind: 'agent', author_id: turn.agent_id, kind: 'proposal', body: plan.title, payload: JSON.stringify({ orgPlan: id }), created_at: now() }).execute();
        return events.append(tx, [{ type: 'org.plan_proposed', actorKind: 'agent', agentId: turn.agent_id, projectId: turn.project_id, turnId: turn.id, payload: { planId: id, steps: steps.length } }, { type: 'message.posted', actorKind: 'agent', agentId: turn.agent_id, projectId: turn.project_id, threadId, payload: { messageId, kind: 'proposal', private: true } }]);
      });
      events.published(published);
      return { planId: id, steps: steps.length };
    },

    async get(id: string) {
      const found = await plan(id);
      return { id, title: found.row.title, why: found.row.why, steps: found.steps, state: found.row.state, outcome: found.outcome, note: found.row.resolution_note, threadId: found.threadId, projectId: found.row.project_id };
    },

    async apply(userId: string, id: string) {
      const found = await plan(id);
      if (found.row.state !== 'waiting') throw refuse(`This plan is already ${found.row.state}`);
      const result = await storage.transaction(async tx => {
        const done = await run(tx, found.plan, { actorKind: 'user', userId });
        const claimed = await tx.updateTable('proposals').set({ state: 'applied', resolved_by_user: userId, resolved_at: now(), change: JSON.stringify({ threadId: found.threadId, plan: found.plan, steps: found.steps, outcome: done.lines }) }).where('id', '=', id).where('state', '=', 'waiting').executeTakeFirst();
        if (Number(claimed.numUpdatedRows) !== 1) throw refuse('This plan was applied or dismissed in the meantime');
        return { ...done, published: await events.append(tx, [{ type: 'org.plan_applied', category: 'audit', actorKind: 'user', userId, projectId: found.row.project_id, payload: { planId: id, title: found.plan.title, steps: done.lines.length } }, ...done.drafts]) };
      });
      events.published(result.published);
      await note(found.threadId, found.row.project_id, `Applied: ${found.plan.title}.`, { orgPlan: id, applied: true });
      // A team given an area hears so where it reads, and its PM starts on it.
      for (const item of result.started) await handover(item.projectId, `${item.name} now owns ${item.charter.area}.${item.charter.outcomes.length ? ` What it should show for it: ${item.charter.outcomes.join('; ')}.` : ''} Put the first work for it on the board.`);
      return { lines: result.lines };
    },

    async dismiss(userId: string, id: string) {
      const found = await plan(id);
      if (found.row.state !== 'waiting') throw refuse(`This plan is already ${found.row.state}`);
      await db.updateTable('proposals').set({ state: 'dismissed', resolved_by_user: userId, resolved_at: now() }).where('id', '=', id).execute();
      await note(found.threadId, found.row.project_id, `Dismissed: ${found.plan.title}.`, { orgPlan: id, dismissed: true });
    },

    handover,

    async teamBySlug(slug: string) {
      const row = (await teams(db)).find(item => item.slug === slug);
      if (!row) throw refuse(`There is no team called ${slug}`);
      return row.id;
    },
  };
}
export type OrgPlans = ReturnType<typeof createOrgPlans>;
