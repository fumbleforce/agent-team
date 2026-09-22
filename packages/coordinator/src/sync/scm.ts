import { newId, type EventDraft } from '@agent-team/protocol';
import type { Context } from '../context.ts';
import { sendBackToMerge } from '../runtime/conflicts.ts';
import type { Turns } from '../runtime/turns.ts';
import { createChecks } from '../checks/checks.ts';
import type { JUnitReport } from '../checks/junit.ts';
import { createCursors } from './cursors.ts';

// What the coordinator reads from the host of a project's code, in one shape for every host.
export interface ScmReviewState { state: 'approved' | 'changes_requested' | 'pending'; approvals: number; reviewers: { name: string; state: 'approved' | 'changes_requested' | 'commented' }[] }
export interface ScmTestReport { suite: string; branch: string; sha: string | null; report: JUnitReport }
export interface ScmEnvironment { name: string; url: string; branch: string | null }
export type ScmRef = { branch: string } | { change: string };
// Where a change stands: still open, at which head, and whether the host says it collides with the base (null while the host is
// still working that out, which is not an answer).
export interface ScmChangeState { open: boolean; headSha: string | null; conflicting: boolean | null }
export interface ScmApi {
  reviewState(repository: string, change: string): Promise<ScmReviewState>;
  changeState(repository: string, change: string): Promise<ScmChangeState>;
  // The parsed test reports of the latest finished pipeline or run of a branch, or of a change's head.
  testReports(repository: string, ref: ScmRef): Promise<ScmTestReport[]>;
  environments(repository: string): Promise<ScmEnvironment[]>;
}

const RESOURCE = 'scm', MAX_BRANCHES = 20;

export function createScmSync(context: Context, turns: Pick<Turns, 'enqueue'> | null = null) {
  const { storage, events, now } = context;
  const db = storage.db;
  const cursors = createCursors(context), checks = createChecks(context);

  async function run(projectId: string, api: ScmApi) {
    const project = await db.selectFrom('projects').select('manifest').where('id', '=', projectId).executeTakeFirstOrThrow();
    const manifest = JSON.parse(project.manifest) as { scm?: { repository?: string }; delivery?: { baseBranch?: string } };
    const repository = manifest.scm?.repository;
    if (!repository) return { environments: 0, runs: 0, sentBack: 0 };

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

    // A change in review that no longer merges into the base goes back to its author at once, to merge the base in, instead of
    // being reviewed at a revision that cannot merge and found out only by the merge gate. The host's answer counts only for the
    // revision the team is on. Once per revision, as at the gate: when the author could not put it right, the gate asks a person.
    let sentBack = 0;
    if (turns) for (const task of await db.selectFrom('tasks').select(['id', 'pr_url', 'head_sha']).where('project_id', '=', projectId).where('pr_url', 'is not', null).where('state', '=', 'in_review').orderBy('updated_at', 'desc').limit(MAX_BRANCHES).execute()) {
      const found = await api.changeState(repository, task.pr_url!).catch(error => { failure = error; return null; });
      if (!found?.open || found.conflicting !== true || !task.head_sha || found.headSha !== task.head_sha) continue;
      const sent = await storage.transaction(async tx => {
        const drafts: EventDraft[] = [];
        const who = await sendBackToMerge(tx, task.id, { now: now(), approved: false, from: ['in_review'], actor: { actorKind: 'system' }, drafts });
        // Reviews still waiting to start would look at a revision that is about to be replaced.
        if (who) await tx.updateTable('work_items').set({ state: 'canceled' }).where('task_id', '=', task.id).where('kind', '=', 'review').where('state', '=', 'queued').execute();
        return { who, published: drafts.length ? await events.append(tx, drafts) : [] };
      });
      events.published(sent.published);
      if (sent.who) { await turns.enqueue({ ...sent.who, kind: 'work', dedupeKey: `work:${sent.who.taskId}` }); sentBack++; }
    }
    if (failure) throw failure;
    return { environments: environments.changed, runs, sentBack };
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
