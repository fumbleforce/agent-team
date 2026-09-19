import type { z } from 'zod';
import { newId, type FromTemplateBody, type HireBody, type MilestoneBody, type MilestonePatch, type ProjectLinkBody, type SeatLoanBody, type TemplateSeat } from '@agent-team/protocol';
import type { Db, Tx } from '@agent-team/storage';
import { HttpError, notFound, type Context } from '../context.ts';

type Seat = z.infer<typeof TemplateSeat>;

// The projects an agent may be given work in: its own team's projects and their sub-projects, plus every project it is on loan to,
// leaving out any that is paused or archived. Pure over the executor it is given, so a claim can call it inside its transaction.
export async function effectiveProjects(executor: Db | Tx, agentId: string): Promise<string[]> {
  const agent = await executor.selectFrom('agents').select('team_id').where('id', '=', agentId).executeTakeFirst();
  if (!agent) return [];
  const projects = await executor.selectFrom('projects').select(['id', 'parent_id', 'team_id', 'status']).execute();
  const loans = await executor.selectFrom('seat_loans').select('to_project_id').where('agent_id', '=', agentId).where('state', '=', 'active').execute();
  const roots = new Set([...projects.filter(project => project.team_id === agent.team_id).map(project => project.id), ...loans.map(loan => loan.to_project_id)]);
  const byId = new Map(projects.map(project => [project.id, project]));
  const live = (project: (typeof projects)[number]): boolean => project.status === 'active' && (project.parent_id === null || byId.get(project.parent_id)?.status === 'active');
  return projects.filter(project => (roots.has(project.id) || (project.parent_id !== null && roots.has(project.parent_id))) && live(project)).map(project => project.id);
}

