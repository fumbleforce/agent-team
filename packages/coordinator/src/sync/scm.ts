import { newId, type EventDraft } from '@agent-team/protocol';
import type { Context } from '../context.ts';
import { sendBackToMerge } from '../runtime/conflicts.ts';
import { moveTask } from '../runtime/taskMoves.ts';
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
export interface ScmChangeState { open: boolean; merged: boolean; headSha: string | null; conflicting: boolean | null }
export interface ScmApi {
  reviewState(repository: string, change: string): Promise<ScmReviewState>;
  changeState(repository: string, change: string): Promise<ScmChangeState>;
  // The parsed test reports of the latest finished pipeline or run of a branch, or of a change's head.
  testReports(repository: string, ref: ScmRef): Promise<ScmTestReport[]>;
  environments(repository: string): Promise<ScmEnvironment[]>;
  // The project's own settings file as committed on a branch (null when there is none), a change to it proposed for a person to merge
  // (the address of the change request), and the names of the checks reported on a branch's head. A host without them is read-only here.
  readFile?(repository: string, path: string, ref: string): Promise<string | null>;
  proposeFile?(repository: string, input: { base: string; branch: string; path: string; content: string; title: string; body: string }): Promise<string>;
  checkNames?(repository: string, ref: string): Promise<string[]>;
}

const RESOURCE = 'scm', MAX_BRANCHES = 20;
export const SETTINGS_FILE = '.agent-team.json';
// The settings of a manifest that authorize something: merging, the checks a merge waits for, and publishing.
export function authorizationOf(manifest: unknown): { autoMergeAuthorized: boolean; requiredChecks: string[]; publishAuthorized: boolean } {
  const value = (manifest ?? {}) as { delivery?: { autoMergeAuthorized?: unknown; requiredChecks?: unknown; publishAuthorized?: unknown }; ceiling?: { publishAuthorized?: unknown } };
  const checks = Array.isArray(value.delivery?.requiredChecks) ? value.delivery.requiredChecks.filter((name): name is string => typeof name === 'string' && name.trim() !== '') : [];
  return { autoMergeAuthorized: value.delivery?.autoMergeAuthorized === true, requiredChecks: checks, publishAuthorized: value.delivery?.publishAuthorized === true || value.ceiling?.publishAuthorized === true };
}
const OPEN_WITH_CHANGE = ['in_progress', 'awaiting_decision', 'in_review', 'approved', 'blocked'] as const;

export function createScmSync(context: Context, turns: Pick<Turns, 'enqueue'> | null = null) {
  const { storage, events, now } = context;
  const db = storage.db;
  const cursors = createCursors(context), checks = createChecks(context);

  // What the project's committed settings file says about merging and publishing is what counts, as `AGENTS.md` requires; the copy
  // registered from a checkout or written by the app follows it. A host that cannot read files, or a file that is not there, changes nothing.
  async function adoptCommitted(projectId: string, api: ScmApi, repository: string, base: string) {
    const text = api.readFile ? await api.readFile(repository, SETTINGS_FILE, base) : null;
    if (text === null) return;
    const committed = authorizationOf(JSON.parse(text) as unknown);
    const published = await storage.transaction(async tx => {
      const row = await tx.selectFrom('projects').select('manifest').where('id', '=', projectId).executeTakeFirstOrThrow();
      const stored = JSON.parse(row.manifest) as { delivery?: Record<string, unknown> };
      const before = authorizationOf(stored);
      if (JSON.stringify(before) === JSON.stringify(committed)) return [];
      stored.delivery = { ...stored.delivery, ...committed };
      await tx.updateTable('projects').set({ manifest: JSON.stringify(stored) }).where('id', '=', projectId).execute();
      return events.append(tx, [{ type: 'settings.changed', category: 'audit', actorKind: 'system', projectId, payload: { what: 'delivery.committed', before, after: committed } }]);
    });
    events.published(published);
  }

  async function run(projectId: string, api: ScmApi) {
    const project = await db.selectFrom('projects').select('manifest').where('id', '=', projectId).executeTakeFirstOrThrow();
    const manifest = JSON.parse(project.manifest) as { scm?: { repository?: string }; delivery?: { repository?: string; baseBranch?: string } };
    // A project connected in the app, or registered by `up` from its checkout, names the repository where delivery reads it.
    const repository = manifest.scm?.repository ?? manifest.delivery?.repository;
    if (!repository) return { environments: 0, runs: 0, sentBack: 0, closed: 0 };

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
    await adoptCommitted(projectId, api, repository, manifest.delivery?.baseBranch ?? 'main').catch(error => { failure = error; });
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
    // A change merged on the code host by someone else (a person pressing merge, say) closes its task: the work is in. Not while the
    // gate is merging it, which closes the task itself.
    let sentBack = 0, closed = 0;
    for (const task of await db.selectFrom('tasks').select(['id', 'pr_url', 'head_sha', 'state']).where('project_id', '=', projectId).where('pr_url', 'is not', null).where('state', 'in', OPEN_WITH_CHANGE).orderBy('updated_at', 'desc').limit(MAX_BRANCHES).execute()) {
      const found = await api.changeState(repository, task.pr_url!).catch(error => { failure = error; return null; });
      if (found?.merged) {
        const published = await storage.transaction(async tx => {
          const moved = await moveTask(tx, task.id, 'done', { from: [...OPEN_WITH_CHANGE], set: { blocked_reason: null }, now: now(), actor: { actorKind: 'system' }, payload: { reason: 'merged-on-host' } });
          if (!moved.length) return [];
          await tx.updateTable('merge_queue').set({ state: 'merged', reason: 'Merged on the code host', finished_at: now() }).where('task_id', '=', task.id).where('state', 'in', ['queued', 'blocked']).execute();
          await tx.updateTable('work_items').set({ state: 'canceled' }).where('task_id', '=', task.id).where('state', '=', 'queued').execute();
          return events.append(tx, moved);
        });
        events.published(published);
        if (published.length) closed++;
        continue;
      }
      if (!turns || task.state !== 'in_review' || !found?.open || found.conflicting !== true || !task.head_sha || found.headSha !== task.head_sha) continue;
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
    return { environments: environments.changed, runs, sentBack, closed };
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
