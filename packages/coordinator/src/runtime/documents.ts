import { newId } from '@agent-team/protocol';
import type { Tx } from '@agent-team/storage';
import type { Context } from '../context.ts';
import { HttpError } from '../context.ts';
import type { Turns } from './turns.ts';
import { wayOfWorking } from './wayOfWorking.ts';

// Work whose result is a document. The result is a page of the knowledge store at a revision; it is reviewed at that revision
// the way a change is reviewed at a commit, and the task is done when every reviewer asked has passed that revision. No branch,
// worktree, merge queue or delivery is involved. A new revision makes earlier verdicts stale, exactly as a new commit does.
export interface DocumentRef {
  pageId: string;
  path: string;
  rev: number;
}

// Roles whose job includes judging someone else's work.
const REVIEWING_ROLES = ['reviewer', 'tester', 'editor'];
const refuse = (message: string) => new HttpError(409, 'document', message);

// The name a document revision goes by where a change's commit id would stand.
export const revisionId = (ref: DocumentRef) => `doc:${ref.pageId}@${ref.rev}`;

export function parseRef(raw: string | null): DocumentRef | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as DocumentRef; } catch { return null; }
}

export function createDocuments(context: Context, turns: Turns) {
  const { storage, events, now } = context;

  // Seats of the team, other than the author, that wear a reviewing role: as many as the team's way of working says (two as shipped); with none, the PM judges it.
  async function reviewersFor(tx: Tx, projectId: string, authorId: string | null): Promise<string[]> {
    const project = await tx.selectFrom('projects').select(['team_id', 'parent_id']).where('id', '=', projectId).executeTakeFirstOrThrow();
    const teamId = project.team_id ?? (project.parent_id ? (await tx.selectFrom('projects').select('team_id').where('id', '=', project.parent_id).executeTakeFirst())?.team_id : null);
    if (!teamId) return [];
    const seats = await tx.selectFrom('agents').leftJoin('agent_roles', 'agent_roles.agent_id', 'agents.id').select(['agents.id', 'agents.is_pm', 'agent_roles.role_slug'])
      .where('agents.team_id', '=', teamId).where('agents.status', '=', 'active').orderBy('agents.sort').execute();
    const others = seats.filter(seat => seat.id !== authorId);
    const { knobs } = await wayOfWorking(tx, projectId);
    const reviewing = [...new Set(others.filter(seat => seat.role_slug && REVIEWING_ROLES.includes(seat.role_slug)).map(seat => seat.id))].slice(0, knobs.documentReviewers);
    if (reviewing.length) return reviewing;
    const pm = others.find(seat => seat.is_pm);
    return pm ? [pm.id] : [];
  }

  return {
    // The owner says the document is ready: the page as it reads now is what gets reviewed.
    async submit(turn: { id: string; agent_id: string; project_id: string; task_id: string | null }, path: string) {
      const result = await storage.transaction(async tx => {
        const task = await tx.selectFrom('tasks').select(['id', 'project_id', 'assignee_agent_id', 'result_kind', 'result_ref']).where('id', '=', turn.task_id!).executeTakeFirstOrThrow();
        if (task.result_kind !== 'document') throw refuse('This task ends in a change, not a document; report ready_for_review without `document`.');
        const project = await tx.selectFrom('projects').select(['id', 'parent_id']).where('id', '=', task.project_id).executeTakeFirstOrThrow();
        const page = await tx.selectFrom('kb_pages').select(['id', 'path', 'current_rev']).where('path', '=', path).where('archived_at', 'is', null)
          .where(eb => eb.or([eb.and([eb('scope_type', '=', 'project'), eb('scope_id', '=', project.parent_id ?? project.id)]), eb.and([eb('scope_type', '=', 'subproject'), eb('scope_id', '=', project.id)])])).executeTakeFirst();
        if (!page) throw refuse(`There is no knowledge page at ${path} in this project. Write it with knowledge.write first, then report it.`);
        const ref: DocumentRef = { pageId: page.id, path: page.path, rev: Number(page.current_rev) };
        const reviewers = await reviewersFor(tx, task.project_id, task.assignee_agent_id);
        // A verdict on an earlier revision says nothing about this one.
        const earlier = parseRef(task.result_ref);
        if (earlier && revisionId(earlier) !== revisionId(ref)) await tx.updateTable('approvals').set({ state: 'stale' }).where('task_id', '=', task.id).where('state', '=', 'valid').execute();
        await tx.updateTable('tasks').set({ state: reviewers.length ? 'in_review' : 'done', result_ref: JSON.stringify(ref), blocked_reason: null, updated_at: now() }).where('id', '=', task.id).execute();
        const published = await events.append(tx, [{ type: 'review.requested', actorKind: 'agent', agentId: turn.agent_id, projectId: task.project_id, taskId: task.id, turnId: turn.id, payload: { document: ref, reviewers } }]);
        return { ref, reviewers, projectId: task.project_id, taskId: task.id, published };
      });
      events.published(result.published);
      for (const agentId of result.reviewers) await turns.enqueue({ agentId, projectId: result.projectId, kind: 'review', taskId: result.taskId, dedupeKey: `docreview:${result.taskId}:${agentId}:${result.ref.rev}` });
      return { state: result.reviewers.length ? 'in_review' : 'done', document: result.ref };
    },

    // One reviewer's verdict on the revision it was given. All asked pass: the task is done. Anyone asks for changes: it goes back to its owner.
    async review(turn: { id: string; agent_id: string; project_id: string; task_id: string | null }, input: { verdict: 'pass' | 'changes'; summary: string; findings: { severity: string; note: string }[] }) {
      if (!turn.task_id) throw refuse('This turn has no task');
      const result = await storage.transaction(async tx => {
        const task = await tx.selectFrom('tasks').select(['id', 'project_id', 'assignee_agent_id', 'result_kind', 'result_ref', 'state']).where('id', '=', turn.task_id!).executeTakeFirstOrThrow();
        const ref = parseRef(task.result_ref);
        if (task.result_kind !== 'document' || !ref) throw refuse('This task has no document under review; use task.review for a change.');
        if (task.assignee_agent_id === turn.agent_id) throw refuse('An author does not review their own work');
        if (task.state !== 'in_review') throw refuse(`The task is ${task.state}, not in review`);
        const revision = revisionId(ref);
        if (await tx.selectFrom('approvals').select('id').where('task_id', '=', task.id).where('agent_id', '=', turn.agent_id).where('head_sha', '=', revision).where('state', '=', 'valid').executeTakeFirst()) throw refuse('You already gave your verdict on this revision');
        await tx.insertInto('approvals').values({ id: newId(now()), task_id: task.id, kind: 'reviewer', agent_id: turn.agent_id, turn_id: turn.id, head_sha: revision, verdict: input.verdict, findings: JSON.stringify(input.findings), summary: input.summary, state: 'valid', created_at: now() }).execute();
        await tx.updateTable('turns').set({ summary: input.summary }).where('id', '=', turn.id).execute();

        const asked = await reviewersFor(tx, task.project_id, task.assignee_agent_id);
        const given = await tx.selectFrom('approvals').select(['agent_id', 'verdict']).where('task_id', '=', task.id).where('head_sha', '=', revision).where('state', '=', 'valid').execute();
        const sentBack = given.some(row => row.verdict !== 'pass');
        const accepted = !sentBack && asked.every(agentId => given.some(row => row.agent_id === agentId));
        const state = sentBack ? 'in_progress' : accepted ? 'done' : 'in_review';
        if (state !== 'in_review') await tx.updateTable('tasks').set({ state, updated_at: now() }).where('id', '=', task.id).execute();
        const drafts = [
          { type: 'review.recorded', actorKind: 'agent' as const, agentId: turn.agent_id, projectId: task.project_id, taskId: task.id, turnId: turn.id, payload: { document: ref, verdict: input.verdict } },
          ...(state === 'in_review' ? [] : [{ type: 'task.state_changed', actorKind: 'agent' as const, agentId: turn.agent_id, projectId: task.project_id, taskId: task.id, turnId: turn.id, payload: { from: 'in_review', to: state, document: ref } }]),
        ];
        return { state, ownerId: task.assignee_agent_id, projectId: task.project_id, taskId: task.id, published: await events.append(tx, drafts) };
      });
      events.published(result.published);
      // Sent back: its owner is started on it at once, with the findings in the packet.
      if (result.state === 'in_progress' && result.ownerId) await turns.enqueue({ agentId: result.ownerId, projectId: result.projectId, kind: 'work', taskId: result.taskId, dedupeKey: `docchanges:${result.taskId}:${turn.id}` });
      return { recorded: true, state: result.state };
    },

    // The document as it read at the revision under review, for a reviewer's packet.
    async underReview(tx: Tx, taskId: string): Promise<{ ref: DocumentRef; title: string; body: string } | null> {
      const task = await tx.selectFrom('tasks').select(['result_kind', 'result_ref']).where('id', '=', taskId).executeTakeFirst();
      const ref = task?.result_kind === 'document' ? parseRef(task.result_ref) : null;
      if (!ref) return null;
      const page = await tx.selectFrom('kb_pages').select('title').where('id', '=', ref.pageId).executeTakeFirst();
      const revision = await tx.selectFrom('kb_revisions').select('body').where('page_id', '=', ref.pageId).where('rev_no', '=', ref.rev).executeTakeFirst();
      return revision ? { ref, title: page?.title ?? ref.path, body: revision.body } : null;
    },
  };
}
export type Documents = ReturnType<typeof createDocuments>;
