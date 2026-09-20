import type { Context as Hc, Hono } from 'hono';
import { z } from 'zod';
import { newId } from '@agent-team/protocol';
import type { Tx } from '@agent-team/storage';
import { can, type Action, type Viewer } from '../auth/rbac.ts';
import { forbidden, HttpError, type Context } from '../context.ts';
import type { Turns } from '../runtime/turns.ts';
import { teamIdOf } from '../repos/issueTasks.ts';
import { parseBody } from './conventions.ts';

type Env = { Variables: { viewer: Viewer } };
interface Step { label: string; who: string; agentId: string | null; at: number | null; state: 'done' | 'now' | 'todo' }
const SOURCE: Record<string, string> = { product: 'Product snapshot', discussion: 'The discussion', agent: 'An agent', tracker: 'The tracker', handoff: 'A handoff', webhook: 'A webhook', internal: 'Added by the PM' };

// One task, as its own page. What was raised and what is worked on are the same object: in the inbox it shows the report and its
// triage; once accepted, the brief and the work done on it. The thread stays with it all the way. Writing on a task is direction for
// whoever has it: their next turn reads it.
export function mountTaskRoutes(app: Hono<Env>, context: Context, turns: Turns) {
  const { storage, events, now } = context, db = storage.db;
  const found = async (c: Hc<Env>, action: Action) => {
    const task = await db.selectFrom('tasks').innerJoin('projects', 'projects.id', 'tasks.project_id').select(['tasks.id', 'tasks.project_id', 'tasks.key', 'tasks.title', 'tasks.brief', 'tasks.state', 'tasks.tag', 'tasks.source', 'tasks.assignee_agent_id', 'tasks.author_agent_id', 'tasks.branch', 'tasks.head_sha', 'tasks.pr_url', 'tasks.blocked_reason', 'tasks.created_at', 'tasks.updated_at', 'projects.parent_id', 'projects.slug', 'projects.name as project']).where('tasks.id', '=', c.req.param('id')!).executeTakeFirst();
    if (!task) throw new HttpError(404, 'not_found', 'Task not found');
    if (!can(c.get('viewer'), action, task.parent_id ?? task.project_id)) throw forbidden();
    return task;
  };
  const issueOf = (taskId: string) => db.selectFrom('links').innerJoin('issues', 'issues.id', 'links.from_id').select(['issues.id', 'issues.number', 'issues.source', 'issues.priority', 'issues.thread_id', 'issues.attachment_id', 'issues.author_user_id', 'issues.created_at']).where('links.from_type', '=', 'issue').where('links.to_type', '=', 'task').where('links.to_id', '=', taskId).executeTakeFirst();
  // The report's thread when the task was raised as one, else the task's own.
  const threadOf = async (taskId: string) => (await issueOf(taskId))?.thread_id ?? (await db.selectFrom('threads').select('id').where('subject_type', '=', 'task').where('subject_id', '=', taskId).executeTakeFirst())?.id ?? null;
  const pmOf = async (projectId: string) => { const teamId = await storage.transaction(tx => teamIdOf(tx, projectId)); return teamId ? (await db.selectFrom('agents').select('id').where('team_id', '=', teamId).where('is_pm', '=', true).where('status', '=', 'active').executeTakeFirst())?.id ?? null : null; };
  const say = async (tx: Tx, task: { id: string; project_id: string; key: string; title: string }, threadId: string | null, userId: string, kind: string, body: string, payload: Record<string, unknown> = {}) => {
    let thread = threadId;
    if (!thread) { thread = newId(now()); await tx.insertInto('threads').values({ id: thread, project_id: task.project_id, kind: 'issue', subject_type: 'task', subject_id: task.id, title: `${task.key} ${task.title}`.slice(0, 200), visibility: 'team', owner_user_id: null, created_at: now() }).execute(); }
    const id = newId(now());
    await tx.insertInto('messages').values({ id, thread_id: thread, author_kind: 'user', author_id: userId, kind, body, payload: JSON.stringify(payload), created_at: now() }).execute();
    return { type: 'message.posted', actorKind: 'user' as const, userId, projectId: task.project_id, threadId: thread, taskId: task.id, payload: { messageId: id, kind } };
  };

  app.get('/api/tasks/:id', async c => {
    const task = await found(c, 'project.read'), issue = await issueOf(task.id), threadId = await threadOf(task.id), teamId = await storage.transaction(tx => teamIdOf(tx, task.project_id));
    const agents = teamId ? await db.selectFrom('agents').select(['id', 'name', 'is_pm']).where('team_id', '=', teamId).execute() : [];
    const name = (id: string | null | undefined) => agents.find(agent => agent.id === id)?.name ?? null, pm = agents.find(agent => agent.is_pm) ?? null;
    const tracker = await db.selectFrom('external_refs').select(['url', 'system', 'external_id']).where('entity_type', '=', 'task').where('entity_id', '=', task.id).executeTakeFirst();
    const done = await db.selectFrom('turns').select(['id', 'agent_id', 'kind', 'state', 'summary', 'started_at', 'finished_at']).where('task_id', '=', task.id).orderBy('started_at', 'desc').limit(20).execute();
    const live = await db.selectFrom('work_items').select(['agent_id', 'kind', 'state', 'defer_reason']).where('state', 'in', ['queued', 'leased']).where(eb => eb.or([eb('task_id', '=', task.id), ...(threadId ? [eb('thread_id', '=', threadId)] : [])])).execute();
    const approvals = await db.selectFrom('approvals').select(['kind', 'agent_id', 'verdict', 'summary', 'state', 'created_at']).where('task_id', '=', task.id).orderBy('created_at', 'desc').limit(6).execute();
    const accepted = await db.selectFrom('events').select(['at', 'user_id']).where('task_id', '=', task.id).where('type', '=', 'task.assigned').orderBy('seq').executeTakeFirst();
    const author = issue?.author_user_id ? await db.selectFrom('users').select('name').where('id', '=', issue.author_user_id).executeTakeFirst() : null;
    const messages = threadId ? await db.selectFrom('messages').select(['id', 'author_kind', 'author_id', 'kind', 'body', 'payload', 'created_at']).where('thread_id', '=', threadId).orderBy('seq', 'desc').limit(40).execute() : [];

    // Who has had it, in order. One step is lit: where it is now, with whoever is on it.
    const work = done.filter(turn => turn.kind === 'work'), firstWork = work.at(-1), lastWork = work[0];
    const triaging = live.find(item => item.kind === 'triage' || item.kind === 'reply'), working = live.find(item => item.kind === 'work'), reviewing = live.find(item => item.kind === 'review');
    const inbox = task.state === 'inbox', over = task.state === 'done', gone = task.state === 'canceled', inReview = ['in_review', 'approved', 'merging'].includes(task.state);
    const at = (reached: boolean, current: boolean): Step['state'] => (current ? 'now' : reached ? 'done' : 'todo');
    const raiser = author?.name ?? name(task.author_agent_id);
    const steps: Step[] = [
      { label: 'Raised', who: [raiser, SOURCE[issue?.source ?? task.source] ?? null].filter(Boolean).join(' · ') || 'Added', agentId: task.author_agent_id, at: Number(issue?.created_at ?? task.created_at), state: 'done' },
      { label: gone ? 'Declined' : 'Accepted', who: inbox ? (triaging ? `${name(triaging.agent_id) ?? 'The PM'} · ${triaging.state === 'leased' ? 'looking at it now' : 'up next'}` : pm ? `${pm.name} decides` : 'Waiting for a decision') : gone ? '—' : `${accepted?.user_id ? 'You' : pm?.name ?? 'The PM'} → ${name(task.assignee_agent_id) ?? 'the backlog'}`, agentId: inbox ? triaging?.agent_id ?? pm?.id ?? null : pm?.id ?? null, at: accepted ? Number(accepted.at) : null, state: at(!inbox, inbox) },
      { label: 'Picked up', who: firstWork ? name(firstWork.agent_id) ?? '—' : working && !inbox ? `${name(working.agent_id) ?? '—'} · ${working.defer_reason ? 'held' : 'up next'}` : '—', agentId: firstWork?.agent_id ?? working?.agent_id ?? null, at: firstWork ? Number(firstWork.started_at) : null, state: at(Boolean(firstWork), !firstWork && Boolean(working) && !inbox) },
      { label: 'Changed', who: lastWork?.state === 'running' ? `${name(lastWork.agent_id) ?? '—'} · working now` : task.head_sha ? `${task.head_sha.slice(0, 7)}${task.branch ? ` · ${task.branch}` : ''}` : lastWork && !inReview && !over ? `${name(lastWork.agent_id) ?? '—'} · between turns` : '—', agentId: lastWork?.agent_id ?? null, at: lastWork?.finished_at ? Number(lastWork.finished_at) : null, state: at(inReview || over, Boolean(firstWork) && !inReview && !over && !gone) },
      { label: 'Review', who: reviewing ? `${name(reviewing.agent_id) ?? '—'} · ${reviewing.state === 'leased' ? 'reviewing now' : 'up next'}` : approvals[0] ? `${name(approvals[0].agent_id) ?? '—'} · ${approvals[0].verdict}` : '—', agentId: reviewing?.agent_id ?? approvals[0]?.agent_id ?? null, at: approvals[0] ? Number(approvals[0].created_at) : null, state: at(over, inReview) },
      { label: 'Done', who: over ? 'Merged' : '—', agentId: null, at: over ? Number(task.updated_at) : null, state: at(over, false) },
    ];

    const first = messages.at(-1), report = issue && first ? JSON.parse(first.payload) as { attachmentId?: string; markers?: unknown[]; env?: string; url?: string } : null;
    const { parent_id: _parent, ...rest } = task;
    return c.json({
      task: { ...rest, created_at: Number(task.created_at), updated_at: Number(task.updated_at) }, steps,
      issue: issue ? { number: issue.number, source: SOURCE[issue.source] ?? issue.source, priority: issue.priority, raisedBy: raiser, attachmentId: issue.attachment_id ?? report?.attachmentId ?? null, markers: report?.markers ?? [], environment: report?.env ?? report?.url ?? null } : null,
      tracker: tracker ? { url: tracker.url, system: tracker.system, id: tracker.external_id } : null,
      reviewer: reviewing?.agent_id ?? approvals[0]?.agent_id ?? null, pm: pm?.id ?? null,
      log: done.map(turn => ({ id: turn.id, agentId: turn.agent_id, kind: turn.kind, state: turn.state, summary: turn.summary, at: Number(turn.started_at) })),
      approvals: approvals.map(row => ({ kind: row.kind, agentId: row.agent_id, verdict: row.verdict, summary: row.summary, stale: row.state === 'stale', at: Number(row.created_at) })),
      // The report itself is shown as the report, not again as the first message.
      messages: messages.reverse().filter(message => !(issue && message.id === first?.id)).map(message => ({ id: message.id, authorKind: message.author_kind, authorId: message.author_id, kind: message.kind, body: message.body, at: Number(message.created_at) })),
      canWrite: can(c.get('viewer'), 'project.contribute', task.parent_id ?? task.project_id),
    });
  });

  app.post('/api/tasks/:id/say', async c => {
    const task = await found(c, 'project.contribute'), input = await parseBody(c, z.object({ body: z.string().trim().min(1).max(8000) })), userId = c.get('viewer').userId, threadId = await threadOf(task.id);
    const published = await storage.transaction(async tx => events.append(tx, [await say(tx, task, threadId, userId, 'note', input.body)]));
    events.published(published);
    // Whoever has the task reads it on their next turn; one is started unless one is already queued or running. In the inbox it is the PM's to read.
    const thread = await threadOf(task.id), pm = task.state === 'inbox' ? await pmOf(task.project_id) : null;
    if (pm && thread) await turns.enqueue({ agentId: pm, projectId: task.project_id, kind: 'triage', threadId: thread, dedupeKey: `triage:${thread}` }).catch(() => {});
    else if (task.assignee_agent_id && !['inbox', 'done', 'canceled', 'stopped'].includes(task.state)) await turns.enqueue({ agentId: task.assignee_agent_id, projectId: task.project_id, kind: 'work', taskId: task.id, dedupeKey: `work:${task.id}` }).catch(() => {});
    return c.json({ ok: true });
  });

  // Out of the inbox by a person's own call: to someone (who starts on it), or to the backlog to wait for an owner.
  app.post('/api/tasks/:id/accept', async c => {
    const task = await found(c, 'project.contribute'), input = await parseBody(c, z.object({ agentId: z.string().max(60).nullable().default(null) })), userId = c.get('viewer').userId;
    if (task.state !== 'inbox') throw new HttpError(409, 'conflict', 'This was already accepted');
    const teamId = await storage.transaction(tx => teamIdOf(tx, task.project_id));
    const owner = input.agentId && teamId ? await db.selectFrom('agents').select(['id', 'name']).where('id', '=', input.agentId).where('team_id', '=', teamId).where('status', '=', 'active').executeTakeFirst() : null;
    if (input.agentId && !owner) throw new HttpError(400, 'invalid', 'Pick someone on this project\'s team', { agentId: 'Pick someone on this project\'s team' });
    const threadId = await threadOf(task.id);
    const published = await storage.transaction(async tx => {
      const lowest = await tx.selectFrom('tasks').select(eb => eb.fn.max('priority').as('n')).where('project_id', '=', task.project_id).executeTakeFirst();
      await tx.updateTable('tasks').set({ state: owner ? 'assigned' : 'backlog', assignee_agent_id: owner?.id ?? null, priority: Number(lowest?.n ?? -1) + 1, updated_at: now() }).where('id', '=', task.id).execute();
      const issue = await tx.selectFrom('links').select('from_id').where('from_type', '=', 'issue').where('to_type', '=', 'task').where('to_id', '=', task.id).executeTakeFirst();
      if (issue && owner) await tx.updateTable('issues').set({ owner_agent_id: owner.id }).where('id', '=', issue.from_id).execute();
      return events.append(tx, [await say(tx, task, threadId, userId, 'decision', owner ? `Accepted. ${owner.name} takes it.` : 'Accepted into the backlog.', { accepted: true }), { type: owner ? 'task.assigned' : 'task.state_changed', actorKind: 'user', userId, ...(owner ? { agentId: owner.id } : {}), projectId: task.project_id, taskId: task.id, payload: { from: 'inbox', to: owner ? 'assigned' : 'backlog' } }]);
    });
    events.published(published);
    if (owner) await turns.enqueue({ agentId: owner.id, projectId: task.project_id, kind: 'work', taskId: task.id, dedupeKey: `work:${task.id}` });
    return c.json({ ok: true });
  });

  // Not to be done, or the same as something already on the board: it leaves the inbox, and says where it went.
  app.post('/api/tasks/:id/decline', async c => {
    const task = await found(c, 'project.contribute'), input = await parseBody(c, z.object({ reason: z.string().trim().max(600).default(''), intoTaskId: z.string().max(60).optional() })), userId = c.get('viewer').userId;
    if (task.state !== 'inbox') throw new HttpError(409, 'conflict', 'Only what waits in the inbox can be declined or merged');
    const into = input.intoTaskId ? await db.selectFrom('tasks').select(['id', 'key', 'title', 'project_id']).where('id', '=', input.intoTaskId).where('project_id', '=', task.project_id).where('id', '!=', task.id).executeTakeFirst() : null;
    if (input.intoTaskId && !into) throw new HttpError(400, 'invalid', 'Pick a task of this project to merge it into', { intoTaskId: 'Pick a task of this project' });
    const threadId = await threadOf(task.id), intoThread = into ? await threadOf(into.id) : null;
    const published = await storage.transaction(async tx => {
      await tx.updateTable('tasks').set({ state: 'canceled', updated_at: now() }).where('id', '=', task.id).execute();
      const issue = await tx.selectFrom('links').select('from_id').where('from_type', '=', 'issue').where('to_type', '=', 'task').where('to_id', '=', task.id).executeTakeFirst();
      if (issue) await tx.updateTable('issues').set({ state: 'closed', closed_at: now() }).where('id', '=', issue.from_id).execute();
      const drafts = [await say(tx, task, threadId, userId, 'decision', into ? `Merged into ${into.key}.` : `Declined${input.reason ? `: ${input.reason}` : '.'}`, { declined: true })];
      if (into) {
        await tx.insertInto('links').values({ from_type: 'task', from_id: task.id, to_type: 'task', to_id: into.id, rel: 'duplicates', created_at: now() }).execute();
        // What was reported travels with it, so whoever has the other task reads it.
        drafts.push(await say(tx, into, intoThread, userId, 'note', `Also reported as ${task.key}: ${task.title}\n\n${task.brief}`.slice(0, 7000), { mergedFrom: task.id }));
      }
      return events.append(tx, [...drafts, { type: 'task.state_changed', actorKind: 'user', userId, projectId: task.project_id, taskId: task.id, payload: { from: 'inbox', to: 'canceled', ...(into ? { mergedInto: into.id } : {}) } }]);
    });
    events.published(published);
    return c.json({ ok: true });
  });
}
