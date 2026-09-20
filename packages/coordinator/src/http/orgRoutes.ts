import type { Context as Hc, Hono } from 'hono';
import { z } from 'zod';
import { WORKER_FRESH_MS } from '../runtime/scheduler.ts';
import { AgentBody, AgentPatch, AuthSettingsBody, DelegationRules, FromTemplateBody, HireBody, MachineTokenBody, MilestoneBody, MilestonePatch, ProjectLinkBody, ProjectMemberBody, ProjectStatusBody, SaveTemplateBody, SeatLoanBody, StaffingLimitsBody, TeamOrderBody, UserPatch, VersionedDocBody, type StoredEvent, type TeamView } from '@agent-team/protocol';
import type { MachineTokens } from '../auth/machineTokens.ts';
import { createMembers } from '../auth/members.ts';
import { createAuthSettings } from '../auth/authSettings.ts';
import { can, canSeeProject, type Action, type Viewer } from '../auth/rbac.ts';
import { forbidden, HttpError, type Context } from '../context.ts';
import { createOrg } from '../repos/org.ts';
import { staffingSeat } from '../runtime/staffing.ts';
import { RULES_SLUG } from '../runtime/turns.ts';
import type { VersionedDocs } from '../repos/versionedDocs.ts';
import type { createWorkspace } from '../repos/workspace.ts';
import { ifMatch, pageOf, parseBody, preconditioned } from './conventions.ts';

type Env = { Variables: { viewer: Viewer } };
const LIBRARY = { type: 'library' as const, id: '' };
const SETTINGS_SLUG = 'settings';

