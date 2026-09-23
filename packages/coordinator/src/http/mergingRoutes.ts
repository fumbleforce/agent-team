import type { Hono } from 'hono';
import { z } from 'zod';
import { HttpError, type Context } from '../context.ts';
import { authorizationOf, SETTINGS_FILE, type ScmApi } from '../sync/scm.ts';

type Project = { id: string; slug: string };
interface Deps { context: Context; projectFor(c: unknown, action: 'project.read' | 'project.configure'): Promise<{ project: Project }>; body<T>(c: unknown, schema: z.ZodType<T>): Promise<T>; userId(c: unknown): string }
const MergingBody = z.object({ autoMerge: z.boolean(), requiredChecks: z.array(z.string().trim().min(1).max(120)).max(20).default([]) });

// Whether the team may merge what it approved, and which checks a merge waits for. Both are authorizations, so they live in the
// project's committed settings file: the app proposes the change on the code host and it counts once a person has merged it there.
export function mountMergingRoutes(app: Hono<any>, deps: Deps) {
  const { context } = deps, db = context.storage.db;
  const where = async (projectId: string) => {
    const row = await db.selectFrom('projects').select(['name', 'manifest']).where('id', '=', projectId).executeTakeFirstOrThrow();
    const manifest = JSON.parse(row.manifest) as { scm?: { kind?: string; repository?: string }; delivery?: { repository?: string; baseBranch?: string } };
    const repository = manifest.scm?.repository ?? manifest.delivery?.repository ?? null, base = manifest.delivery?.baseBranch ?? 'main';
    const api: ScmApi | null = manifest.scm?.kind && repository && context.scm ? await context.scm(manifest.scm.kind).catch(() => null) : null;
    return { name: row.name, manifest, repository, base, api };
  };

  app.get('/api/projects/:slug/merging', async c => {
    const { project } = await deps.projectFor(c, 'project.read');
    const { manifest, repository, base, api } = await where(project.id);
    // The checks to choose from: what the code host reports on the base branch, and the suites this project has seen there.
    const reported = api?.checkNames && repository ? await api.checkNames(repository, base).catch(() => []) : [];
    const seen = (await db.selectFrom('check_runs').select('suite').distinct().where('project_id', '=', project.id).where('branch', '=', base).execute()).map(row => row.suite);
    const proposal = await db.selectFrom('events').select(['payload', 'at']).where('project_id', '=', project.id).where('type', '=', 'settings.proposed').orderBy('seq', 'desc').limit(1).executeTakeFirst();
    return c.json({
      ...authorizationOf(manifest), repository, base, checks: [...new Set([...reported, ...seen, ...authorizationOf(manifest).requiredChecks])].sort(),
      canPropose: Boolean(api?.proposeFile && api.readFile), proposal: proposal ? { ...(JSON.parse(proposal.payload) as { url: string; autoMerge: boolean; requiredChecks: string[] }), at: Number(proposal.at) } : null,
    });
  });

  app.post('/api/projects/:slug/merging', async c => {
    const { project } = await deps.projectFor(c, 'project.configure');
    const input = await deps.body(c, MergingBody);
    if (input.autoMerge && input.requiredChecks.length === 0) throw new HttpError(400, 'invalid', 'Choose the checks a merge waits for', { requiredChecks: 'Choose at least one check: the team merges only when they pass' });
    const { name, manifest, repository, base, api } = await where(project.id);
    if (!repository || !api?.proposeFile || !api.readFile) throw new HttpError(409, 'no_code_host', 'Connect the code host with a token that may write, so the change can be proposed there');
    // The committed file is changed where it stands; a project with none gets one that names its code host.
    const text = await api.readFile(repository, SETTINGS_FILE, base);
    const committed = (text === null ? { name, scm: { kind: manifest.scm?.kind, repository }, delivery: { repository, baseBranch: base } } : JSON.parse(text)) as { delivery?: Record<string, unknown> };
    // Merging needs a change on the code host to merge, so turning it on authorizes publishing too; turning it off leaves publishing as it was.
    committed.delivery = { ...committed.delivery, autoMergeAuthorized: input.autoMerge, requiredChecks: input.requiredChecks, ...(input.autoMerge ? { publishAuthorized: true } : {}) };
    const title = input.autoMerge ? 'Let the team merge approved changes' : 'Stop the team merging';
    const body = input.autoMerge
      ? `Asked for in the app. Once this is merged, the team merges a change it has approved when ${input.requiredChecks.join(', ')} ${input.requiredChecks.length === 1 ? 'passes' : 'pass'} on it. Until then nothing changes.`
      : 'Asked for in the app. Once this is merged, approved changes wait for a person to merge them.';
    const url = await api.proposeFile(repository, { base, branch: `agent-team/settings-${context.now()}`, path: SETTINGS_FILE, content: `${JSON.stringify(committed, null, 2)}\n`, title, body })
      .catch(error => { throw new HttpError(502, 'code_host', `The code host did not take the change: ${(error as Error).message}`); });
    const published = await context.storage.transaction(tx => context.events.append(tx, [{ type: 'settings.proposed', category: 'audit', actorKind: 'user', userId: deps.userId(c), projectId: project.id, payload: { url, autoMerge: input.autoMerge, requiredChecks: input.requiredChecks } }]));
    context.events.published(published);
    return c.json({ url });
  });
}
