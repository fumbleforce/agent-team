import { readFileSync } from 'node:fs';
import path from 'node:path';
import { BOARD_COLUMNS, newId, packageRoot, type BoardColumn, type MessageKind, type MessageView, type TaskState } from '@agent-team/protocol';
import { HttpError, notFound, type Context } from '../context.ts';
import { canSeeProject, type Viewer } from '../auth/rbac.ts';
import { indexMessage } from '../knowledge/indexing.ts';

interface Blueprint { slug: string; name: string; seats: { name: string; title: string; isPm?: boolean; roles: string[]; persona: string }[] }
const defaultTeam = (): Blueprint => JSON.parse(readFileSync(path.join(packageRoot(), 'blueprints', 'default-team.json'), 'utf8'));

const DONE: readonly string[] = BOARD_COLUMNS.done;
const OPEN_STATES: readonly string[] = [...BOARD_COLUMNS.backlog, ...BOARD_COLUMNS.in_progress, ...BOARD_COLUMNS.review, ...BOARD_COLUMNS.done];

export function createWorkspace(context: Context) {
  const { storage, events, now } = context;
  const db = storage.db;

  return {
    async org() {
      return (await db.selectFrom('org').select(['name', 'accent', 'currency']).executeTakeFirst()) ?? null;
    },

    // Sidebar: projects with their sub-projects, team name and size, and progress as done over total tasks.
    async projectTree(viewer: Viewer) {
      const projects = (await db.selectFrom('projects').leftJoin('teams', 'teams.id', 'projects.team_id')
        .select(['projects.id', 'projects.slug', 'projects.name', 'projects.kind', 'projects.parent_id', 'projects.status', 'projects.team_id', 'teams.name as team_name'])
        .where('projects.status', '!=', 'archived').orderBy('projects.sort').execute())
        .filter(project => canSeeProject(viewer, project.parent_id ?? project.id));
      const counts = await db.selectFrom('tasks').select(['project_id', 'state']).select(eb => eb.fn.countAll<number>().as('n')).where('state', 'in', [...OPEN_STATES]).groupBy(['project_id', 'state']).execute();
      const seats = await db.selectFrom('agents').select('team_id').select(eb => eb.fn.countAll<number>().as('n')).where('status', '!=', 'retired').groupBy('team_id').execute();
      const progress = (ids: string[]) => {
        const rows = counts.filter(row => ids.includes(row.project_id));
        const total = rows.reduce((sum, row) => sum + Number(row.n), 0);
        return total === 0 ? 0 : rows.filter(row => DONE.includes(row.state)).reduce((sum, row) => sum + Number(row.n), 0) / total;
      };
      return projects.filter(project => project.parent_id === null).map(project => {
        const children = projects.filter(child => child.parent_id === project.id);
        return {
          id: project.id, slug: project.slug, name: project.name, kind: project.kind, status: project.status,
          team: project.team_name ? { id: project.team_id, name: project.team_name, seats: Number(seats.find(row => row.team_id === project.team_id)?.n ?? 0) } : null,
          progress: progress([project.id, ...children.map(child => child.id)]),
          subprojects: children.map(child => ({ id: child.id, slug: child.slug, name: child.name, progress: progress([child.id]) })),
        };
      });
    },

    // Idempotent: a worker or the CLI registers what the repository says the project is.
    async registerProject(input: { slug: string; name: string; kind: string; manifest: Record<string, unknown> }) {
      const existing = await db.selectFrom('projects').select('id').where('slug', '=', input.slug).executeTakeFirst();
      if (existing) {
        await db.updateTable('projects').set({ name: input.name, manifest: JSON.stringify(input.manifest) }).where('id', '=', existing.id).execute();
        return existing.id;
      }
      const id = newId(now()), teamId = newId(now());
      const published = await storage.transaction(async tx => {
        // A new project starts with the default team; seats are data and can be changed afterwards.
        const blueprint = defaultTeam();
        await tx.insertInto('teams').values({ id: teamId, scope: 'project', project_id: null, name: `${input.name} team`, template_slug: blueprint.slug, template_version: 1 }).execute();
        for (const [index, seat] of blueprint.seats.entries()) {
          const agentId = newId(now());
          await tx.insertInto('agents').values({ id: agentId, team_id: teamId, name: seat.name, initials: seat.name.slice(0, 2).toUpperCase(), tint: String(index + 1), title: seat.title, persona: seat.persona, status: 'active', provider_id: null, model: null, daily_cap_minor: null, is_pm: seat.isPm === true, doing: null, sort: index, created_at: now() }).execute();
          for (const role of seat.roles) await tx.insertInto('agent_roles').values({ agent_id: agentId, role_slug: role }).execute();
        }
        await tx.insertInto('projects').values({ id, slug: input.slug, name: input.name, kind: input.kind, parent_id: null, status: 'active', manifest: JSON.stringify(input.manifest), manifest_sha: null, team_id: teamId, sort: 0, created_at: now() }).execute();
        await tx.insertInto('threads').values({ id: newId(now()), project_id: id, kind: 'discussion', subject_type: null, subject_id: null, title: `#${input.slug}`, visibility: 'team', owner_user_id: null, created_at: now() }).execute();
        return events.append(tx, [{ type: 'project.registered', actorKind: 'system', projectId: id, payload: { slug: input.slug } }]);
      });
      events.published(published);
      return id;
    },

    async project(slug: string) {
      const project = await db.selectFrom('projects').selectAll().where('slug', '=', slug).executeTakeFirst();
      if (!project) throw notFound('Project');
      return project;
    },

    async pm(projectId: string): Promise<string | null> {
      const project = await db.selectFrom('projects').select(['team_id', 'parent_id']).where('id', '=', projectId).executeTakeFirst();
      const teamId = project?.team_id ?? (project?.parent_id ? (await db.selectFrom('projects').select('team_id').where('id', '=', project.parent_id).executeTakeFirst())?.team_id : null);
      if (!teamId) return null;
      return (await db.selectFrom('agents').select('id').where('team_id', '=', teamId).where('is_pm', '=', true).where('status', '=', 'active').executeTakeFirst())?.id ?? null;
    },

    async roster(teamId: string) {
      return db.selectFrom('agents').select(['id', 'name', 'initials', 'tint', 'title', 'persona', 'status', 'provider_id', 'model', 'is_pm', 'doing'])
        .where('team_id', '=', teamId).where('status', '!=', 'retired').orderBy('sort').execute();
    },

    async board(projectId: string) {
      const tasks = await db.selectFrom('tasks').select(['id', 'key', 'title', 'tag', 'state', 'assignee_agent_id', 'blocked_reason', 'priority', 'updated_at'])
        .where('project_id', '=', projectId).where('state', 'in', [...OPEN_STATES]).orderBy('priority').orderBy('updated_at', 'desc').execute();
      return Object.fromEntries(Object.entries(BOARD_COLUMNS).map(([column, states]) => [column, tasks.filter(task => (states as readonly string[]).includes(task.state))])) as Record<BoardColumn, typeof tasks>;
    },

    async moveTask(viewer: Viewer, taskId: string, state: TaskState) {
      const published = await storage.transaction(async tx => {
        const task = await tx.selectFrom('tasks').select(['id', 'project_id', 'state']).where('id', '=', taskId).executeTakeFirst();
        if (!task) throw notFound('Task');
        await tx.updateTable('tasks').set({ state, updated_at: now() }).where('id', '=', taskId).execute();
        return events.append(tx, [{ type: 'task.state_changed', actorKind: 'user', userId: viewer.userId, projectId: task.project_id, taskId, payload: { from: task.state, to: state } }]);
      });
      events.published(published);
    },

    // Assigning is what starts work: the agent gets a work item for the task.
    async assignTask(viewer: Viewer, taskId: string, agentId: string) {
      const published = await storage.transaction(async tx => {
        const task = await tx.selectFrom('tasks').select(['id', 'project_id', 'state', 'blocked_reason']).where('id', '=', taskId).executeTakeFirst();
        if (!task) throw notFound('Task');
        // Held in the backlog means not to be worked on yet; handing it to someone would start exactly that.
        if (task.state === 'backlog' && task.blocked_reason) throw new HttpError(409, 'conflict', `This task is held: ${task.blocked_reason}. Approve it in the tracker (or lift the hold there) first.`);
        await tx.updateTable('tasks').set({ assignee_agent_id: agentId, state: task.state === 'backlog' ? 'assigned' : task.state, updated_at: now() }).where('id', '=', taskId).execute();
        return { projectId: task.project_id, events: await events.append(tx, [{ type: 'task.assigned', actorKind: 'user', userId: viewer.userId, projectId: task.project_id, taskId, agentId }]) };
      });
      events.published(published.events);
      return published.projectId;
    },

    async discussion(projectId: string) {
      const thread = await db.selectFrom('threads').selectAll().where('project_id', '=', projectId).where('kind', '=', 'discussion').executeTakeFirst();
      if (!thread) throw notFound('Discussion');
      return thread;
    },

    async thread(threadId: string) {
      const thread = await db.selectFrom('threads').selectAll().where('id', '=', threadId).executeTakeFirst();
      if (!thread) throw notFound('Thread');
      return thread;
    },

    async messages(threadId: string, options: { after?: number; limit: number }) {
      const rows = await db.selectFrom('messages').selectAll().where('thread_id', '=', threadId).where('seq', '>', options.after ?? 0).orderBy('seq').limit(options.limit).execute();
      return rows.map((row): MessageView => ({ id: row.id, seq: Number(row.seq), authorKind: row.author_kind as MessageView['authorKind'], authorId: row.author_id, kind: row.kind, body: row.body, payload: JSON.parse(row.payload), createdAt: Number(row.created_at) }));
    },

    async postMessage(author: { kind: 'user' | 'agent' | 'system'; id: string | null }, thread: { id: string; project_id: string | null }, input: { body: string; kind: MessageKind; payload?: Record<string, unknown> }) {
      const id = newId(now());
      const published = await storage.transaction(async tx => {
        await tx.insertInto('messages').values({ id, thread_id: thread.id, author_kind: author.kind, author_id: author.id, kind: input.kind, body: input.body, payload: JSON.stringify(input.payload ?? {}), created_at: now() }).execute();
        if (author.kind !== 'system') await indexMessage(storage, tx, { id, threadId: thread.id, body: input.body });
        return events.append(tx, [{ type: 'message.posted', actorKind: author.kind, userId: author.kind === 'user' ? author.id : null, agentId: author.kind === 'agent' ? author.id : null, projectId: thread.project_id, threadId: thread.id, payload: { messageId: id, kind: input.kind } }]);
      });
      events.published(published);
      return id;
    },
  };
}
export type Workspace = ReturnType<typeof createWorkspace>;
