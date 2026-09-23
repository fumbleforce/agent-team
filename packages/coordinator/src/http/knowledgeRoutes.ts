import type { Context as Hc, Hono } from 'hono';
import { z } from 'zod';
import { MemoryActionBody, WritePageBody } from '@agent-team/protocol';
import { can, type Action, type Viewer } from '../auth/rbac.ts';
import { forbidden, HttpError, type Context } from '../context.ts';
import type { Knowledge, Scope } from '../knowledge/knowledge.ts';
import type { createWorkspace } from '../repos/workspace.ts';
import { parseBody } from './conventions.ts';

type Env = { Variables: { viewer: Viewer } };
type ScopeKey = 'subproject' | 'project' | 'team' | 'org';
interface ScopeChoice { key: ScopeKey; label: string; note: string; scope: Scope }

// Knowledge as a project's people see it: pages and memories at each level the project belongs to, history, search and
// the decisions a page may point at. Mounted behind the session middleware.
export function registerKnowledgeRoutes(app: Hono<Env>, context: Context, deps: { workspace: ReturnType<typeof createWorkspace>; knowledge: Knowledge }) {
  const { workspace, knowledge } = deps;
  const db = context.storage.db;

  // The levels a project's knowledge comes from, nearest first: the sub-project itself, its project, the team that
  // works on it and the organization. Reading any of them takes the right to read the project; writing to the
  // organization's pages takes an organization admin, everything else the right to contribute to the project.
  async function scopesOf(project: { id: string; name: string; parent_id: string | null; team_id: string | null }): Promise<ScopeChoice[]> {
    const root = project.parent_id ? await db.selectFrom('projects').select(['id', 'name', 'team_id']).where('id', '=', project.parent_id).executeTakeFirstOrThrow() : project;
    const team = root.team_id ? await db.selectFrom('teams').select(['id', 'name']).where('id', '=', root.team_id).executeTakeFirst() : null;
    const org = await db.selectFrom('org').select('name').executeTakeFirst();
    return [
      ...(project.parent_id ? [{ key: 'subproject' as const, label: project.name, note: 'Only this part of the project', scope: { type: 'subproject' as const, id: project.id } }] : []),
      { key: 'project', label: root.name, note: 'The whole project', scope: { type: 'project', id: root.id } },
      ...(team ? [{ key: 'team' as const, label: team.name, note: 'Shared by the team across its projects', scope: { type: 'team' as const, id: team.id } }] : []),
      { key: 'org', label: org?.name ?? 'Organization', note: 'Shared by everyone in the organization', scope: { type: 'org', id: '' } },
    ];
  }
  const mayWrite = (viewer: Viewer, key: ScopeKey, rootId: string) => (key === 'org' ? can(viewer, 'org.members') : can(viewer, 'project.contribute', rootId));

  async function projectFor(c: Hc<Env>, action: Action) {
    const project = await workspace.project(c.req.param('slug')!);
    const rootId = project.parent_id ?? project.id;
    if (!can(c.get('viewer'), action, rootId)) throw forbidden();
    const scopes = await scopesOf(project);
    return { project, rootId, scopes, own: scopes[0]! };
  }
  // The level named in the query, or the project's own. Writing checks the level's own rule.
  async function scopeFor(c: Hc<Env>, action: Action) {
    const found = await projectFor(c, action);
    const key = c.req.query('scope');
    const chosen = key ? found.scopes.find(item => item.key === key) : found.own;
    if (!chosen) throw new HttpError(400, 'scope', 'This project has no knowledge at that level');
    if (action !== 'project.read' && !mayWrite(c.get('viewer'), chosen.key, found.rootId)) throw forbidden();
    return { ...found, chosen };
  }
  const within = (scopes: ScopeChoice[], at: Scope | null) => (at ? scopes.find(item => item.scope.type === at.type && item.scope.id === at.id) : undefined);
  // A page is reachable from a project only when it lives at one of the project's levels.
  async function pageFor(c: Hc<Env>, action: Action) {
    const found = await projectFor(c, action), pageId = c.req.param('id')!;
    const level = within(found.scopes, await knowledge.pageScope(pageId));
    if (!level) throw new HttpError(404, 'not_found', 'Page not found');
    if (action !== 'project.read' && !mayWrite(c.get('viewer'), level.key, found.rootId)) throw forbidden();
    return { ...found, pageId, level };
  }
  const author = (c: Hc<Env>) => ({ kind: 'user' as const, id: c.get('viewer').userId });
  const revOf = (c: Hc<Env>) => { const rev = Number(c.req.param('rev')); if (!Number.isInteger(rev) || rev < 1) throw new HttpError(404, 'not_found', 'Revision not found'); return rev; };

  app.get('/api/projects/:slug/knowledge', async c => {
    const { scopes, chosen, rootId } = await scopeFor(c, 'project.read');
    const memories = (await knowledge.memories(chosen.scope)).map(row => ({ ...row, hits: Number(row.hits), score: Number(row.score), lastHitAt: row.last_hit_at === null ? null : Number(row.last_hit_at), createdAt: Number(row.created_at), roleSlug: row.role_slug, supersededBy: row.superseded_by, supersedeReason: row.supersede_reason }));
    return c.json({ scopes: scopes.map(({ key, label, note }) => ({ key, label, note })), scope: chosen.key, canWrite: mayWrite(c.get('viewer'), chosen.key, rootId), pages: await knowledge.tree(chosen.scope), memories, seq: await context.events.head() });
  });
  app.post('/api/projects/:slug/knowledge', async c => {
    const { chosen } = await scopeFor(c, 'project.contribute');
    return c.json(await knowledge.write(author(c), { scope: chosen.scope, ...(await parseBody(c, WritePageBody)) }));
  });
  app.get('/api/projects/:slug/knowledge/pages/:id', async c => {
    const { pageId, level, rootId } = await pageFor(c, 'project.read');
    return c.json({ page: await knowledge.read(pageId), history: await knowledge.history(pageId), scope: level.key, canWrite: mayWrite(c.get('viewer'), level.key, rootId) });
  });
  app.get('/api/projects/:slug/knowledge/pages/:id/history', async c => {
    const { pageId } = await pageFor(c, 'project.read');
    return c.json({ revisions: await knowledge.historyView(pageId) });
  });
  // One revision as it was, and how it differs from what the page shows now.
  app.get('/api/projects/:slug/knowledge/pages/:id/revisions/:rev', async c => {
    const { pageId } = await pageFor(c, 'project.read');
    return c.json({ revision: await knowledge.revision(pageId, revOf(c)), diff: await knowledge.diff(pageId, revOf(c)) });
  });
  app.post('/api/projects/:slug/knowledge/pages/:id/restore', async c => {
    const { pageId } = await pageFor(c, 'project.contribute');
    return c.json(await knowledge.restore(author(c), pageId, (await parseBody(c, z.object({ rev: z.number().int().min(1) }))).rev));
  });
  // A version that came in beside the current one: keep ours or take theirs.
  app.post('/api/projects/:slug/knowledge/pages/:id/conflict', async c => {
    const { pageId } = await pageFor(c, 'project.contribute');
    const input = await parseBody(c, z.object({ rev: z.number().int().min(1), choice: z.enum(['mine', 'theirs']) }));
    return c.json(await knowledge.resolveSibling(author(c), pageId, input.rev, input.choice));
  });

  app.post('/api/projects/:slug/memories/:id', async c => {
    const found = await projectFor(c, 'project.contribute'), memoryId = c.req.param('id')!;
    const level = within(found.scopes, await knowledge.memoryScope(memoryId));
    if (!level) throw new HttpError(404, 'not_found', 'Memory not found');
    if (!mayWrite(c.get('viewer'), level.key, found.rootId)) throw forbidden();
    const input = await parseBody(c, MemoryActionBody);
    if (input.action === 'promote') return c.json(await knowledge.promote(author(c), memoryId, input.path ?? ''));
    if (input.action === 'restore') { await knowledge.restoreMemory(author(c), memoryId); return c.json({ ok: true }); }
    await knowledge.setMemoryStatus(author(c), memoryId, input.action === 'confirm' ? 'confirmed' : 'retired');
    return c.json({ ok: true });
  });

  // Search over every level the project belongs to. Each hit says where it leads, so the page never has to guess from an id.
  app.get('/api/projects/:slug/search', async c => {
    const { scopes } = await projectFor(c, 'project.read');
    const limit = Math.min(30, Math.max(1, Number(c.req.query('limit')) || 10));
    const found = await knowledge.search(scopes.map(item => item.scope), c.req.query('q') ?? '', limit);
    const hits = [];
    for (const hit of found) {
      if (hit.type === 'page') hits.push({ ...hit, target: { kind: 'page', pageId: hit.id } });
      else if (hit.type === 'memory') {
        const memory = await db.selectFrom('memories').select(['status', 'promoted_page_id', 'scope_type', 'scope_id']).where('id', '=', hit.id).executeTakeFirst();
        if (memory?.promoted_page_id) hits.push({ ...hit, target: { kind: 'page', pageId: memory.promoted_page_id } });
        else if (memory && memory.status !== 'retired') hits.push({ ...hit, target: { kind: 'memory', memoryId: hit.id, scope: within(scopes, { type: memory.scope_type as Scope['type'], id: memory.scope_id })?.key ?? null } });
      } else {
        // A message or an issue leads to its thread: an issue's page when the thread belongs to one, the team discussion otherwise.
        const issue = hit.ref ? await db.selectFrom('issues').innerJoin('projects', 'projects.id', 'issues.project_id').select(['issues.number', 'projects.slug']).where('issues.thread_id', '=', hit.ref).executeTakeFirst() : undefined;
        const thread = !issue && hit.ref ? await db.selectFrom('threads').innerJoin('projects', 'projects.id', 'threads.project_id').select('projects.slug').where('threads.id', '=', hit.ref).executeTakeFirst() : undefined;
        hits.push({ ...hit, target: issue ? { kind: 'issue', slug: issue.slug, number: issue.number } : { kind: 'discussion', slug: thread?.slug ?? c.req.param('slug') } });
      }
    }
    return c.json({ hits });
  });

  // Decisions a page may point at. A page holds a reference, never a copy, so the card always shows the decision as it stands.
  const decisionView = (row: { id: string; kind: string; outcome: string; summary: string; needs_human: boolean | number; resolved_at: number | string | null; created_at: number | string; thread_id: string }, issueNumber: number | null) =>
    ({ id: row.id, kind: row.kind, outcome: row.outcome, summary: row.summary, waitingForPerson: Boolean(row.needs_human) && row.resolved_at === null, at: Number(row.created_at), issueNumber });
  async function familyOf(rootId: string) { return [rootId, ...(await db.selectFrom('projects').select('id').where('parent_id', '=', rootId).execute()).map(row => row.id)]; }
  app.get('/api/projects/:slug/decisions', async c => {
    const { rootId } = await projectFor(c, 'project.read');
    const rows = await db.selectFrom('decisions').selectAll().where('project_id', 'in', await familyOf(rootId)).orderBy('created_at', 'desc').limit(30).execute();
    return c.json({ decisions: rows.map(row => decisionView(row, null)) });
  });
  app.get('/api/projects/:slug/decisions/:id', async c => {
    const { rootId } = await projectFor(c, 'project.read');
    const row = await db.selectFrom('decisions').selectAll().where('id', '=', c.req.param('id')!).where('project_id', 'in', await familyOf(rootId)).executeTakeFirst();
    if (!row) throw new HttpError(404, 'not_found', 'Decision not found');
    const issue = await db.selectFrom('issues').select('number').where('thread_id', '=', row.thread_id).executeTakeFirst();
    const home = await db.selectFrom('projects').select('slug').where('id', '=', row.project_id).executeTakeFirstOrThrow();
    return c.json({ decision: { ...decisionView(row, issue?.number ?? null), projectSlug: home.slug } });
  });
}
