import { z } from 'zod';
import { IdeaProposal, newId, type EventDraft, type TaskState } from '@agent-team/protocol';
import type { Context } from '../context.ts';
import { createTurns, type Turns } from '../runtime/turns.ts';
import { createCursors } from './cursors.ts';

// The neutral issue shape every tracker adapter returns. The last three are only known to trackers that have the notion.
export interface TrackerIssue { identifier: string; title: string; description?: string | null; url?: string | null; updatedAt?: string | null; state: { name: string; type: string }; labels: { name: string }[]; archived?: boolean; child?: boolean; blocked?: boolean }
export interface TrackerComment { id: string; body: string; author: string; createdAt: string }
// The normalized state types, plus review, which trackers carry as a started state or a progress label.
export type TrackerState = 'backlog' | 'unstarted' | 'started' | 'in_review' | 'completed' | 'canceled';
// Reading is required; a client without the writing methods still mirrors the board one way.
export interface TrackerClient {
  snapshot(manifest: Record<string, unknown>): Promise<{ allIssues: TrackerIssue[] }>;
  setState?(manifest: Record<string, unknown>, issue: string, state: TrackerState): Promise<void>;
  comment?(manifest: Record<string, unknown>, issue: string, body: string): Promise<{ id: string }>;
  comments?(manifest: Record<string, unknown>, issue: string, since: string | null): Promise<TrackerComment[]>;
  addLabel?(manifest: Record<string, unknown>, issue: string, label: string): Promise<void>;
  createIssue?(manifest: Record<string, unknown>, input: { title: string; body: string; labels: string[]; state: string }): Promise<{ identifier: string; url: string | null }>;
}

const IN_REVIEW = /in.?review/i, IN_PROGRESS = /in.?progress/i;
type Bucket = 'backlog' | 'in_progress' | 'in_review' | 'done' | 'canceled';

// The tracker is the board of record for state, title and labels. Columns come from the normalized state type,
// refined by the progress labels that label-based trackers use.
export function taskStateOf(issue: TrackerIssue): Bucket {
  const labels = issue.labels.map(label => label.name);
  if (issue.state.type === 'completed') return 'done';
  if (issue.state.type === 'canceled') return 'canceled';
  if (IN_REVIEW.test(issue.state.name) || labels.some(label => IN_REVIEW.test(label))) return 'in_review';
  if (issue.state.type === 'started' || IN_PROGRESS.test(issue.state.name) || labels.some(label => IN_PROGRESS.test(label))) return 'in_progress';
  return 'backlog';
}
// What a local state looks like from the tracker: the finer states the platform owns collapse onto the tracker's few.
const BUCKETS: Record<TaskState, Bucket> = { inbox: 'backlog', backlog: 'backlog', assigned: 'backlog', in_progress: 'in_progress', awaiting_decision: 'in_progress', blocked: 'in_progress', quarantined: 'in_progress', stopped: 'in_progress', in_review: 'in_review', approved: 'in_review', merging: 'in_review', done: 'done', canceled: 'canceled' };
const bucketOf = (state: string): Bucket => BUCKETS[state as TaskState] ?? 'backlog';
const REMOTE: Record<Bucket, TrackerState> = { backlog: 'unstarted', in_progress: 'started', in_review: 'in_review', done: 'completed', canceled: 'canceled' };
const tagOf = (issue: TrackerIssue) => issue.labels.map(label => label.name).find(name => !/^(agent|owner|idea)[:/]/i.test(name)) ?? null;
// States the platform owns while it works; a poll must not pull a task out of them.
const LOCAL: readonly string[] = ['awaiting_decision', 'blocked', 'quarantined', 'approved', 'merging', 'stopped'];
// Either label means a human decision or repair is pending.
const HOLD_LABELS: readonly string[] = ['agent:blocked', 'owner:decision'];
const terminal = (issue: TrackerIssue) => issue.state.type === 'completed' || issue.state.type === 'canceled';
const has = (issue: TrackerIssue, label: string) => issue.labels.some(item => item.name === label);

