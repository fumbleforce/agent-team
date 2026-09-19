import { newId } from '@agent-team/protocol';
import type { Tx } from '@agent-team/storage';
import { HttpError, type Context } from '../context.ts';
import type { Turns } from './turns.ts';

export const APPROVAL_KINDS = ['tester', 'reviewer', 'pm'] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];
const PASSING: Record<ApprovalKind, string> = { tester: 'pass', reviewer: 'pass', pm: 'pass' };
const SHA = /^[0-9a-f]{40}$/;
// A verdict given from a worker's turn waits until that worker reports the head its review worktree was verified at; then it
// is valid, or stale when the head was another one or has moved. Only valid verdicts are ever counted.
const PENDING = 'pending-verification', LIVE = ['valid', PENDING];
const refuse = (message: string) => new HttpError(409, 'review', message);

export interface ReviewInput { kind: ApprovalKind; verdict: 'pass' | 'changes' | 'fail'; headSha: string; summary: string; findings: { severity: string; path?: string | undefined; note: string }[] }

// Approvals are platform records, written only from a review turn, by an agent wearing that role, never the author,
// one agent per kind, all at the same head. They replace the coordinator's self-attested verdicts.
export function createReviews(context: Context, turns: Turns) {
  const { storage, events, now } = context;

  async function reviewersFor(tx: Tx, projectId: string, authorId: string | null) {
    const project = await tx.selectFrom('projects').select(['team_id', 'parent_id']).where('id', '=', projectId).executeTakeFirstOrThrow();
    const teamId = project.team_id ?? (project.parent_id ? (await tx.selectFrom('projects').select('team_id').where('id', '=', project.parent_id).executeTakeFirst())?.team_id : null);
    if (!teamId) return [];
    const rows = await tx.selectFrom('agents').innerJoin('agent_roles', 'agent_roles.agent_id', 'agents.id').select(['agents.id', 'agent_roles.role_slug']).where('agents.team_id', '=', teamId).where('agents.status', '=', 'active').where('agent_roles.role_slug', 'in', [...APPROVAL_KINDS]).orderBy('agents.sort').execute();
    const chosen = new Map<ApprovalKind, string>();
    for (const row of rows) {
      const kind = row.role_slug as ApprovalKind;
      if (row.id !== authorId && !chosen.has(kind) && ![...chosen.values()].includes(row.id)) chosen.set(kind, row.id);
    }
    return [...chosen].map(([kind, agentId]) => ({ kind, agentId }));
  }

  // With every required kind passing and valid at this head, the task is approved and its merge queued.
  async function settle(tx: Tx, task: { project_id: string; assignee_agent_id: string | null }, taskId: string, headSha: string, by: { agentId: string; turnId: string; kind: string; verdict: string }) {
    const valid = await tx.selectFrom('approvals').select(['kind', 'verdict']).where('task_id', '=', taskId).where('state', '=', 'valid').where('head_sha', '=', headSha).execute();
    const reviewers = await reviewersFor(tx, task.project_id, task.assignee_agent_id), required = reviewers.map(reviewer => reviewer.kind);
    const approved = required.length > 0 && required.every(kind => valid.some(row => row.kind === kind && row.verdict === PASSING[kind]));
    const pm = reviewers.find(reviewer => reviewer.kind === 'pm')?.agentId ?? null;
    if (!approved) return { approved, pm, drafts: [] };
    await tx.updateTable('tasks').set({ state: 'approved', updated_at: now() }).where('id', '=', taskId).execute();
    await tx.insertInto('merge_queue').values({ id: newId(now()), project_id: task.project_id, task_id: taskId, head_sha: headSha, state: 'queued', reason: null, created_at: now(), finished_at: null }).execute();
    return { approved, pm, drafts: [{ type: 'task.approved', actorKind: 'agent' as const, agentId: by.agentId, projectId: task.project_id, taskId, turnId: by.turnId, payload: { kind: by.kind, verdict: by.verdict, headSha } }] };
  }

  return {
    // Called when a task reaches review at a head: asks one reviewer per kind.
    async request(taskId: string, headSha: string) {
      if (!SHA.test(headSha)) throw refuse('A review needs the full head sha');
      const result = await storage.transaction(async tx => {
        const task = await tx.selectFrom('tasks').select(['project_id', 'assignee_agent_id', 'head_sha']).where('id', '=', taskId).executeTakeFirstOrThrow();
        // Any earlier verdict, counted or still waiting for its verification, was about another revision.
        if (task.head_sha !== headSha) await tx.updateTable('approvals').set({ state: 'stale' }).where('task_id', '=', taskId).where('state', 'in', LIVE).execute();
        await tx.updateTable('tasks').set({ head_sha: headSha, state: 'in_review', updated_at: now() }).where('id', '=', taskId).execute();
        const reviewers = await reviewersFor(tx, task.project_id, task.assignee_agent_id);
        const published = await events.append(tx, [{ type: 'review.requested', actorKind: 'system', projectId: task.project_id, taskId, payload: { headSha, reviewers } }]);
        return { projectId: task.project_id, reviewers, published };
      });
      events.published(result.published);
      for (const reviewer of result.reviewers) await turns.enqueue({ agentId: reviewer.agentId, projectId: result.projectId, kind: 'review', taskId, dedupeKey: `review:${taskId}:${reviewer.kind}:${headSha}` });
      return result.reviewers;
    },

    // `verification: 'worker'` is how a verdict arrives from an agent's turn: it is kept as pending and counts only once the
    // worker has reported the head it verified (see `verify`).
    async record(turn: { id: string; agent_id: string; task_id: string | null; kind: string }, input: ReviewInput, options: { verification?: 'worker' } = {}) {
      if (turn.kind !== 'review' || !turn.task_id) throw refuse('Verdicts come from a review turn on a task');
      const taskId = turn.task_id, state = options.verification === 'worker' ? PENDING : 'valid';
      const result = await storage.transaction(async tx => {
        const task = await tx.selectFrom('tasks').select(['project_id', 'assignee_agent_id', 'head_sha']).where('id', '=', taskId).executeTakeFirstOrThrow();
        if (task.assignee_agent_id === turn.agent_id) throw refuse('The author cannot approve its own work');
        if (task.head_sha !== input.headSha) throw refuse(`The task is at ${task.head_sha ?? 'no head'}; review that revision`);
        if (!await tx.selectFrom('agent_roles').select('role_slug').where('agent_id', '=', turn.agent_id).where('role_slug', '=', input.kind).executeTakeFirst()) throw refuse(`You do not hold the ${input.kind} role`);
        if (await tx.selectFrom('approvals').select('id').where('task_id', '=', taskId).where('state', 'in', LIVE).where('agent_id', '=', turn.agent_id).where('kind', '!=', input.kind).executeTakeFirst()) throw refuse('One agent gives one kind of approval per revision');
        await tx.updateTable('approvals').set({ state: 'stale' }).where('task_id', '=', taskId).where('kind', '=', input.kind).where('state', 'in', LIVE).execute();
        await tx.insertInto('approvals').values({ id: newId(now()), task_id: taskId, kind: input.kind, agent_id: turn.agent_id, turn_id: turn.id, head_sha: input.headSha, verdict: input.verdict, findings: JSON.stringify(input.findings), summary: input.summary, state, created_at: now() }).execute();

        const rejected = input.verdict !== 'pass';
        const settled = await settle(tx, task, taskId, input.headSha, { agentId: turn.agent_id, turnId: turn.id, kind: input.kind, verdict: input.verdict });
        const drafts = [{ type: 'review.recorded', actorKind: 'agent' as const, agentId: turn.agent_id, projectId: task.project_id, taskId, turnId: turn.id, payload: { kind: input.kind, verdict: input.verdict, headSha: input.headSha, state } }, ...settled.drafts];
        // Findings go back at once; an approval waits for its verification.
        if (!settled.approved && rejected) await tx.updateTable('tasks').set({ state: 'in_progress', updated_at: now() }).where('id', '=', taskId).execute();
        return { approved: settled.approved, rejected, pm: settled.pm, projectId: task.project_id, author: task.assignee_agent_id, published: await events.append(tx, drafts) };
      });
      events.published(result.published);
      // Findings go back to the author as its next work item on the task.
      if (result.rejected && result.author) await turns.enqueue({ agentId: result.author, projectId: result.projectId, kind: 'work', taskId, dedupeKey: `work:${taskId}` });
      // Merging is a deterministic turn with no model; it runs under the PM's seat so it shows in its lane.
      if (result.approved && result.pm) await turns.enqueue({ agentId: result.pm, projectId: result.projectId, kind: 'deliver', taskId, dedupeKey: `deliver:${taskId}:${input.headSha}` });
      return { approved: result.approved };
    },

    // The worker's report at the end of a review turn: the head its detached worktree was verified at before and after the engine ran.
    // A pending verdict of that turn becomes valid only when both are the head it names and the task is still there; anything else makes it stale.
    async verify(turnId: string, shas: { start?: string | undefined; end?: string | undefined }) {
      const result = await storage.transaction(async tx => {
        const pending = await tx.selectFrom('approvals').select(['id', 'task_id', 'kind', 'agent_id', 'head_sha', 'verdict']).where('turn_id', '=', turnId).where('state', '=', PENDING).execute();
        const drafts = [], deliveries: { agentId: string; projectId: string; taskId: string; headSha: string }[] = [];
        for (const row of pending) {
          const task = await tx.selectFrom('tasks').select(['project_id', 'assignee_agent_id', 'head_sha']).where('id', '=', row.task_id).executeTakeFirstOrThrow();
          const verified = shas.start !== undefined && shas.start === shas.end && shas.start === row.head_sha && task.head_sha === row.head_sha;
          await tx.updateTable('approvals').set({ state: verified ? 'valid' : 'stale' }).where('id', '=', row.id).execute();
          drafts.push({ type: verified ? 'review.verified' : 'review.stale', actorKind: 'worker' as const, agentId: row.agent_id, projectId: task.project_id, taskId: row.task_id, turnId, payload: { kind: row.kind, headSha: row.head_sha, reviewedStart: shas.start ?? null, reviewedEnd: shas.end ?? null } });
          if (!verified) continue;
          const settled = await settle(tx, task, row.task_id, row.head_sha, { agentId: row.agent_id, turnId, kind: row.kind, verdict: row.verdict });
          drafts.push(...settled.drafts);
          if (settled.approved && settled.pm) deliveries.push({ agentId: settled.pm, projectId: task.project_id, taskId: row.task_id, headSha: row.head_sha });
        }
        return { deliveries, published: drafts.length ? await events.append(tx, drafts) : [] };
      });
      events.published(result.published);
      for (const delivery of result.deliveries) await turns.enqueue({ agentId: delivery.agentId, projectId: delivery.projectId, kind: 'deliver', taskId: delivery.taskId, dedupeKey: `deliver:${delivery.taskId}:${delivery.headSha}` });
      return { approved: result.deliveries.length > 0 };
    },

    // Everything the worker's merge gate needs, read at the moment it asks.
    async deliveryFor(taskId: string) {
      const task = await storage.db.selectFrom('tasks').innerJoin('projects', 'projects.id', 'tasks.project_id').select(['tasks.key', 'tasks.head_sha', 'tasks.pr_url', 'tasks.state', 'projects.manifest']).where('tasks.id', '=', taskId).executeTakeFirstOrThrow();
      if (task.state !== 'approved' && task.state !== 'merging') throw refuse(`The task is ${task.state}, not approved`);
      if (!task.head_sha || !task.pr_url) throw refuse('The task has no published change to merge');
      return { taskKey: task.key, headSha: task.head_sha, prUrl: task.pr_url, manifest: JSON.parse(task.manifest) as Record<string, unknown>, approvals: await this.approvalsFor(taskId, task.head_sha) };
    },

    // What the merge gate is fed immediately before it merges: current platform state, never a cached copy.
    async approvalsFor(taskId: string, headSha: string) {
      const rows = await storage.db.selectFrom('approvals').select(['kind', 'verdict', 'head_sha', 'turn_id']).where('task_id', '=', taskId).where('state', '=', 'valid').where('head_sha', '=', headSha).execute();
      return Object.fromEntries(rows.map(row => [row.kind, { verdict: row.verdict === 'pass' ? (row.kind === 'tester' ? 'PASS' : 'APPROVE') : 'REJECT', headSha: row.head_sha, sessionId: row.turn_id }]));
    },
  };
}
export type Reviews = ReturnType<typeof createReviews>;
