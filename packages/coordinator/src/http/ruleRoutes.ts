import type { Context as Hc, Hono } from 'hono';
import { BudgetBody, CostCurrency, RebalanceApplyBody, RuleKind } from '@agent-team/protocol';
import { can, type Action, type Viewer } from '../auth/rbac.ts';
import type { Costs } from '../costs/costs.ts';
import { forbidden, HttpError, type Context } from '../context.ts';
import { DOC_KINDS, type VersionedDocs } from '../repos/versionedDocs.ts';
import type { createWorkspace } from '../repos/workspace.ts';
import { createRebalance } from '../runtime/rebalance.ts';
import { RULES_SCOPE, RULES_SLUG } from '../runtime/turns.ts';
import { ifMatch, parseBody, preconditioned } from './conventions.ts';

type Env = { Variables: { viewer: Viewer } };

// Rules as data, budgets, the cost export and workload rebalancing. Mounted behind the session middleware.
export function registerRuleRoutes(app: Hono<Env>, context: Context, deps: { workspace: ReturnType<typeof createWorkspace>; docs: VersionedDocs; costs: Costs }) {
  const { workspace, docs, costs } = deps;
  const db = context.storage.db, rebalance = createRebalance(context);
  const allow = (c: Hc<Env>, action: Action, projectId?: string) => { if (!can(c.get('viewer'), action, projectId)) throw forbidden(); };
  const visible = async (c: Hc<Env>) => (await workspace.projectTree(c.get('viewer'))).flatMap(project => [project.id, ...project.subprojects.map(sub => sub.id)]);
  const kindOf = (c: Hc<Env>) => { const kind = RuleKind.safeParse(c.req.param('kind')); if (!kind.success) throw new HttpError(404, 'not_found', 'No such rules'); return kind.data; };
  const teamFor = async (c: Hc<Env>) => {
    const project = await workspace.project(c.req.param('slug')!);
    allow(c, 'project.operate', project.parent_id ?? project.id);
    const root = project.parent_id ? await db.selectFrom('projects').select(['id', 'team_id']).where('id', '=', project.parent_id).executeTakeFirstOrThrow() : project;
    if (!root.team_id) throw new HttpError(409, 'no_team', 'The project has no team');
    return root.team_id;
  };

  // A rules document that was never saved reads as its defaults at version 0; `If-Match: 0` then creates it.
  app.get('/api/rules/:kind', async c => {
    const kind = kindOf(c);
    const row = await db.selectFrom('versioned_docs').select(['version', 'doc', 'author', 'updated_at']).where('kind', '=', kind).where('scope_type', '=', RULES_SCOPE.type).where('scope_id', '=', RULES_SCOPE.id).where('slug', '=', RULES_SLUG).executeTakeFirst();
    const version = row?.version ?? 0;
    c.header('etag', `"${version}"`);
    return c.json({ kind, version, author: row?.author ?? null, updatedAt: row ? Number(row.updated_at) : null, doc: DOC_KINDS[kind].parse(row ? JSON.parse(row.doc) : {}) });
  });
  // PUT is the verb; POST is accepted because the web client only posts.
  app.on(['PUT', 'POST'], '/api/rules/:kind', async c => {
    allow(c, 'org.members');
    const kind = kindOf(c), expected = ifMatch(c), doc = await parseBody(c, DOC_KINDS[kind]);
    const user = await db.selectFrom('users').select('name').where('id', '=', c.get('viewer').userId).executeTakeFirstOrThrow();
    const version = await preconditioned(expected, () => docs.save(kind, RULES_SCOPE, RULES_SLUG, doc, { author: user.name, ...(expected !== undefined ? { expectedVersion: expected } : {}) }));
    c.header('etag', `"${version}"`);
    return c.json({ kind, version, doc });
  });

  // Budgets: the organization's by an admin, a project's by whoever configures it.
  const budgetGate = async (c: Hc<Env>, scope: string, scopeId: string) => {
    if (scope === 'org') return allow(c, 'org.members');
    const project = await db.selectFrom('projects').select(['id', 'parent_id']).where('id', '=', scopeId).executeTakeFirst();
    if (!project) throw new HttpError(404, 'not_found', 'Project not found');
    allow(c, 'project.configure', project.parent_id ?? project.id);
  };
  app.get('/api/budgets', async c => c.json({ budgets: await costs.budgets(await visible(c)) }));
  app.on(['PUT', 'POST'], '/api/budgets', async c => {
    const input = await parseBody(c, BudgetBody);
    await budgetGate(c, input.scope, input.scope === 'org' ? '' : input.scopeId);
    // No amount means no budget.
    const scopeId = input.scope === 'org' ? '' : input.scopeId;
    if (input.amountMinor === null) await costs.deleteBudget(input.scope, scopeId, input.period);
    else await costs.setBudget({ scope: input.scope, scopeId, period: input.period, amountMinor: input.amountMinor });
    return c.json({ ok: true });
  });
  app.delete('/api/budgets/:scope/:scopeId?', async c => {
    const scope = c.req.param('scope'), scopeId = scope === 'org' ? '' : c.req.param('scopeId') ?? '';
    await budgetGate(c, scope, scopeId);
    await costs.deleteBudget(scope, scopeId);
    return c.json({ ok: true });
  });

  // The currency costs are shown in and its rate against the US dollar, which is what engines report in.
  app.get('/api/costs/currency', async c => c.json({ ...await costs.display(), canEdit: can(c.get('viewer'), 'org.members') }));
  app.on(['PUT', 'POST'], '/api/costs/currency', async c => {
    allow(c, 'org.members');
    const input = await parseBody(c, CostCurrency);
    await costs.setDisplay(c.get('viewer').userId, input);
    return c.json(input);
  });

  // Entries of a period (whole days, UTC) for the projects the viewer can see.
  app.get('/api/costs/export.csv', async c => {
    const today = new Date(context.now()).toISOString().slice(0, 10), from = c.req.query('from') ?? `${today.slice(0, 8)}01`, to = c.req.query('to') ?? today;
    const start = Date.parse(`${from}T00:00:00Z`), end = Date.parse(`${to}T00:00:00Z`) + 24 * 3600_000;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || Number.isNaN(start) || Number.isNaN(end) || end <= start) throw new HttpError(400, 'invalid', 'from and to are days, YYYY-MM-DD, from first');
    return c.body(await costs.exportCsv(await visible(c), start, end), 200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="costs-${from}-to-${to}.csv"`, 'cache-control': 'no-store' });
  });

  // Suggest reads, apply writes; apply takes the moves it was shown and skips any that are no longer true.
  app.get('/api/projects/:slug/workload/rebalance', async c => c.json({ moves: await rebalance.suggest(await teamFor(c)) }));
  app.post('/api/projects/:slug/workload/rebalance', async c => {
    const teamId = await teamFor(c), input = await parseBody(c, RebalanceApplyBody);
    return c.json(await rebalance.apply(teamId, input.moves));
  });
}
