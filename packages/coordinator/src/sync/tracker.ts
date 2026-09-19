import { newId, type TaskState } from '@agent-team/protocol';
import type { Context } from '../context.ts';

// The neutral issue shape every tracker adapter returns.
export interface TrackerIssue { identifier: string; title: string; description?: string | null; url?: string | null; updatedAt?: string | null; state: { name: string; type: string }; labels: { name: string }[] }
export interface TrackerClient { snapshot(manifest: Record<string, unknown>): Promise<{ allIssues: TrackerIssue[] }> }

const IN_REVIEW = /in.?review/i, IN_PROGRESS = /in.?progress/i;

// The tracker is the board of record for state, title and labels. Columns come from the normalized state type,
// refined by the progress labels that label-based trackers use.
export function taskStateOf(issue: TrackerIssue): TaskState {
  const labels = issue.labels.map(label => label.name);
  if (issue.state.type === 'completed') return 'done';
  if (issue.state.type === 'canceled') return 'canceled';
  if (IN_REVIEW.test(issue.state.name) || labels.some(label => IN_REVIEW.test(label))) return 'in_review';
  if (issue.state.type === 'started' || IN_PROGRESS.test(issue.state.name) || labels.some(label => IN_PROGRESS.test(label))) return 'in_progress';
  return 'backlog';
}
const tagOf = (issue: TrackerIssue) => issue.labels.map(label => label.name).find(name => !/^(agent|owner|idea)[:/]/i.test(name)) ?? null;
// States the platform owns while it works; a poll must not pull a task out of them.
const LOCAL: readonly string[] = ['awaiting_decision', 'blocked', 'quarantined', 'approved', 'merging', 'stopped'];

export function createTrackerSync(context: Context) {
  const { storage, events, now } = context;

  return {
    // One poll of one project. Remote wins for title, tag and state; assignee, branch and thread are local and never overwritten.
    async syncProject(projectId: string, client: TrackerClient) {
      const project = await storage.db.selectFrom('projects').select('manifest').where('id', '=', projectId).executeTakeFirstOrThrow();
      // The tracker's own settings sit under `tracker` in the manifest.
      const manifest = JSON.parse(project.manifest) as { tracker?: Record<string, unknown> };
      const { allIssues } = await client.snapshot(manifest.tracker ?? {});
      const result = await storage.transaction(async tx => {
        const existing = new Map((await tx.selectFrom('tasks').select(['id', 'key', 'title', 'state', 'tag']).where('project_id', '=', projectId).where('source', '=', 'tracker').execute()).map(task => [task.key, task]));
        const drafts = [];
        let created = 0, updated = 0;
        for (const [index, issue] of allIssues.entries()) {
          const state = taskStateOf(issue), tag = tagOf(issue), task = existing.get(issue.identifier);
          if (!task) {
            if (state === 'canceled') continue;
            const id = newId(now());
            await tx.insertInto('tasks').values({ id, project_id: projectId, key: issue.identifier, source: 'tracker', title: issue.title, brief: issue.description ?? '', tag, priority: index, milestone_id: null, state, assignee_agent_id: null, author_agent_id: null, branch: null, head_sha: null, pr_url: null, blocked_reason: null, created_at: now(), updated_at: now() }).execute();
            drafts.push({ type: 'task.synced', actorKind: 'system' as const, projectId, taskId: id, payload: { key: issue.identifier, state } });
            created++;
            continue;
          }
          const nextState = LOCAL.includes(task.state) && state !== 'done' && state !== 'canceled' ? task.state : state;
          if (task.title === issue.title && task.tag === tag && task.state === nextState) continue;
          await tx.updateTable('tasks').set({ title: issue.title, brief: issue.description ?? '', tag, state: nextState, updated_at: now() }).where('id', '=', task.id).execute();
          if (task.state !== nextState) drafts.push({ type: 'task.state_changed', actorKind: 'system' as const, projectId, taskId: task.id, payload: { from: task.state, to: nextState, source: 'tracker' } });
          updated++;
        }
        return { created, updated, published: drafts.length ? await events.append(tx, drafts) : [] };
      });
      events.published(result.published);
      return { created: result.created, updated: result.updated };
    },
  };
}
