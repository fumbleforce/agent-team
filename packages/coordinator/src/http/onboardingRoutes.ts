import type { Hono } from 'hono';
import type { Context } from '../context.ts';

export interface OnboardingStep { key: 'project' | 'code' | 'board' | 'provider' | 'worker' | 'task' | 'people'; done: boolean; optional: boolean; detail: string | null }
const FRESH_MS = 3 * 60_000;

// Where a new organization stands on the way to a working team. Everything is derived from what exists, so a step done
// any other way (the command line, a teammate) shows as done here too.
export function mountOnboardingRoutes(app: Hono<any>, deps: { context: Context; canAdmin(c: unknown): boolean; userId(c: unknown): string }) {
  const { context } = deps, db = context.storage.db;

  app.get('/api/onboarding', async c => {
    const wanted = c.req.query('project');
    const projects = await db.selectFrom('projects').select(['id', 'slug', 'name', 'manifest', 'parent_id', 'created_at']).where('status', '!=', 'archived').orderBy('created_at').execute();
    const project = projects.find(row => row.slug === wanted) ?? projects.find(row => row.parent_id === null) ?? null;
    const manifest = project ? JSON.parse(project.manifest) as { scm?: { kind?: string }; delivery?: { repository?: string }; tracker?: { kind?: string } } : {};
    const providers = await db.selectFrom('providers').select(['name']).execute();
    const workers = (await db.selectFrom('workers').select(['name', 'projects', 'providers', 'last_seen_at']).where('last_seen_at', '>', context.now() - FRESH_MS).execute())
      .filter(worker => project && (JSON.parse(worker.projects) as string[]).includes(project.id));
    const engines = [...new Set(workers.flatMap(worker => ((JSON.parse(worker.providers) as { engines?: string[] }).engines ?? [])))];
    const tasks = project ? await db.selectFrom('tasks').select(eb => eb.fn.countAll<number>().as('n')).where('project_id', 'in', [project.id, ...projects.filter(row => row.parent_id === project.id).map(row => row.id)]).executeTakeFirstOrThrow() : { n: 0 };
    const people = await db.selectFrom('users').select(eb => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
    const invites = await db.selectFrom('invites').select(eb => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
    const org = await db.selectFrom('org').select('settings').executeTakeFirst();
    const steps: OnboardingStep[] = [
      { key: 'project', optional: false, done: Boolean(project), detail: project?.name ?? null },
      { key: 'code', optional: false, done: Boolean(manifest.scm?.kind && manifest.delivery?.repository), detail: manifest.delivery?.repository ?? null },
      { key: 'board', optional: true, done: Boolean(manifest.tracker?.kind), detail: null },
      { key: 'provider', optional: false, done: providers.length > 0, detail: providers.map(row => row.name).join(', ') || null },
      { key: 'worker', optional: false, done: workers.length > 0, detail: workers.length ? `${workers.map(worker => worker.name).join(', ')}${engines.length ? ` can run ${engines.join(', ')}` : ''}` : null },
      { key: 'task', optional: false, done: Number(tasks.n) > 0, detail: null },
      { key: 'people', optional: true, done: Number(people.n) + Number(invites.n) > 1, detail: null },
    ];
    const required = steps.filter(step => !step.optional);
    return c.json({ project: project ? { slug: project.slug, name: project.name } : null, steps, done: required.filter(step => step.done).length, total: required.length, complete: required.every(step => step.done),
      dismissed: Boolean((org ? JSON.parse(org.settings) as { onboardingDismissed?: boolean } : {}).onboardingDismissed), canAdmin: deps.canAdmin(c), url: new URL(c.req.url).origin });
  });

  app.post('/api/onboarding/dismiss', async c => {
    if (!deps.canAdmin(c)) return c.json({ error: { code: 'forbidden', message: 'Only an owner or admin can hide the guide' } }, 403);
    const org = await db.selectFrom('org').select(['id', 'settings']).executeTakeFirstOrThrow();
    await db.updateTable('org').set({ settings: JSON.stringify({ ...(JSON.parse(org.settings) as Record<string, unknown>), onboardingDismissed: true }) }).where('id', '=', org.id).execute();
    return c.json({ ok: true });
  });
}