// Structure around the projects: milestones, cross-project links, seats on loan, and teams stamped from templates or hired from the library.
export function createOrg(context: Context) {
  const { storage, events, now } = context;
  const db = storage.db;
  const user = (userId: string) => ({ actorKind: 'user' as const, userId });

  async function seat(tx: Tx, teamId: string, input: Seat, sort: number): Promise<string> {
    const id = newId(now());
    const initials = input.name.split(/\s+/).map(word => word[0] ?? '').join('').slice(0, 2).toUpperCase() || input.name.slice(0, 2).toUpperCase();
    await tx.insertInto('agents').values({ id, team_id: teamId, name: input.name, initials, tint: String((sort % 8) + 1), title: input.title, persona: input.persona, status: 'active', provider_id: null, model: null, daily_cap_minor: null, is_pm: input.isPm, doing: null, sort, created_at: now() }).execute();
    for (const role of new Set(input.roles)) await tx.insertInto('agent_roles').values({ agent_id: id, role_slug: role }).execute();
    return id;
  }
  // The team a project runs with is its own or its parent's.
  async function teamOf(executor: Db | Tx, projectId: string) {
    const project = await executor.selectFrom('projects').select(['id', 'name', 'parent_id', 'team_id']).where('id', '=', projectId).executeTakeFirst();
    if (!project) throw notFound('Project');
    const root = project.parent_id ? await executor.selectFrom('projects').select(['id', 'name', 'parent_id', 'team_id']).where('id', '=', project.parent_id).executeTakeFirstOrThrow() : project;
    return { root, teamId: root.team_id };
  }

  return {
    async milestones(projectIds: string[]) {
      if (projectIds.length === 0) return [];
      const rows = await db.selectFrom('milestones').selectAll().where('project_id', 'in', projectIds).execute();
      const tasks = await db.selectFrom('tasks').select(['milestone_id', 'state']).select(eb => eb.fn.countAll<number>().as('n')).where('milestone_id', 'is not', null).where('project_id', 'in', projectIds).groupBy(['milestone_id', 'state']).execute();
      return rows.map(row => {
        const mine = tasks.filter(task => task.milestone_id === row.id && task.state !== 'canceled');
        const total = mine.reduce((sum, task) => sum + Number(task.n), 0);
        return { id: row.id, projectId: row.project_id, label: row.label, dueAt: row.due_at === null ? null : Number(row.due_at), state: row.state, tasks: total, done: mine.filter(task => task.state === 'done').reduce((sum, task) => sum + Number(task.n), 0) };
      }).sort((a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) || a.label.localeCompare(b.label));
    },

    async createMilestone(userId: string, projectId: string, input: z.infer<typeof MilestoneBody>) {
      const id = newId(now());
      const published = await storage.transaction(async tx => {
        await tx.insertInto('milestones').values({ id, project_id: projectId, label: input.label, due_at: input.dueAt ?? null, state: input.state }).execute();
        return events.append(tx, [{ type: 'milestone.created', ...user(userId), projectId, payload: { milestoneId: id, label: input.label } }]);
      });
      events.published(published);
      return id;
    },

    async milestone(id: string) {
      const row = await db.selectFrom('milestones').selectAll().where('id', '=', id).executeTakeFirst();
      if (!row) throw notFound('Milestone');
      return row;
    },

    async updateMilestone(userId: string, id: string, input: z.infer<typeof MilestonePatch>) {
      const published = await storage.transaction(async tx => {
        const row = await tx.selectFrom('milestones').select('project_id').where('id', '=', id).executeTakeFirst();
        if (!row) throw notFound('Milestone');
        const set = { ...(input.label !== undefined ? { label: input.label } : {}), ...(input.dueAt !== undefined ? { due_at: input.dueAt } : {}), ...(input.state !== undefined ? { state: input.state } : {}) };
        if (Object.keys(set).length) await tx.updateTable('milestones').set(set).where('id', '=', id).execute();
        return events.append(tx, [{ type: 'milestone.updated', ...user(userId), projectId: row.project_id, payload: { milestoneId: id, ...input } }]);
      });
      events.published(published);
    },

    async deleteMilestone(userId: string, id: string) {
      const published = await storage.transaction(async tx => {
        const row = await tx.selectFrom('milestones').select(['project_id', 'label']).where('id', '=', id).executeTakeFirst();
        if (!row) throw notFound('Milestone');
        await tx.updateTable('tasks').set({ milestone_id: null }).where('milestone_id', '=', id).execute();
        await tx.deleteFrom('milestones').where('id', '=', id).execute();
        return events.append(tx, [{ type: 'milestone.deleted', ...user(userId), projectId: row.project_id, payload: { milestoneId: id, label: row.label } }]);
      });
      events.published(published);
    },

    async setStatus(userId: string, projectId: string, status: string) {
      const published = await storage.transaction(async tx => {
        const row = await tx.selectFrom('projects').select('status').where('id', '=', projectId).executeTakeFirst();
        if (!row) throw notFound('Project');
        if (row.status === status) return [];
        await tx.updateTable('projects').set({ status }).where('id', '=', projectId).execute();
        return events.append(tx, [{ type: 'project.status_changed', category: 'audit', ...user(userId), projectId, payload: { from: row.status, to: status } }]);
      });
      events.published(published);
    },

    // Edges between top-level projects, for the projects a viewer can see on both ends.
    async links(visible: (projectId: string) => boolean) {
      const rows = await db.selectFrom('project_links').selectAll().orderBy('created_at').execute();
      return rows.filter(row => visible(row.from_project_id) && visible(row.to_project_id)).map(row => ({ id: row.id, fromProjectId: row.from_project_id, toProjectId: row.to_project_id, kind: row.kind, note: row.note }));
    },

    async link(userId: string, input: z.infer<typeof ProjectLinkBody>) {
      if (input.fromProjectId === input.toProjectId) throw new HttpError(400, 'invalid', 'A project cannot depend on itself', { toProjectId: 'Choose another project' });
      const id = newId(now());
      const published = await storage.transaction(async tx => {
        if (await tx.selectFrom('project_links').select('id').where('from_project_id', '=', input.fromProjectId).where('to_project_id', '=', input.toProjectId).where('kind', '=', input.kind).executeTakeFirst()) throw new HttpError(409, 'exists', 'These projects are already linked this way');
        await tx.insertInto('project_links').values({ id, from_project_id: input.fromProjectId, to_project_id: input.toProjectId, kind: input.kind, note: input.note, created_by: userId, created_at: now() }).execute();
        return events.append(tx, [{ type: 'project.linked', ...user(userId), projectId: input.fromProjectId, payload: { linkId: id, to: input.toProjectId, kind: input.kind } }]);
      });
      events.published(published);
      return id;
    },

    async linkById(id: string) {
      const row = await db.selectFrom('project_links').selectAll().where('id', '=', id).executeTakeFirst();
      if (!row) throw notFound('Link');
      return row;
    },

    async unlink(userId: string, id: string) {
      const published = await storage.transaction(async tx => {
        const row = await tx.selectFrom('project_links').selectAll().where('id', '=', id).executeTakeFirst();
        if (!row) throw notFound('Link');
        await tx.deleteFrom('project_links').where('id', '=', id).execute();
        return events.append(tx, [{ type: 'project.unlinked', ...user(userId), projectId: row.from_project_id, payload: { linkId: id, to: row.to_project_id, kind: row.kind } }]);
      });
      events.published(published);
    },

    // Active loans with the agent, its home project and where it is lent.
    async loans(visible: (projectId: string) => boolean) {
      const rows = await db.selectFrom('seat_loans').innerJoin('agents', 'agents.id', 'seat_loans.agent_id').innerJoin('projects as home', 'home.team_id', 'agents.team_id').innerJoin('projects as target', 'target.id', 'seat_loans.to_project_id')
        .select(['seat_loans.id', 'seat_loans.note', 'seat_loans.created_at', 'agents.id as agent_id', 'agents.name', 'agents.initials', 'agents.tint', 'agents.title', 'home.id as home_id', 'home.name as home_name', 'target.id as target_id', 'target.name as target_name', 'target.slug as target_slug'])
        .where('seat_loans.state', '=', 'active').orderBy('seat_loans.created_at').execute();
      return rows.filter(row => visible(row.home_id) || visible(row.target_id)).map(row => ({ id: row.id, note: row.note, since: Number(row.created_at), agent: { id: row.agent_id, name: row.name, initials: row.initials, tint: row.tint, title: row.title }, from: { id: row.home_id, name: row.home_name }, to: { id: row.target_id, name: row.target_name, slug: row.target_slug } }));
    },

    async homeProject(agentId: string): Promise<string> {
      const row = await db.selectFrom('agents').innerJoin('projects', 'projects.team_id', 'agents.team_id').select('projects.id').where('agents.id', '=', agentId).executeTakeFirst();
      if (!row) throw notFound('Agent');
      return row.id;
    },

    async lend(userId: string, agentId: string, homeProjectId: string, input: z.infer<typeof SeatLoanBody>) {
      const id = newId(now());
      const published = await storage.transaction(async tx => {
        const target = await tx.selectFrom('projects').select(['id', 'parent_id']).where('id', '=', input.toProjectId).executeTakeFirst();
        if (!target) throw notFound('Project');
        if (target.parent_id !== null) throw new HttpError(400, 'invalid', 'Lend to the project, not to one of its sub-projects', { toProjectId: 'Choose a top-level project' });
        if (target.id === homeProjectId) throw new HttpError(400, 'invalid', 'The agent already works on this project', { toProjectId: 'Choose another project' });
        if (await tx.selectFrom('seat_loans').select('id').where('agent_id', '=', agentId).where('to_project_id', '=', target.id).where('state', '=', 'active').executeTakeFirst()) throw new HttpError(409, 'exists', 'The agent is already on loan to this project');
        await tx.insertInto('seat_loans').values({ id, agent_id: agentId, to_project_id: target.id, state: 'active', note: input.note, created_by: userId, created_at: now(), ended_at: null }).execute();
        return events.append(tx, [{ type: 'agent.lent', ...user(userId), agentId, projectId: target.id, payload: { loanId: id, from: homeProjectId } }]);
      });
      events.published(published);
      return id;
    },

    async loan(id: string) {
      const row = await db.selectFrom('seat_loans').selectAll().where('id', '=', id).executeTakeFirst();
      if (!row) throw notFound('Loan');
      return row;
    },

    async endLoan(userId: string, id: string) {
      const published = await storage.transaction(async tx => {
        const row = await tx.selectFrom('seat_loans').selectAll().where('id', '=', id).executeTakeFirst();
        if (!row) throw notFound('Loan');
        if (row.state !== 'active') return [];
        await tx.updateTable('seat_loans').set({ state: 'ended', ended_at: now() }).where('id', '=', id).execute();
        return events.append(tx, [{ type: 'agent.returned', ...user(userId), agentId: row.agent_id, projectId: row.to_project_id, payload: { loanId: id } }]);
      });
      events.published(published);
    },

    // The current team as template seats, ready to be saved as a team_template document.
    async teamSeats(projectId: string): Promise<{ teamName: string; seats: Seat[] }> {
      const { root, teamId } = await teamOf(db, projectId);
      if (!teamId) throw new HttpError(409, 'no_team', 'This project has no team to save');
      const agents = await db.selectFrom('agents').select(['id', 'name', 'title', 'persona', 'is_pm']).where('team_id', '=', teamId).where('status', '!=', 'retired').orderBy('sort').execute();
      if (agents.length === 0) throw new HttpError(409, 'no_team', 'This project has no team to save');
      const roles = await db.selectFrom('agent_roles').select(['agent_id', 'role_slug']).where('agent_id', 'in', agents.map(agent => agent.id)).execute();
      return { teamName: `${root.name} team`, seats: agents.map(agent => ({ name: agent.name, title: agent.title, persona: agent.persona, isPm: agent.is_pm === true, roles: roles.filter(role => role.agent_id === agent.id).map(role => role.role_slug) })) };
    },

    // "create" gives a project without a team its team; "append" adds the template's seats to the team it has. Nothing is ever replaced.
    async teamFromTemplate(userId: string, projectId: string, template: { slug: string; version: number; seats: Seat[]; name: string }, mode: z.infer<typeof FromTemplateBody>['mode']) {
      const result = await storage.transaction(async tx => {
        const { root, teamId: current } = await teamOf(tx, projectId);
        const existing = current ? await tx.selectFrom('agents').select(['sort', 'is_pm']).where('team_id', '=', current).where('status', '!=', 'retired').execute() : [];
        if (existing.length > 0 && mode === 'create') throw new HttpError(409, 'team_exists', 'This project already has a team; append the template to it instead');
        const teamId = current ?? newId(now());
        if (!current) {
          await tx.insertInto('teams').values({ id: teamId, scope: 'project', project_id: null, name: template.name, template_slug: template.slug, template_version: template.version }).execute();
          await tx.updateTable('projects').set({ team_id: teamId }).where('id', '=', root.id).execute();
        } else if (existing.length === 0) await tx.updateTable('teams').set({ template_slug: template.slug, template_version: template.version }).where('id', '=', teamId).execute();
        // A team has one PM: a template's PM only takes the flag when nobody holds it.
        let pmTaken = existing.some(agent => agent.is_pm === true);
        const start = existing.reduce((max, agent) => Math.max(max, agent.sort + 1), 0);
        const agentIds: string[] = [];
        for (const [index, item] of template.seats.entries()) {
          agentIds.push(await seat(tx, teamId, { ...item, isPm: item.isPm && !pmTaken }, start + index));
          pmTaken = pmTaken || item.isPm;
        }
        return { teamId, agentIds, published: await events.append(tx, [{ type: 'team.created_from_template', category: 'audit', ...user(userId), projectId: root.id, payload: { teamId, template: template.slug, version: template.version, seats: agentIds.length, mode } }]) };
      });
      events.published(result.published);
      return { teamId: result.teamId, agentIds: result.agentIds };
    },

    async hire(userId: string, projectId: string, library: { slug: string; doc: Omit<Seat, 'isPm'> }, input: z.infer<typeof HireBody>) {
      const result = await storage.transaction(async tx => {
        const { root, teamId } = await teamOf(tx, projectId);
        if (!teamId) throw new HttpError(409, 'no_team', 'Create a team for this project before hiring into it');
        const last = await tx.selectFrom('agents').select(eb => eb.fn.max('sort').as('sort')).where('team_id', '=', teamId).executeTakeFirst();
        const agentId = await seat(tx, teamId, { ...library.doc, name: input.name ?? library.doc.name, isPm: false }, Number(last?.sort ?? -1) + 1);
        return { agentId, published: await events.append(tx, [{ type: 'agent.hired', ...user(userId), agentId, projectId: root.id, payload: { library: library.slug } }]) };
      });
      events.published(result.published);
      return result.agentId;
    },

    // Audit-category events by default, newest first; `all` widens it to everything a person did. The cursor is the seq to continue below.
    async audit(filter: { after?: number | undefined; limit: number; all?: boolean; actor?: string | undefined; type?: string | undefined; projectId?: string | undefined; from?: number | undefined; to?: number | undefined }) {
      let query = db.selectFrom('events').leftJoin('users', 'users.id', 'events.user_id').leftJoin('projects', 'projects.id', 'events.project_id')
        .select(['events.seq', 'events.at', 'events.type', 'events.category', 'events.actor_kind', 'events.user_id', 'events.agent_id', 'events.project_id', 'events.task_id', 'events.thread_id', 'events.payload', 'users.name as user_name', 'users.email as user_email', 'projects.name as project_name']);
      query = filter.all ? query.where(eb => eb.or([eb('events.category', '=', 'audit'), eb('events.user_id', 'is not', null)])) : query.where('events.category', '=', 'audit');
      if (filter.after !== undefined) query = query.where('events.seq', '<', filter.after);
      if (filter.actor) query = query.where('events.user_id', '=', filter.actor);
      if (filter.type) query = query.where('events.type', 'like', `${filter.type.replace(/[%_]/g, '')}%`);
      if (filter.projectId) query = query.where('events.project_id', '=', filter.projectId);
      if (filter.from !== undefined) query = query.where('events.at', '>=', filter.from);
      if (filter.to !== undefined) query = query.where('events.at', '<=', filter.to);
      const rows = await query.orderBy('events.seq', 'desc').limit(filter.limit + 1).execute();
      const page = rows.slice(0, filter.limit);
      return {
        entries: page.map(row => {
          const payload = JSON.parse(row.payload) as Record<string, unknown>;
          const named = ['email', 'name', 'slug', 'label', 'subject', 'library', 'template'].map(key => payload[key]).find(value => typeof value === 'string') as string | undefined;
          return { seq: Number(row.seq), at: Number(row.at), action: row.type, category: row.category, actor: { kind: row.actor_kind, id: row.user_id ?? row.agent_id, name: row.user_name ?? (row.actor_kind === 'user' ? 'Unknown person' : row.actor_kind), email: row.user_email }, target: named ?? row.project_name ?? row.task_id ?? row.thread_id ?? null, project: row.project_id ? { id: row.project_id, name: row.project_name } : null, payload };
        }),
        next: rows.length > filter.limit ? Number(page.at(-1)!.seq) : null,
      };
    },
  };
}
export type Org = ReturnType<typeof createOrg>;