// The `ideation` section of a project's manifest: which label marks an idea, which states mean proposed, approved and rejected,
// how many unfinished ideas there may be, and how often the PM is asked for more.
export const Ideation = z.object({ enabled: z.literal(true), backlogCap: z.number().int().min(1).max(50), batchSize: z.number().int().min(1).max(10), minimumIntervalHours: z.number().int().min(1).max(168),
  ideaLabel: z.string().trim().min(1).max(80), proposedState: z.string().trim().min(1).max(80), approvedState: z.string().trim().min(1).max(80), rejectedState: z.string().trim().min(1).max(80) })
  .refine(config => config.batchSize <= config.backlogCap && new Set([config.proposedState, config.approvedState, config.rejectedState]).size === 3);
export type Ideation = z.infer<typeof Ideation>;
export const ideationOf = (manifest: { ideation?: unknown }): Ideation | null => { const parsed = Ideation.safeParse(manifest.ideation); return parsed.success ? parsed.data : null; };

// An idea becomes work only while its owner approves it: in the approved state, not on hold, not blocked, a root issue.
export function approvalStatus(config: Ideation, issue: TrackerIssue | undefined): { allowed: boolean; reason: string } {
  if (!issue || issue.archived || issue.child || !has(issue, config.ideaLabel)) return { allowed: false, reason: 'Not an active idea of this project' };
  if (issue.state.name !== config.approvedState || terminal(issue)) return { allowed: false, reason: 'Owner approval required' };
  if (issue.labels.some(label => HOLD_LABELS.includes(label.name))) return { allowed: false, reason: 'Idea is on hold for a decision or repair' };
  if (issue.blocked) return { allowed: false, reason: 'Idea is blocked' };
  return { allowed: true, reason: 'Owner approved' };
}

const titleKey = (title: string) => title.trim().normalize('NFKC').toLowerCase();
const ideaBody = (proposal: IdeaProposal, marker: string) => ([['Problem', proposal.problem], ['Benefit', proposal.benefit], ['Scope', proposal.scope], ['Success criteria', proposal.successCriteria.map(line => `- ${line}`).join('\n')], ['Size', `${proposal.effort} (relative scope, not a time estimate)`], ['Evidence', proposal.evidence.map(line => `- ${line}`).join('\n')], ['Why now', proposal.whyNow]] as const).map(([heading, body]) => `## ${heading}\n${body}`).join('\n\n') + `\n\n${marker}`;

// What this platform wrote over there says so, and is never read back in as somebody's comment.
const ORIGIN = /<!-- agent-team:[\w-]+ -->/;
const OUTBOUND = 'tracker.outbound', INBOUND = 'tracker';
const SKEW_MS = 5 * 60_000;

