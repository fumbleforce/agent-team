import { newId } from '@agent-team/protocol';
import type { Context } from '../context.ts';
import { createChecks } from '../checks/checks.ts';
import type { JUnitReport } from '../checks/junit.ts';
import { createCursors } from './cursors.ts';

// What the coordinator reads from the host of a project's code, in one shape for every host.
export interface ScmReviewState { state: 'approved' | 'changes_requested' | 'pending'; approvals: number; reviewers: { name: string; state: 'approved' | 'changes_requested' | 'commented' }[] }
export interface ScmTestReport { suite: string; branch: string; sha: string | null; report: JUnitReport }
export interface ScmEnvironment { name: string; url: string; branch: string | null }
export type ScmRef = { branch: string } | { change: string };
export interface ScmApi {
  reviewState(repository: string, change: string): Promise<ScmReviewState>;
  // The parsed test reports of the latest finished pipeline or run of a branch, or of a change's head.
  testReports(repository: string, ref: ScmRef): Promise<ScmTestReport[]>;
  environments(repository: string): Promise<ScmEnvironment[]>;
}

const RESOURCE = 'scm', MAX_BRANCHES = 20;

export function createScmSync(context: Context) {
  const { storage, events, now } = context;
  const db = storage.db;
  const cursors = createCursors(context), checks = createChecks(context);

  async function run(projectId: string, api: ScmApi) {
    const project = await db.selectFrom('projects').select('manifest').where('id', '=', projectId).executeTakeFirstOrThrow();
    const manifest = JSON.parse(project.manifest) as { scm?: { repository?: string }; delivery?: { baseBranch?: string } };
    const repository = manifest.scm?.repository;
    if (!repository) return { environments: 0, runs: 0 };

    // Preview and deployed environments become the product view's choices. One a person added by hand is never touched.
    const remote = await api.environments(repository);
    const environments = await storage.transaction(async tx => {
      const known = new Map((await tx.selectFrom('product_envs').select(['id', 'name', 'url', 'branch', 'source']).where('project_id', '=', projectId).execute()).map(row => [row.name, row]));
      let changed = 0;
      for (const item of remote) {
        const row = known.get(item.name);
        if (!/^https?:\/\//.test(item.url) || row?.source === 'manual' || (row && row.url === item.url && row.branch === item.branch)) continue;
        if (row) await tx.updateTable('product_envs').set({ url: item.url, branch: item.branch }).where('id', '=', row.id).execute();
        else await tx.insertInto('product_envs').values({ id: newId(now()), project_id: projectId, name: item.name.slice(0, 80), branch: item.branch, url: item.url, source: 'scm', created_at: now() }).execute();
        changed++;
      }
      const published = changed ? await events.append(tx, [{ type: 'product.environments_synced', actorKind: 'system', projectId, payload: { changed } }]) : [];
      return { changed, published };
    });
    events.published(environments.published);

    // The base branch and every branch a task is being worked on. A run already recorded for the same commit is not recorded again.
    const tasks = await db.selectFrom('tasks').select('branch').where('project_id', '=', projectId).where('branch', 'is not', null).where('state', 'not in', ['done', 'canceled']).orderBy('updated_at', 'desc').limit(MAX_BRANCHES).execute();
    const branches = [...new Set([manifest.delivery?.baseBranch ?? 'main', ...tasks.map(task => task.branch!)])];
    let runs = 0, failure: unknown = null;
    for (const branch of branches) {
      // One branch without a pipeline must not hide the reports of the others.
      const reports = await api.testReports(repository, { branch }).catch(error => { failure = error; return []; });
      for (const item of reports) {
        const seen = await db.selectFrom('check_runs').select('id').where('project_id', '=', projectId).where('suite', '=', item.suite).where('branch', '=', item.branch).where('source', '=', 'scm').where('sha', item.sha === null ? 'is' : '=', item.sha).executeTakeFirst();
        if (seen) continue;
        await checks.record({ projectId, suite: item.suite.slice(0, 60), branch: item.branch, sha: item.sha, source: 'scm', report: item.report });
        runs++;
      }
    }
    if (failure) throw failure;
    return { environments: environments.changed, runs };
  }

  return {
    async syncProject(projectId: string, api: ScmApi) {
      try {
        const result = await run(projectId, api);
        await cursors.ok(projectId, RESOURCE);
        return result;
      } catch (error) {
        await cursors.fail(projectId, RESOURCE, error).catch(() => undefined);
        throw error;
      }
    },
  };
}