// Members, sign-in settings, machine credentials, audit, project settings and the organization's structure. Mounted behind the session middleware.
export function registerOrgRoutes(app: Hono<Env>, context: Context, deps: { workspace: ReturnType<typeof createWorkspace>; docs: VersionedDocs; machineTokens: MachineTokens }) {
  const { workspace, docs, machineTokens } = deps;
  const db = context.storage.db;
  const org = createOrg(context), members = createMembers(context), authSettings = createAuthSettings(context);
  const allow = (c: Hc<Env>, action: Action, projectId?: string) => { if (!can(c.get('viewer'), action, projectId)) throw forbidden(); };
  const me = (c: Hc<Env>) => c.get('viewer').userId;
  const authorName = async (c: Hc<Env>) => (await db.selectFrom('users').select('name').where('id', '=', me(c)).executeTakeFirstOrThrow()).name;
  // Grants live on top-level projects; a sub-project answers to its parent's.
  const rootOf = async (projectId: string) => { const row = await db.selectFrom('projects').select(['id', 'parent_id']).where('id', '=', projectId).executeTakeFirst(); if (!row) throw new HttpError(404, 'not_found', 'Project not found'); return row.parent_id ?? row.id; };
  const projectFor = async (c: Hc<Env>, action: Action) => { const project = await workspace.project(c.req.param('slug')!); allow(c, action, project.parent_id ?? project.id); return project; };
  const visibleTo = async (viewer: Viewer) => { const roots = new Map((await db.selectFrom('projects').select(['id', 'parent_id']).execute()).map(row => [row.id, row.parent_id ?? row.id])); return (projectId: string) => canSeeProject(viewer, roots.get(projectId) ?? projectId); };

  // Members and invitations.
  app.get('/api/users', async c => { allow(c, 'org.members'); return c.json(await members.list()); });
  app.post('/api/users/:id', async c => { allow(c, 'org.members'); await members.patch(c.get('viewer'), c.req.param('id'), await parseBody(c, UserPatch)); return c.json({ ok: true }); });
  app.post('/api/invites/:id/revoke', async c => { allow(c, 'org.members'); await members.revokeInvite(c.get('viewer'), c.req.param('id')); return c.json({ ok: true }); });
  app.get('/api/projects/:slug/members', async c => { const project = await projectFor(c, 'project.members'); return c.json(await members.ofProject(project.parent_id ?? project.id)); });
  app.post('/api/projects/:slug/members', async c => { const project = await projectFor(c, 'project.members'); await members.grant(c.get('viewer'), project.parent_id ?? project.id, await parseBody(c, ProjectMemberBody)); return c.json({ ok: true }); });

  // How people sign in. Admins read it; only the owner changes it. The trusted header is deployment configuration and is shown, never set, here.
  app.get('/api/settings/auth', async c => {
    allow(c, 'org.members');
    return c.json({ oidc: await authSettings.oidc(), password: { minimumLength: 12 }, trustedHeader: { enabled: context.trustedHeader !== null, header: context.trustedHeader }, secureCookies: context.secureCookies, canEdit: can(c.get('viewer'), 'org.settings') });
  });
  app.post('/api/settings/auth', async c => { allow(c, 'org.settings'); await authSettings.save(me(c), await parseBody(c, AuthSettingsBody)); return c.json({ ok: true }); });

  app.get('/api/machine-tokens', async c => { allow(c, 'org.members'); return c.json({ tokens: await machineTokens.list() }); });
  app.post('/api/machine-tokens', async c => { allow(c, 'org.members'); return c.json(await machineTokens.create(c.get('viewer'), await parseBody(c, MachineTokenBody))); });
  app.post('/api/machine-tokens/:id/revoke', async c => { allow(c, 'org.members'); await machineTokens.revoke(c.get('viewer'), c.req.param('id')); return c.json({ ok: true }); });

  const when = (value: string | undefined) => { const at = value ? Date.parse(value) : NaN; return Number.isFinite(at) ? at : undefined; };
  app.get('/api/audit', async c => {
    allow(c, 'org.members');
    return c.json(await org.audit({ ...pageOf(c), all: c.req.query('all') === '1', actor: c.req.query('actor') || undefined, type: c.req.query('type') || undefined, projectId: c.req.query('project') || undefined, from: when(c.req.query('from')), to: when(c.req.query('to')) }));
  });
  // The domain log a page at a time, oldest first, for the projects the viewer can see; the stream is the live tail of the same list.
  app.get('/api/events', async c => {
    const page = pageOf(c), visible = await visibleTo(c.get('viewer'));
    // A 1:1 with an agent is its author's alone.
    const hidden = new Set((await db.selectFrom('threads').select('id').where('visibility', '=', 'private').where(eb => eb.or([eb('owner_user_id', 'is', null), eb('owner_user_id', '!=', c.get('viewer').userId)])).execute()).map(row => row.id));
    const shown = (event: StoredEvent) => event.category === 'domain' && (event.projectId === null || visible(event.projectId)) && !(event.threadId && hidden.has(event.threadId));
    const events: StoredEvent[] = [];
    let cursor = page.after ?? 0, next: number | null = null;
    scan: for (;;) {
      const batch = await context.events.read({ after: cursor, limit: 500 });
      for (const event of batch) {
        if (events.length >= page.limit) { next = cursor; break scan; }
        cursor = event.seq;
        if (shown(event)) events.push(event);
      }
      if (batch.length < 500) break;
    }
    return c.json({ events, next });
  });

  // Project settings: one versioned document per top-level project, plus its status.
  app.get('/api/projects/:slug/settings', async c => {
    const project = await projectFor(c, 'project.read');
    const rootId = project.parent_id ?? project.id;
    const root = await db.selectFrom('projects').select(['id', 'slug', 'name', 'kind', 'status']).where('id', '=', rootId).executeTakeFirstOrThrow();
    const stored = await docs.get('project_settings', { type: 'project', id: rootId }, SETTINGS_SLUG).catch(() => null);
    const viewer = c.get('viewer');
    return c.json({ project: root, version: stored?.version ?? 0, settings: stored?.doc ?? { description: '', customTabs: [] }, author: stored?.author ?? null, history: stored ? await docs.history('project_settings', { type: 'project', id: rootId }, SETTINGS_SLUG, 10) : [], can: { configure: can(viewer, 'project.configure', rootId), members: can(viewer, 'project.members', rootId), archive: can(viewer, 'org.members') } });
  });
  app.post('/api/projects/:slug/settings', async c => {
    const project = await projectFor(c, 'project.configure');
    const rootId = project.parent_id ?? project.id, expected = ifMatch(c), input = await parseBody(c, VersionedDocBody);
    const version = await preconditioned(expected, async () => docs.save('project_settings', { type: 'project', id: rootId }, SETTINGS_SLUG, input.doc, { author: await authorName(c), userId: me(c), projectId: rootId, ...(input.note ? { note: input.note } : {}), ...(expected !== undefined ? { expectedVersion: expected } : {}) }));
    return c.json({ version });
  });
  // Pausing and resuming is the project admin's; archiving takes a project off every board, so it is the organization's.
  app.post('/api/projects/:slug/status', async c => {
    const project = await projectFor(c, 'project.configure');
    const input = await parseBody(c, ProjectStatusBody);
    if (input.status === 'archived' || project.status === 'archived') allow(c, 'org.members');
    await org.setStatus(me(c), project.id, input.status);
    return c.json({ ok: true });
  });

  app.get('/api/projects/:slug/milestones', async c => {
    const project = await projectFor(c, 'project.read');
    const subs = await db.selectFrom('projects').select('id').where('parent_id', '=', project.id).execute();
    return c.json({ milestones: await org.milestones([project.id, ...subs.map(sub => sub.id)]) });
  });
  app.post('/api/projects/:slug/milestones', async c => { const project = await projectFor(c, 'project.configure'); return c.json({ id: await org.createMilestone(me(c), project.id, await parseBody(c, MilestoneBody)) }); });
  app.post('/api/milestones/:id', async c => { allow(c, 'project.configure', await rootOf((await org.milestone(c.req.param('id'))).project_id)); await org.updateMilestone(me(c), c.req.param('id'), await parseBody(c, MilestonePatch)); return c.json({ ok: true }); });
  app.post('/api/milestones/:id/delete', async c => { allow(c, 'project.configure', await rootOf((await org.milestone(c.req.param('id'))).project_id)); await org.deleteMilestone(me(c), c.req.param('id')); return c.json({ ok: true }); });

  // Archived projects leave every list; this is where an administrator finds them again to restore one.
  app.get('/api/org/archived', async c => {
    allow(c, 'org.members');
    const rows = await db.selectFrom('projects').select(['id', 'slug', 'name', 'kind', 'parent_id']).where('status', '=', 'archived').orderBy('name').execute();
    const parents = new Map((await db.selectFrom('projects').select(['id', 'name']).execute()).map(row => [row.id, row.name]));
    return c.json({ projects: rows.map(row => ({ id: row.id, slug: row.slug, name: row.name, kind: row.kind, parentName: row.parent_id ? parents.get(row.parent_id) ?? null : null })) });
  });

  // What the Org page adds to /api/org: the edges between projects and the seats on loan.
  app.get('/api/org/structure', async c => { const visible = await visibleTo(c.get('viewer')); return c.json({ links: await org.links(visible), loans: await org.loans(visible) }); });
  app.post('/api/org/links', async c => {
    const input = await parseBody(c, ProjectLinkBody);
    allow(c, 'project.configure', await rootOf(input.fromProjectId));
    allow(c, 'project.read', await rootOf(input.toProjectId));
    return c.json({ id: await org.link(me(c), input) });
  });
  app.post('/api/org/links/:id/delete', async c => { allow(c, 'project.configure', await rootOf((await org.linkById(c.req.param('id'))).from_project_id)); await org.unlink(me(c), c.req.param('id')); return c.json({ ok: true }); });

  // Lending takes the say of both sides: whoever configures the agent's project and whoever configures the one it goes to.
  app.post('/api/agents/:id/loans', async c => {
    const home = await org.homeProject(c.req.param('id')), input = await parseBody(c, SeatLoanBody);
    allow(c, 'project.configure', home);
    allow(c, 'project.configure', await rootOf(input.toProjectId));
    return c.json({ id: await org.lend(me(c), c.req.param('id'), home, input) });
  });
  // Either side may end a loan.
  app.post('/api/loans/:id/end', async c => {
    const loan = await org.loan(c.req.param('id')), viewer = c.get('viewer');
    if (!can(viewer, 'project.configure', loan.to_project_id) && !can(viewer, 'project.configure', await org.homeProject(loan.agent_id))) throw forbidden();
    await org.endLoan(viewer.userId, loan.id);
    return c.json({ ok: true });
  });
  app.get('/api/projects/:slug/loans', async c => {
    const project = await projectFor(c, 'project.read'), rootId = project.parent_id ?? project.id;
    const loans = await org.loans(id => id === rootId);
    const viewer = c.get('viewer');
    const targets = (await workspace.projectTree(viewer)).filter(node => node.id !== rootId && can(viewer, 'project.configure', node.id)).map(node => ({ id: node.id, name: node.name }));
    return c.json({ borrowed: loans.filter(loan => loan.to.id === rootId), lent: loans.filter(loan => loan.from.id === rootId), targets, canEdit: can(viewer, 'project.configure', rootId) });
  });

  // Team templates and the agent library are organization-wide documents: everyone reads, admins write.
  for (const [route, kind] of [['templates', 'team_template'], ['library/agents', 'library_agent']] as const) {
    app.get(`/api/${route}`, async c => c.json({ items: await docs.list(kind, LIBRARY) }));
    app.get(`/api/${route}/:slug`, async c => c.json(await docs.get(kind, LIBRARY, c.req.param('slug'))));
    // Saving is also how a document is imported: the body is the exported JSON.
    app.post(`/api/${route}/:slug`, async c => {
      allow(c, 'org.members');
      const slug = c.req.param('slug'), expected = ifMatch(c), input = await parseBody(c, VersionedDocBody);
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) throw new HttpError(400, 'invalid', 'A slug is lowercase letters, digits and dashes', { slug: 'Lowercase letters, digits and dashes' });
      const version = await preconditioned(expected, async () => docs.save(kind, LIBRARY, slug, input.doc, { author: await authorName(c), userId: me(c), ...(input.note ? { note: input.note } : {}), ...(expected !== undefined ? { expectedVersion: expected } : {}) }));
      return c.json({ version });
    });
  }
  app.get('/api/templates/:slug/export', async c => {
    const stored = await docs.get('team_template', LIBRARY, c.req.param('slug'));
    return c.body(JSON.stringify({ kind: 'team_template', slug: stored.slug, version: stored.version, doc: stored.doc }, null, 2), 200, { 'content-type': 'application/json', 'content-disposition': `attachment; filename="${stored.slug}.team-template.json"` });
  });
  app.post('/api/projects/:slug/team/save-template', async c => {
    const project = await projectFor(c, 'project.configure');
    const input = await parseBody(c, SaveTemplateBody), current = await org.teamSeats(project.id);
    // A project admin may add a template to the library but never overwrite one; that stays with the organization's admins.
    if (!can(c.get('viewer'), 'org.members') && await docs.get('team_template', LIBRARY, input.slug).catch(() => null)) throw new HttpError(409, 'exists', 'A template with this slug already exists', { slug: 'Choose another slug' });
    const version = await docs.save('team_template', LIBRARY, input.slug, { name: input.name, summary: input.summary, seats: current.seats }, { author: await authorName(c), userId: me(c), projectId: project.parent_id ?? project.id, note: `Saved from ${current.teamName}` });
    return c.json({ slug: input.slug, version });
  });
  app.post('/api/projects/:slug/team/from-template', async c => {
    const project = await projectFor(c, 'project.configure');
    const input = await parseBody(c, FromTemplateBody), template = await docs.get('team_template', LIBRARY, input.template);
    return c.json(await org.teamFromTemplate(me(c), project.id, { slug: template.slug, version: template.version, name: template.doc.name, seats: template.doc.seats }, input.mode));
  });
  // Team editing by hand: whoever configures the project makes, changes, orders, rests and retires its seats, and says which one is the PM.
  const delegationRules = async (rootId: string) => DelegationRules.parse((await docs.get('delegation_rules', { type: 'project', id: rootId }, RULES_SLUG).catch(() => null))?.doc ?? {});
  const roleLibrary = async () => (await docs.list('role', LIBRARY)).map(role => ({ slug: role.slug, summary: String((role.doc as { summary?: unknown }).summary ?? '') }));
  app.get('/api/projects/:slug/team', async c => {
    const project = await projectFor(c, 'project.read'), team = await org.team(project.id);
    // What "the worker decides" means right now: the tool each worker of this project runs by default, and that tool's own default model.
    const workers = await context.storage.db.selectFrom('workers').select(['name', 'projects', 'providers']).where('last_seen_at', '>', context.now() - WORKER_FRESH_MS).execute();
    const workerRuns = workers.filter(worker => (JSON.parse(worker.projects) as string[]).includes(project.id)).flatMap(worker => { const said = JSON.parse(worker.providers) as { runs?: { engine: string; model: string | null }; efforts?: Record<string, string[]> } | unknown[]; return Array.isArray(said) || !said.runs ? [] : [{ worker: worker.name, engine: said.runs.engine, model: said.runs.model, efforts: said.efforts?.[said.runs.engine] ?? [] }]; });
    const rules = await delegationRules(team.rootId);
    return c.json({ seats: team.seats, fallback: team.fallback, workerRuns, roles: await roleLibrary(), canEdit: can(c.get('viewer'), 'project.configure', team.rootId), staffing: { seat: await staffingSeat(db, project.id), decides: rules.staffing.decides, maxSeats: rules.staffing.maxSeats } } satisfies TeamView);
  });
  // What the seat that staffs the team may decide without the owner. The rest of the delegation rules stay as they are.
  app.post('/api/projects/:slug/team/staffing', async c => {
    const project = await projectFor(c, 'project.configure'), rootId = project.parent_id ?? project.id, input = await parseBody(c, StaffingLimitsBody);
    await docs.save('delegation_rules', { type: 'project', id: rootId }, RULES_SLUG, { ...await delegationRules(rootId), staffing: input }, { author: await authorName(c), userId: me(c), projectId: rootId });
    return c.json({ ok: true });
  });
  app.post('/api/projects/:slug/team/default', async c => {
    const project = await projectFor(c, 'project.configure');
    await org.setTeamDefault(me(c), project.id, await parseBody(c, z.object({ providerId: z.string().max(60).nullable(), model: z.string().max(120).nullable(), effort: z.string().regex(/^[a-z]{2,12}$/).nullable().optional() })));
    return c.json({ ok: true });
  });
  app.post('/api/projects/:slug/team/agents', async c => {
    const project = await projectFor(c, 'project.configure');
    return c.json({ id: await org.createAgent(me(c), project.id, await parseBody(c, AgentBody), (await roleLibrary()).map(role => role.slug)) });
  });
  app.post('/api/projects/:slug/team/order', async c => { const project = await projectFor(c, 'project.configure'); await org.reorder(me(c), project.id, (await parseBody(c, TeamOrderBody)).agentIds); return c.json({ ok: true }); });
  app.post('/api/agents/:id', async c => {
    const home = await org.homeProject(c.req.param('id'));
    allow(c, 'project.configure', home);
    await org.updateAgent(me(c), c.req.param('id'), home, await parseBody(c, AgentPatch), (await roleLibrary()).map(role => role.slug));
    return c.json({ ok: true });
  });
  app.post('/api/agents/:id/pm', async c => { const home = await org.homeProject(c.req.param('id')); allow(c, 'project.configure', home); await org.makePm(me(c), c.req.param('id'), home); return c.json({ ok: true }); });
  app.post('/api/projects/:slug/team/hire', async c => {
    const project = await projectFor(c, 'project.configure');
    const input = await parseBody(c, HireBody), library = await docs.get('library_agent', LIBRARY, input.library);
    return c.json({ id: await org.hire(me(c), project.id, { slug: library.slug, doc: library.doc }, input) });
  });
}