export function createTrackerSync(context: Context, turns: Pick<Turns, 'enqueue'> = createTurns(context)) {
  const { storage, events, now } = context;
  const db = storage.db;
  const cursors = createCursors(context);

  // Local changes since the last poll go out first: card moves and platform state changes, thread messages, and the PM's ideas.
  // An event is tried once. A write the tracker refuses is reported on the cursor and not repeated; for state, the remote then wins.
  async function pushOut(projectId: string, system: string, client: TrackerClient, manifest: Record<string, unknown>, config: Ideation | null, issues: TrackerIssue[]) {
    const stored = await cursors.cursor(projectId, OUTBOUND);
    // The first poll starts from the head of the log, so connecting a tracker never replays history into it.
    if (stored === null) { const head = await events.head(); await cursors.ok(projectId, OUTBOUND, String(head)); return { pushed: new Set<string>(), cursor: head }; }
    const rows = await db.selectFrom('events').select(['seq', 'type', 'task_id', 'thread_id', 'turn_id', 'payload']).where('project_id', '=', projectId).where('type', 'in', ['task.state_changed', 'message.posted', 'ideation.proposed']).where('seq', '>', Number(stored)).orderBy('seq').limit(200).execute();
    const pushed = new Set<string>(), moved = new Map<string, string>();
    let failure: unknown = null;
    const attempt = async (work: () => Promise<unknown>) => { try { await work(); return true; } catch (error) { failure = error; return false; } };
    const byKey = new Map(issues.map(issue => [issue.identifier, issue]));

    for (const row of rows) {
      const payload = JSON.parse(row.payload) as { source?: string; origin?: string; from?: string; messageId?: string; proposals?: unknown };
      if (row.type === 'task.state_changed' && row.task_id && payload.source !== 'tracker' && payload.from && !moved.has(row.task_id)) moved.set(row.task_id, payload.from);

      if (row.type === 'message.posted' && payload.origin !== 'tracker' && payload.messageId && row.thread_id && client.comment) {
        const thread = await db.selectFrom('threads').select(['subject_type', 'subject_id', 'visibility']).where('id', '=', row.thread_id).executeTakeFirst();
        const ref = thread?.visibility === 'team' && thread.subject_type && thread.subject_id ? await db.selectFrom('external_refs').select('external_id').where('entity_type', '=', thread.subject_type).where('entity_id', '=', thread.subject_id).where('system', '=', system).executeTakeFirst() : undefined;
        const message = ref ? await db.selectFrom('messages').select(['id', 'body', 'author_kind', 'author_id']).where('id', '=', payload.messageId).executeTakeFirst() : undefined;
        if (!ref || !message || await db.selectFrom('external_refs').select('external_id').where('entity_type', '=', 'message').where('entity_id', '=', message.id).where('system', '=', system).executeTakeFirst()) continue;
        const author = message.author_kind === 'agent' && message.author_id ? (await db.selectFrom('agents').select('name').where('id', '=', message.author_id).executeTakeFirst())?.name : message.author_kind === 'user' && message.author_id ? (await db.selectFrom('users').select('name').where('id', '=', message.author_id).executeTakeFirst())?.name : null;
        await attempt(async () => {
          const created = await client.comment!(manifest, ref.external_id, `**${author ?? (message.author_kind === 'user' ? 'Owner' : 'System')}**: ${message.body.slice(0, 5600)}\n\n<!-- agent-team:${message.id} -->`);
          await db.insertInto('external_refs').values({ entity_type: 'message', entity_id: message.id, system, external_id: created.id, url: null, synced_at: now(), remote_version: null }).execute();
        });
      }

      // Ideas become issues in the proposed state, where they wait for the owner. The marker makes a repeated publish a no-op.
      if (row.type === 'ideation.proposed' && config && client.createIssue) {
        const proposals = z.array(IdeaProposal).max(config.batchSize).safeParse(payload.proposals);
        const created: string[] = [];
        let skipped = 0;
        for (const [index, proposal] of (proposals.success ? proposals.data : []).entries()) {
          const marker = `Agent-Team idea: ${row.turn_id ?? row.seq}:${index + 1}`;
          const unfinished = issues.filter(issue => has(issue, config.ideaLabel) && !issue.archived && !terminal(issue)).length;
          if (unfinished >= config.backlogCap || issues.some(issue => (issue.description ?? '').split('\n').includes(marker) || titleKey(issue.title) === titleKey(proposal.title))) { skipped++; continue; }
          const ok = await attempt(async () => {
            const issue = await client.createIssue!(manifest, { title: proposal.title, body: ideaBody(proposal, marker), labels: [config.ideaLabel], state: config.proposedState });
            issues.push({ identifier: issue.identifier, title: proposal.title, description: marker, url: issue.url, state: { name: config.proposedState, type: 'backlog' }, labels: [{ name: config.ideaLabel }] });
            created.push(issue.identifier);
          });
          if (!ok) skipped++;
        }
        const published = await storage.transaction(tx => events.append(tx, [{ type: 'ideation.published', actorKind: 'system', projectId, turnId: row.turn_id, payload: { created, skipped } }]));
        events.published(published);
      }
    }

    // A card that moved here moves there, unless the issue moved there too since we last looked: then the remote wins.
    if (client.setState) for (const [taskId, from] of moved) {
      const task = await db.selectFrom('tasks').select(['key', 'state', 'source']).where('id', '=', taskId).executeTakeFirst();
      const issue = task?.source === 'tracker' ? byKey.get(task.key) : undefined;
      if (!task || !issue) continue;
      const wanted = bucketOf(task.state), remote = taskStateOf(issue);
      if (wanted === remote || bucketOf(from) !== remote) continue;
      if (await attempt(() => client.setState!(manifest, task.key, REMOTE[wanted]))) pushed.add(taskId);
    }
    const cursor = rows.length ? Number(rows.at(-1)!.seq) : Number(stored);
    if (failure) await cursors.fail(projectId, OUTBOUND, failure, String(cursor)); else await cursors.ok(projectId, OUTBOUND, String(cursor));
    return { pushed, cursor };
  }

  // The PM is asked for ideas when the schedule is due, the backlog has room and the team has nothing queued.
  async function ideate(projectId: string, config: Ideation, issues: TrackerIssue[], busy: boolean) {
    const interval = config.minimumIntervalHours * 3_600_000;
    await db.insertInto('schedules').values({ id: newId(now()), project_id: projectId, kind: 'ideate', interval_ms: interval, next_at: now(), last_at: null }).onConflict(oc => oc.columns(['project_id', 'kind']).doNothing()).execute();
    const schedule = await db.selectFrom('schedules').selectAll().where('project_id', '=', projectId).where('kind', '=', 'ideate').executeTakeFirstOrThrow();
    // The interval follows the manifest; changing it moves the next date to one interval after the last run.
    let nextAt = Number(schedule.next_at);
    if (Number(schedule.interval_ms) !== interval) {
      if (schedule.last_at !== null) nextAt = Number(schedule.last_at) + interval;
      await db.updateTable('schedules').set({ interval_ms: interval, next_at: nextAt }).where('id', '=', schedule.id).execute();
    }
    const remaining = config.backlogCap - issues.filter(issue => has(issue, config.ideaLabel) && !issue.archived && !terminal(issue)).length;
    if (busy || nextAt > now() || remaining <= 0) return false;
    if (await db.selectFrom('work_items').select('id').where('project_id', '=', projectId).where('state', 'in', ['queued', 'leased']).executeTakeFirst()) return false;
    const project = await db.selectFrom('projects').select(['team_id', 'parent_id']).where('id', '=', projectId).executeTakeFirst();
    const teamId = project?.team_id ?? (project?.parent_id ? (await db.selectFrom('projects').select('team_id').where('id', '=', project.parent_id).executeTakeFirst())?.team_id : null);
    const pm = teamId ? await db.selectFrom('agents').select('id').where('team_id', '=', teamId).where('is_pm', '=', true).where('status', '=', 'active').executeTakeFirst() : undefined;
    if (!pm || !await turns.enqueue({ agentId: pm.id, projectId, kind: 'ideate', dedupeKey: `ideate:${projectId}:${Math.floor(now() / interval)}` })) return false;
    const at = now();
    await db.updateTable('schedules').set({ last_at: at, next_at: at + interval }).where('id', '=', schedule.id).execute();
    return true;
  }

  async function run(projectId: string, client: TrackerClient) {
    const project = await db.selectFrom('projects').select('manifest').where('id', '=', projectId).executeTakeFirstOrThrow();
    // The tracker's own settings sit under `tracker` in the manifest; the ideation section travels with them, because
    // label-based trackers read their workflow states from it.
    const full = JSON.parse(project.manifest) as { tracker?: Record<string, unknown>; ideation?: unknown };
    const config = ideationOf(full), system = typeof full.tracker?.kind === 'string' ? full.tracker.kind : 'tracker';
    const manifest = { ...(full.tracker ?? {}), ...(config ? { ideation: config } : {}) };
    const readyLabel = typeof full.tracker?.readyLabel === 'string' && full.tracker.readyLabel.trim() ? full.tracker.readyLabel : null;
    const { allIssues } = await client.snapshot(manifest);
    const out = await pushOut(projectId, system, client, manifest, config, allIssues);

    const before = new Map((await db.selectFrom('tasks').select(['id', 'key', 'state', 'blocked_reason']).where('project_id', '=', projectId).where('source', '=', 'tracker').execute()).map(task => [task.key, task]));
    const refs = new Map((before.size ? await db.selectFrom('external_refs').selectAll().where('entity_type', '=', 'task').where('system', '=', system).where('entity_id', 'in', [...before.values()].map(task => task.id)).execute() : []).map(ref => [ref.entity_id, ref]));
    // Network first, the transaction after. An approved idea is prepared for the team by marking it ready; one that cannot be marked waits for the next poll.
    const unprepared = new Set<string>(), incoming = new Map<string, TrackerComment[]>();
    for (const issue of allIssues) {
      const task = before.get(issue.identifier), ref = task ? refs.get(task.id) : undefined;
      if (config && readyLabel && client.addLabel && approvalStatus(config, issue).allowed && !has(issue, readyLabel) && (!task || task.state === 'canceled' || Boolean(task.blocked_reason))) await client.addLabel(manifest, issue.identifier, readyLabel).catch(() => unprepared.add(issue.identifier));
      // Comments are read only where the issue changed since the last poll, from a little before it to allow for clock skew.
      if (task && ref && client.comments && issue.updatedAt && ref.remote_version !== issue.updatedAt && !terminal(issue)) {
        const found = await client.comments(manifest, issue.identifier, new Date(Number(ref.synced_at) - SKEW_MS).toISOString()).catch(() => []);
        if (found.length) incoming.set(issue.identifier, found.filter(comment => !ORIGIN.test(comment.body)));
      }
    }

    const result = await storage.transaction(async tx => {
      const existing = new Map((await tx.selectFrom('tasks').select(['id', 'key', 'title', 'brief', 'state', 'tag', 'blocked_reason']).where('project_id', '=', projectId).where('source', '=', 'tracker').execute()).map(task => [task.key, task]));
      // A local move made after the outbound pass has not reached the tracker yet; this poll must not undo it.
      const pending = new Set([...out.pushed, ...(await tx.selectFrom('events').select('task_id').where('project_id', '=', projectId).where('type', '=', 'task.state_changed').where('seq', '>', out.cursor).execute()).map(row => row.task_id ?? '')]);
      const drafts: EventDraft[] = [];
      let created = 0, updated = 0, canceled = 0, comments = 0, approved = 0;
      const remember = async (taskId: string, issue: TrackerIssue, known: boolean) => {
        const values = { external_id: issue.identifier, url: issue.url ?? null, synced_at: now(), remote_version: issue.updatedAt ?? null };
        if (known) await tx.updateTable('external_refs').set(values).where('entity_type', '=', 'task').where('entity_id', '=', taskId).where('system', '=', system).execute();
        else await tx.insertInto('external_refs').values({ entity_type: 'task', entity_id: taskId, system, ...values }).execute();
      };

      for (const [index, issue] of allIssues.entries()) {
        const state = taskStateOf(issue), tag = tagOf(issue), task = existing.get(issue.identifier);
        const approval = config && has(issue, config.ideaLabel) ? approvalStatus(config, issue) : null;
        if (!task) {
          // Everything in the tracker is on the board. An idea its owner has not approved, or one on hold, is shown held in the
          // backlog with the reason; holding it is what keeps it from being worked on, not hiding it.
          if (state === 'canceled') continue;
          const heldBecause = approval && !terminal(issue) && (!approval.allowed || unprepared.has(issue.identifier)) ? (approval.allowed ? 'Approved; being marked ready' : approval.reason) : null;
          const id = newId(now());
          await tx.insertInto('tasks').values({ id, project_id: projectId, key: issue.identifier, source: 'tracker', title: issue.title, brief: issue.description ?? '', tag, priority: index, milestone_id: null, state: heldBecause ? 'backlog' : state, assignee_agent_id: null, author_agent_id: null, branch: null, head_sha: null, pr_url: null, blocked_reason: heldBecause, created_at: now(), updated_at: now() }).execute();
          await remember(id, issue, false);
          drafts.push({ type: 'task.synced', actorKind: 'system', projectId, taskId: id, payload: { key: issue.identifier, state, ...(approval?.allowed ? { approved: true } : {}) } });
          created++;
          if (approval?.allowed) approved++;
          continue;
        }
        await remember(task.id, issue, refs.has(task.id));
        for (const comment of incoming.get(issue.identifier) ?? []) {
          if (await tx.selectFrom('external_refs').select('entity_id').where('entity_type', '=', 'message').where('system', '=', system).where('external_id', '=', comment.id).executeTakeFirst()) continue;
          let thread = await tx.selectFrom('threads').select('id').where('subject_type', '=', 'task').where('subject_id', '=', task.id).executeTakeFirst();
          if (!thread) { thread = { id: newId(now()) }; await tx.insertInto('threads').values({ id: thread.id, project_id: projectId, kind: 'issue', subject_type: 'task', subject_id: task.id, title: `${task.key} ${issue.title}`.slice(0, 200), visibility: 'team', owner_user_id: null, created_at: now() }).execute(); }
          const messageId = newId(now());
          await tx.insertInto('messages').values({ id: messageId, thread_id: thread.id, author_kind: 'user', author_id: null, kind: 'note', body: comment.body.slice(0, 8000), payload: JSON.stringify({ origin: 'tracker', system, author: comment.author, externalId: comment.id }), created_at: now() }).execute();
          await tx.insertInto('external_refs').values({ entity_type: 'message', entity_id: messageId, system, external_id: comment.id, url: null, synced_at: now(), remote_version: comment.createdAt || null }).execute();
          drafts.push({ type: 'message.posted', actorKind: 'user', projectId, taskId: task.id, threadId: thread.id, payload: { messageId, kind: 'note', origin: 'tracker' } });
          comments++;
        }
        // An idea that is no longer approved (or was put on hold) stays on the board, held: what has not started is taken off the
        // queue, and work already under way is the team's to finish or the owner's to stop. Approval clears the hold again.
        const hold = approval && !terminal(issue) && !approval.allowed ? approval.reason : null;
        if (hold && bucketOf(task.state) === 'backlog') {
          if (task.blocked_reason !== hold || task.state === 'canceled') {
            await tx.updateTable('tasks').set({ state: 'backlog', blocked_reason: hold, title: issue.title, brief: issue.description ?? '', tag, updated_at: now() }).where('id', '=', task.id).execute();
            await tx.updateTable('work_items').set({ state: 'canceled' }).where('task_id', '=', task.id).where('state', '=', 'queued').execute();
            drafts.push({ type: 'task.state_changed', actorKind: 'system', projectId, taskId: task.id, payload: { from: task.state, to: 'backlog', source: 'tracker', reason: 'held', why: hold } });
            canceled++;
          }
          continue;
        }
        if (!hold && task.blocked_reason && bucketOf(task.state) === 'backlog') await tx.updateTable('tasks').set({ blocked_reason: null, updated_at: now() }).where('id', '=', task.id).execute();
        // Remote wins where the two disagree about the column; the finer local states within a column are the platform's.
        const nextState = pending.has(task.id) || bucketOf(task.state) === state || (LOCAL.includes(task.state) && state !== 'done' && state !== 'canceled') ? task.state : state;
        if (task.title === issue.title && task.tag === tag && task.state === nextState && task.brief === (issue.description ?? '')) continue;
        await tx.updateTable('tasks').set({ title: issue.title, brief: issue.description ?? '', tag, state: nextState, updated_at: now() }).where('id', '=', task.id).execute();
        if (task.state !== nextState) drafts.push({ type: 'task.state_changed', actorKind: 'system', projectId, taskId: task.id, payload: { from: task.state, to: nextState, source: 'tracker' } });
        updated++;
      }
      await tx.updateTable('connections').set({ last_sync_at: now() }).where('project_id', '=', projectId).where('kind', '=', system).execute();
      return { created, updated, canceled, comments, approved, published: drafts.length ? await events.append(tx, drafts) : [] };
    });
    events.published(result.published);
    const ideating = config ? await ideate(projectId, config, allIssues, result.approved > 0) : false;
    return { created: result.created, updated: result.updated, canceled: result.canceled, comments: result.comments, ideating };
  }

  return {
    // One poll of one project. Remote wins for title, tag and state; assignee, branch and thread are local and never overwritten.
    // A failing poll is recorded on the project's cursor, so the integrations page can say since when.
    async syncProject(projectId: string, client: TrackerClient) {
      try {
        const result = await run(projectId, client);
        await cursors.ok(projectId, INBOUND);
        return result;
      } catch (error) {
        await cursors.fail(projectId, INBOUND, error).catch(() => undefined);
        throw error;
      }
    },
    status: (projectId: string) => cursors.status(projectId),
  };
}
