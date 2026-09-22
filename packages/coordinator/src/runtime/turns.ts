import type { z } from 'zod';
import { CostRules, DeferReason, effective, newId, PermissionGrant, Role, RoutingRules, type ClaimBody, type EventDraft, type FinishBody, type Lane, type TraceStepInput, type TurnKind, type Viewport } from '@agent-team/protocol';
import type { Tx } from '@agent-team/storage';
import { hashToken, newToken, sameSecret } from '../auth/secrets.ts';
import { HttpError, type Context } from '../context.ts';
import { createCosts } from '../costs/costs.ts';
import { createDecisions } from './decisions.ts';
import { buildPacket, type Packet } from './packet.ts';
import { sendBackToMerge } from './conflicts.ts';
import { moveTask } from './taskMoves.ts';
import { createSessions, STALLED_AFTER, type Resume } from './sessions.ts';
import { DEFAULT_RULES, type Notice } from './rules.ts';
import { saysNothing } from './reports.ts';
import * as scheduler from './scheduler.ts';
import { accessOf, laneOf, maxWritersOf, WORKER_FRESH_MS, type ClaimDraft, type Snapshot } from './scheduler.ts';

import { effectiveProjects } from '../repos/org.ts';
import { agentTools, turnTools, type TurnTool } from './agentTools.ts';
export const LEASE_MS = 90_000;
export { laneOf };
// What an author is told when its approved change no longer merges. Merging the base in, never rebasing: a published branch is never force-pushed.
export const RULES_SCOPE = { type: 'org', id: '' } as const, RULES_SLUG = 'default', LIMIT_BACKOFF_MS = 5 * 60_000;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const RATE_LIMITED = /rate-limit|usage-limit/;

export type ClaimRequest = z.infer<typeof ClaimBody>;
export interface Claimed { turnId: string; leaseToken: string; leaseMs: number; kind: TurnKind; agentId: string; projectId: string; taskId: string | null; taskKey: string | null; /* What the task is called, for the change a work turn opens. */ taskTitle: string | null; threadId: string | null; packet: Packet; resume: Resume | null; grants: PermissionGrant; engine: string | null; model: string | null; /* How much effort the model is asked to spend: the agent's own, else its team's. */ effort: string | null; capture: { url: string; viewport: Viewport } | null; /* A review turn: the head to look at, and which kind of reviewer looks, which names its detached worktree. */ review: { headSha: string; reviewer: string } | null; /* The external tools the seat may reach in this turn, with their tokens: held by the worker in the turn's private folder, never stored. */ tools: TurnTool[] }
// The checkout a quarantine names is one worker's copy of one project.
export const checkoutRef = (workerId: string, projectId: string) => `${workerId}:${projectId}`;
export type Outcome = z.infer<typeof FinishBody>['outcome'];

export function createTurns(context: Context) {
  const { storage, events, now } = context;
  const costs = createCosts(context);
  const sessions = createSessions(context);
  const decisions = createDecisions(context);

  // Runs at the start of every claim and on a timer. An expired lease means the outcome is unknown:
  // the turn becomes uncertain, is never retried, and the smallest object it could have changed is quarantined.
  async function expire(tx: Tx) {
    const lost = await tx.selectFrom('turns').selectAll().where('state', '=', 'running').where('lease_until', '<', now()).execute();
    const drafts = [];
    for (const turn of lost) {
      await tx.updateTable('turns').set({ state: 'uncertain', stop_reason: 'lease-expired', finished_at: now() }).where('id', '=', turn.id).execute();
      await tx.updateTable('work_items').set({ state: 'expired' }).where('id', '=', turn.work_item_id).execute();
      if (turn.kind === 'deliver' && turn.task_id) await tx.updateTable('merge_queue').set({ state: 'uncertain', reason: 'Lease expired during delivery; reconcile against the change before anything else merges', finished_at: now() }).where('task_id', '=', turn.task_id).where('state', 'in', ['queued', 'running']).execute();
      if (turn.kind === 'capture') await tx.updateTable('snapshots').set({ state: 'failed', error: 'The worker stopped answering during the capture' }).where('work_item_id', '=', turn.work_item_id).where('state', '=', 'requested').execute();
      // A verdict whose turn never reported the head it verified is never counted.
      if (turn.kind === 'review') await tx.updateTable('approvals').set({ state: 'stale' }).where('turn_id', '=', turn.id).where('state', '=', 'pending-verification').execute();
      // Lost while it changed the checkout's shared git state: the checkout itself is unknown, whatever kind of turn it was.
      if (turn.git_admin) await tx.insertInto('quarantines').values({ id: newId(now()), scope: 'checkout', ref_id: checkoutRef(turn.worker_id, turn.project_id), turn_id: turn.id, reason: 'Lease expired during a git-admin operation; inspect the primary checkout on this worker before releasing', opened_at: now(), released_by: null, released_at: null }).execute();
      // A delivery is run again rather than put in front of a person (the gate finds out from the host whether it merged), so it sets nothing aside.
      if (turn.access === 'write' && turn.task_id && turn.kind !== 'deliver') {
        await tx.insertInto('quarantines').values({ id: newId(now()), scope: 'task', ref_id: turn.task_id, turn_id: turn.id, reason: 'Lease expired; inspect the worktree before releasing', opened_at: now(), released_by: null, released_at: null }).execute();
        drafts.push(...await moveTask(tx, turn.task_id, 'quarantined', { now: now(), actor: { actorKind: 'system', agentId: turn.agent_id, turnId: turn.id }, payload: { reason: 'lease-expired' } }));
      }
      drafts.push({ type: 'turn.uncertain', actorKind: 'system' as const, projectId: turn.project_id, agentId: turn.agent_id, taskId: turn.task_id, turnId: turn.id, payload: { reason: 'lease-expired' } });
    }
    return drafts.length ? events.append(tx, drafts) : [];
  }

  // Roles stack, the project ceiling caps. The result is frozen on the turn, so editing a role never changes a running turn.
  async function grantsFor(tx: Tx, agentId: string, projectId: string): Promise<PermissionGrant> {
    const slugs = (await tx.selectFrom('agent_roles').select('role_slug').where('agent_id', '=', agentId).execute()).map(row => row.role_slug);
    const docs = slugs.length ? await tx.selectFrom('versioned_docs').select('doc').where('kind', '=', 'role').where('slug', 'in', slugs).execute() : [];
    const roles = docs.map(row => Role.parse(JSON.parse(row.doc)).permissions);
    const project = await tx.selectFrom('projects').select('manifest').where('id', '=', projectId).executeTakeFirstOrThrow();
    const ceiling = PermissionGrant.safeParse((JSON.parse(project.manifest) as { ceiling?: unknown }).ceiling);
    return ceiling.success ? effective(roles, ceiling.data) : effective(roles);
  }

  // Everything the pure scheduler needs to decide, read in the claim's own transaction.
  async function snapshotFor(tx: Tx, claim: ClaimDraft): Promise<Snapshot & { reasons: [string, string | null][] }> {
    const lanes = (Object.entries(claim.free) as [Lane, number | undefined][]).filter(([, free]) => (free ?? 0) > 0).map(([lane]) => lane);
    const rows = await tx.selectFrom('work_items').select(['id', 'agent_id', 'project_id', 'kind', 'lane', 'task_id', 'priority_class', 'created_at', 'defer_reason'])
      .where('state', '=', 'queued').where('lane', 'in', lanes).where('project_id', 'in', [...claim.projects])
      .where(eb => eb.or([eb('not_before', 'is', null), eb('not_before', '<=', now())])).orderBy('priority_class').orderBy('created_at').limit(200).execute();
    const items = rows.map(row => ({ id: row.id, agentId: row.agent_id, projectId: row.project_id, kind: row.kind as TurnKind, lane: row.lane as Lane, taskId: row.task_id, priorityClass: row.priority_class, createdAt: Number(row.created_at) }));
    const agentIds = [...new Set(items.map(item => item.agentId))], taskIds = [...new Set(items.flatMap(item => item.taskId ?? []))], projectIds = [...new Set(items.map(item => item.projectId))];
    const snapshot: Snapshot & { reasons: [string, string | null][] } = { now: now(), items, agents: {}, tasks: {}, providers: {}, projects: {}, running: [], rules: DEFAULT_RULES, reasons: rows.map(row => [row.id, row.defer_reason]) };
    if (items.length === 0) return snapshot;

    const today = day(now()), month = today.slice(0, 7);
    const spent = new Map((await tx.selectFrom('cost_daily').select('agent_id').select(eb => eb.fn.sum<number>('amount_minor').as('total')).where('agent_id', 'in', agentIds).where('day', '=', today).groupBy('agent_id').execute()).map(row => [row.agent_id, Number(row.total)]));
    const last = new Map((await tx.selectFrom('turns').select('agent_id').select(eb => eb.fn.max('started_at').as('at')).where('agent_id', 'in', agentIds).groupBy('agent_id').execute()).map(row => [row.agent_id, Number(row.at)]));
    // An agent without a provider of its own runs on its team's; a team without one leaves it to the worker.
    for (const agent of await tx.selectFrom('agents').innerJoin('teams', 'teams.id', 'agents.team_id').select(['agents.id', 'agents.status', 'agents.provider_id', 'agents.model', 'agents.daily_cap_minor', 'teams.default_provider_id', 'teams.default_model']).where('agents.id', 'in', agentIds).execute())
      snapshot.agents[agent.id] = { status: agent.status, providerId: agent.provider_id ?? agent.default_provider_id, model: agent.provider_id ? agent.model : agent.model ?? (agent.default_provider_id ? agent.default_model : null), dailyCapMinor: agent.daily_cap_minor, spentTodayMinor: spent.get(agent.id) ?? 0, lastStartedAt: last.get(agent.id) ?? 0 };

    const running = await tx.selectFrom('turns').innerJoin('agents', 'agents.id', 'turns.agent_id').select(['turns.agent_id', 'turns.lane', 'turns.task_id', 'turns.access', 'turns.kind', 'turns.project_id', 'turns.provider_id', 'agents.provider_id as seat_provider_id']).where('turns.state', '=', 'running').execute();
    snapshot.running = running.map(turn => ({ agentId: turn.agent_id, lane: turn.lane as Lane }));

    if (taskIds.length) {
      const quarantined = new Set((await tx.selectFrom('quarantines').select('ref_id').where('scope', '=', 'task').where('ref_id', 'in', taskIds).where('released_at', 'is', null).execute()).map(row => row.ref_id));
      const fresh = new Set((await tx.selectFrom('workers').select('id').where('last_seen_at', '>', now() - WORKER_FRESH_MS).execute()).map(row => row.id));
      // Newest first: the first write turn seen per task names the holder of its worktree, the first routed work turn its sticky route.
      const written = await tx.selectFrom('turns').select(['task_id', 'kind', 'worker_id', 'provider_id', 'model']).where('task_id', 'in', taskIds).where('access', '=', 'write').orderBy('started_at', 'desc').orderBy('id', 'desc').execute();
      for (const task of await tx.selectFrom('tasks').select(['id', 'state', 'tag', 'difficulty', 'blocked_reason']).where('id', 'in', taskIds).execute()) {
        const mine = written.filter(turn => turn.task_id === task.id), holder = mine[0]?.worker_id, routed = mine.find(turn => turn.kind === 'work' && turn.provider_id !== null);
        // A task held in the backlog (an idea waiting for its owner, say) is not to be worked on, whatever queued it.
        snapshot.tasks[task.id] = { state: task.state === 'backlog' && task.blocked_reason ? 'blocked' : task.state, tags: task.tag ? [task.tag] : [], difficulty: task.difficulty, quarantined: quarantined.has(task.id), writerRunning: running.some(turn => turn.task_id === task.id && turn.access === 'write'), holder: holder && fresh.has(holder) ? holder : null, sticky: routed ? { providerId: routed.provider_id, model: routed.model } : null };
      }
    }

    for (const provider of await tx.selectFrom('providers').selectAll().execute()) {
      const limits = JSON.parse(provider.limits) as { maxConcurrentTurns?: number; windowTokens?: number; windowMs?: number };
      let windowPct: number | null = null;
      if (limits.windowTokens) {
        const used = await tx.selectFrom('cost_entries').select(eb => [eb.fn.sum<number>('tokens_in').as('tokens_in'), eb.fn.sum<number>('tokens_out').as('tokens_out')]).where('provider_id', '=', provider.id).where('at', '>=', now() - (limits.windowMs ?? 5 * 3600_000)).executeTakeFirst();
        windowPct = (Number(used?.tokens_in ?? 0) + Number(used?.tokens_out ?? 0)) / limits.windowTokens * 100;
      }
      snapshot.providers[provider.id] = { id: provider.id, name: provider.name, status: provider.status, models: JSON.parse(provider.models) as string[], limitedUntil: provider.limited_until === null ? null : Number(provider.limited_until), running: running.filter(turn => (turn.provider_id ?? turn.seat_provider_id) === provider.id).length, maxConcurrent: limits.maxConcurrentTurns ?? null, windowPct };
    }

    // A project budget covers the project and its sub-projects; the org budget covers everything. The fullest one governs.
    const budgets = await tx.selectFrom('budgets').selectAll().where('period', '=', 'month').execute();
    const monthly = budgets.length ? await tx.selectFrom('cost_daily').innerJoin('projects', 'projects.id', 'cost_daily.project_id').select(['cost_daily.project_id', 'projects.parent_id']).select(eb => eb.fn.sum<number>('cost_daily.amount_minor').as('total')).where('cost_daily.day', '>=', `${month}-01`).where('cost_daily.day', '<=', `${month}-31`).groupBy(['cost_daily.project_id', 'projects.parent_id']).execute() : [];
    const busyDelivery = new Set((await tx.selectFrom('merge_queue').select('project_id').where('project_id', 'in', projectIds).where('state', 'in', ['running', 'uncertain']).execute()).map(row => row.project_id));
    const unknownCheckouts = new Set((await tx.selectFrom('quarantines').select('ref_id').where('scope', '=', 'checkout').where('ref_id', 'in', projectIds.map(id => checkoutRef(claim.workerId, id))).where('released_at', 'is', null).execute()).map(row => row.ref_id));
    for (const project of await tx.selectFrom('projects').select(['id', 'parent_id', 'status', 'manifest']).where('id', 'in', projectIds).execute()) {
      let governing: { pct: number; budget: (typeof budgets)[number] } | null = null;
      for (const budget of budgets) {
        if (budget.scope === 'project' ? budget.scope_id !== project.id && budget.scope_id !== project.parent_id : budget.scope !== 'org') continue;
        const total = monthly.filter(row => budget.scope === 'org' || row.project_id === budget.scope_id || row.parent_id === budget.scope_id).reduce((sum, row) => sum + Number(row.total), 0);
        const pct = budget.amount_minor > 0 ? total / budget.amount_minor * 100 : 100;
        if (!governing || pct > governing.pct) governing = { pct, budget };
      }
      snapshot.projects[project.id] = { status: project.status, budgetPct: governing?.pct ?? null, budget: governing ? { scope: governing.budget.scope, scopeId: governing.budget.scope_id } : null, warned: governing?.budget.warned_period === month, deliveryBusy: busyDelivery.has(project.id), writersRunning: running.filter(turn => turn.project_id === project.id && turn.access === 'write' && turn.kind !== 'deliver').length, maxWriters: maxWritersOf(JSON.parse(project.manifest)), checkoutQuarantined: unknownCheckouts.has(checkoutRef(claim.workerId, project.id)) };
    }

    const docs = await tx.selectFrom('versioned_docs').select(['kind', 'doc']).where('kind', 'in', ['cost_rules', 'routing_rules']).where('scope_type', '=', RULES_SCOPE.type).where('scope_id', '=', RULES_SCOPE.id).where('slug', '=', RULES_SLUG).execute();
    const doc = (kind: string) => { const found = docs.find(row => row.kind === kind); return found ? JSON.parse(found.doc) as unknown : {}; };
    snapshot.rules = { cost: CostRules.parse(doc('cost_rules')), routing: RoutingRules.parse(doc('routing_rules')) };
    return snapshot;
  }

  // A budget warns once per period: the message goes to the discussion, the event to the log, the mark on the budget.
  // An agent that moved to the fallback provider is announced the same way, once a day, when a turn of its actually starts there.
  async function notify(tx: Tx, notices: Notice[], snapshot: Snapshot, started: { agentId: string; providerId: string | null } | null) {
    const drafts = [], today = day(now()), month = today.slice(0, 7);
    const discussionOf = async (projectId: string) => {
      const home = await tx.selectFrom('projects').select(['id', 'parent_id']).where('id', '=', projectId).executeTakeFirstOrThrow();
      return tx.selectFrom('threads').select('id').where('project_id', 'in', [home.id, ...(home.parent_id ? [home.parent_id] : [])]).where('kind', '=', 'discussion').orderBy('created_at', 'desc').executeTakeFirst();
    };
    for (const notice of notices) {
      if (notice.type === 'cap.fallback') {
        if (started?.agentId !== notice.agentId || started.providerId !== notice.providerId) continue;
        const marked = await tx.updateTable('agents').set({ fallback_noticed_day: today }).where('id', '=', notice.agentId).where(eb => eb.or([eb('fallback_noticed_day', 'is', null), eb('fallback_noticed_day', '!=', today)])).executeTakeFirst();
        if (Number(marked.numUpdatedRows) === 0) continue;
        const agent = await tx.selectFrom('agents').select('name').where('id', '=', notice.agentId).executeTakeFirstOrThrow(), provider = snapshot.providers[notice.providerId];
        const thread = await discussionOf(notice.projectId);
        if (thread) await tx.insertInto('messages').values({ id: newId(now()), thread_id: thread.id, author_kind: 'system', author_id: null, kind: 'system', body: `${agent.name} has reached today’s spending cap and works on ${provider?.name ?? 'the fallback provider'} for the rest of the day.`, payload: JSON.stringify({ capFallback: { agentId: notice.agentId, providerId: notice.providerId } }), created_at: now() }).execute();
        drafts.push({ type: 'cap.fallback', actorKind: 'system' as const, projectId: notice.projectId, agentId: notice.agentId, threadId: thread?.id ?? null, payload: { providerId: notice.providerId, day: today } });
        if (thread) drafts.push({ type: 'message.posted', actorKind: 'system' as const, projectId: notice.projectId, threadId: thread.id, payload: { kind: 'system' } });
        continue;
      }
      for (const project of Object.values(snapshot.projects)) if (project.budget?.scope === notice.scope && project.budget.scopeId === notice.scopeId) project.warned = true;
      const marked = await tx.updateTable('budgets').set({ warned_period: month }).where('scope', '=', notice.scope).where('scope_id', '=', notice.scopeId).where('period', '=', 'month').where(eb => eb.or([eb('warned_period', 'is', null), eb('warned_period', '!=', month)])).executeTakeFirst();
      if (Number(marked.numUpdatedRows) === 0) continue;
      const thread = await discussionOf(notice.projectId);
      if (thread) await tx.insertInto('messages').values({ id: newId(now()), thread_id: thread.id, author_kind: 'system', author_id: null, kind: 'system', body: `Spend has reached ${notice.percent} % of the ${notice.scope === 'org' ? 'organization' : 'project'} budget for ${month}. At 100 % only replies to people and work that unblocks others will run.`, payload: JSON.stringify({ budget: { scope: notice.scope, scopeId: notice.scopeId, percent: notice.percent } }), created_at: now() }).execute();
      drafts.push({ type: 'budget.threshold', actorKind: 'system' as const, projectId: notice.projectId, threadId: thread?.id ?? null, payload: { scope: notice.scope, scopeId: notice.scopeId, percent: notice.percent, threshold: notice.threshold } });
    }
    return drafts.length ? events.append(tx, drafts) : [];
  }

  async function leased(tx: Tx, turnId: string, workerId: string, leaseToken: string) {
    const turn = await tx.selectFrom('turns').selectAll().where('id', '=', turnId).executeTakeFirst();
    if (turn?.state !== 'running' || turn.worker_id !== workerId || Number(turn.lease_until) < now() || !sameSecret(turn.lease_token_hash, hashToken(leaseToken))) throw new HttpError(409, 'lease', 'Lease lost or invalid');
    return turn;
  }

  // Whose turn this was, by the lease it was claimed with, whether or not that lease has run out since.
  async function claimedBy(tx: Tx, turnId: string, workerId: string, leaseToken: string) {
    const turn = await tx.selectFrom('turns').selectAll().where('id', '=', turnId).executeTakeFirst();
    return turn && turn.worker_id === workerId && sameSecret(turn.lease_token_hash, hashToken(leaseToken)) ? turn : null;
  }

  // A task is sized once, before its first work turn: its route sticks from there, so a later read would change nothing.
  async function sizeUp(taskId: string) {
    if (!decisions.on()) return null;
    const task = await storage.db.selectFrom('tasks').select(['title', 'brief', 'difficulty']).where('id', '=', taskId).executeTakeFirst();
    if (!task || task.difficulty !== null) return null;
    if (await storage.db.selectFrom('machine_decisions').select('id').where('task_id', '=', taskId).where('purpose', '=', 'difficulty').executeTakeFirst()) return null;
    return decisions.difficulty(task);
  }

  return {
    claimedBy: (turnId: string, workerId: string, leaseToken: string) => storage.transaction(tx => claimedBy(tx, turnId, workerId, leaseToken)),
    async enqueue(input: { agentId: string; projectId: string; kind: TurnKind; taskId?: string | null; threadId?: string | null; dedupeKey?: string; causeEventId?: string; notBefore?: number; priorityClass?: number; prepare?: (tx: Tx, workItemId: string) => Promise<void> }): Promise<string | null> {
      const id = newId(now());
      // Before the transaction, since it goes over the network: the decision model's first read of what a triage is about, and how
      // hard a task looks before its first work turn is routed. Not asked when the same wake is already queued.
      const taken = input.dedupeKey ? await storage.db.selectFrom('work_items').select('id').where('dedupe_key', '=', input.dedupeKey).where('state', 'in', ['queued', 'leased']).executeTakeFirst() : undefined;
      const first = !taken && input.kind === 'triage' && input.threadId ? await decisions.triage(input.projectId, input.threadId) : null;
      const sized = !taken && input.kind === 'work' && input.taskId ? await sizeUp(input.taskId) : null;
      const published = await storage.transaction(async tx => {
        // An agent works for its own team's projects and for those it is on loan to. Work for a paused project is kept and waits at the claim.
        if (!(await effectiveProjects(tx, input.agentId, { whilePaused: true })).includes(input.projectId)) return null;
        const live = input.dedupeKey ? await tx.selectFrom('work_items').select('dedupe_key').where('dedupe_key', '=', input.dedupeKey).where('state', 'in', ['queued', 'leased']).execute() : [];
        const task = input.taskId ? await tx.selectFrom('tasks').select(['state', 'assignee_agent_id']).where('id', '=', input.taskId).executeTakeFirst() : undefined;
        const draft = scheduler.enqueue({ kind: input.kind, agentId: input.agentId, dedupeKey: input.dedupeKey }, { liveDedupeKeys: new Set(live.map(row => row.dedupe_key ?? '')), task: task ? { state: task.state, assigneeAgentId: task.assignee_agent_id } : null });
        if (!draft) return null;
        // What the model read as urgent is sorted ahead of ordinary triage, never ahead of a reply to a person.
        const priorityClass = input.priorityClass ?? (first?.urgent ? Math.min(draft.priorityClass, 2) : draft.priorityClass);
        await tx.insertInto('work_items').values({ id, agent_id: input.agentId, project_id: input.projectId, kind: input.kind, lane: draft.lane, task_id: input.taskId ?? null, thread_id: input.threadId ?? null, priority_class: priorityClass, state: 'queued', defer_reason: null, not_before: input.notBefore ?? null, dedupe_key: input.dedupeKey ?? null, cause_event_id: input.causeEventId ?? null, created_at: now() }).execute();
        // What the turn needs beyond the item itself is written with it, so a claim never sees one without the other.
        await input.prepare?.(tx, id);
        const reads = [];
        if (first) reads.push((await decisions.record(tx, first.read, { projectId: input.projectId, threadId: input.threadId ?? null, applied: first.urgent && input.priorityClass === undefined })).event);
        if (sized) {
          if (sized.difficulty) await tx.updateTable('tasks').set({ difficulty: sized.difficulty }).where('id', '=', input.taskId!).where('difficulty', 'is', null).execute();
          reads.push((await decisions.record(tx, sized.read, { projectId: input.projectId, taskId: input.taskId ?? null, applied: sized.difficulty !== null })).event);
        }
        // Having work again ends the idle period, so the next one is announced.
        await tx.updateTable('agents').set({ idle_at: null }).where('id', '=', input.agentId).where('idle_at', 'is not', null).execute();
        return events.append(tx, [{ type: 'work_item.queued', actorKind: 'system', projectId: input.projectId, agentId: input.agentId, taskId: input.taskId ?? null, payload: { workItemId: id, kind: input.kind } }, ...reads]);
      });
      if (!published) return null;
      events.published(published);
      return id;
    },

    // One transaction: expire, gate, pick, insert the turn, lease the item.
    async claim(request: ClaimRequest): Promise<Claimed | null> {
      const result = await storage.transaction(async tx => {
        await storage.claimLock(tx);
        const expired = [...await expire(tx)];
        const lanes = (Object.entries(request.free) as [Lane, number | undefined][]).filter(([, free]) => (free ?? 0) > 0).map(([lane]) => lane);
        if (lanes.length === 0 || request.projects.length === 0) return { expired, claimed: null };
        const snapshot = await snapshotFor(tx, request);
        const stored = new Map(snapshot.reasons);
        for (;;) {
          const { picked, deferrals, notices } = scheduler.pick(snapshot, request);
          // Every refusal is written down, once per change, so the Workload page can say why an item waits.
          for (const deferral of deferrals.filter(row => row.reason === 'task-closed')) { await tx.updateTable('work_items').set({ state: 'done', defer_reason: 'task-closed' }).where('id', '=', deferral.id).execute(); snapshot.items = snapshot.items.filter(other => other.id !== deferral.id); stored.set(deferral.id, 'task-closed'); }
          for (const deferral of deferrals) if (stored.get(deferral.id) !== deferral.reason) { await tx.updateTable('work_items').set({ defer_reason: deferral.reason }).where('id', '=', deferral.id).execute(); stored.set(deferral.id, deferral.reason); }
          expired.push(...await notify(tx, notices, snapshot, picked ? { agentId: picked.item.agentId, providerId: picked.route.providerId } : null));
          if (!picked) return { expired, claimed: null };
          const { item, route } = picked, kind = item.kind, access = accessOf(kind);
          const wanted = kind === 'capture' ? await tx.selectFrom('snapshots').select(['url', 'viewport']).where('work_item_id', '=', item.id).where('state', '=', 'requested').executeTakeFirst() : undefined;
          if (kind === 'capture' && !wanted) {
            await tx.updateTable('work_items').set({ state: 'done', defer_reason: 'no-request' }).where('id', '=', item.id).execute();
            snapshot.items = snapshot.items.filter(other => other.id !== item.id);
            continue;
          }
          const moved: EventDraft[] = [];
          if (kind === 'deliver') {
            // Exactly one entry runs. Earlier versions could queue the same task more than once; the extra entries are closed here, not started.
            const entries = await tx.selectFrom('merge_queue').select('id').where('task_id', '=', item.taskId).where('state', '=', 'queued').orderBy('created_at', 'desc').execute();
            if (entries.length > 1) await tx.updateTable('merge_queue').set({ state: 'blocked', reason: 'Queued more than once; the newest entry runs', finished_at: now() }).where('id', 'in', entries.slice(1).map(entry => entry.id)).execute();
            if (entries[0]) await tx.updateTable('merge_queue').set({ state: 'running' }).where('id', '=', entries[0].id).execute();
            if (item.taskId) moved.push(...await moveTask(tx, item.taskId, 'merging', { now: now(), actor: { actorKind: 'system', agentId: item.agentId } }));
          }
          const turnId = newId(now()), leaseToken = newToken();
          const grants = await grantsFor(tx, item.agentId, item.projectId);
          // Provider and model come from the agent unless a rule routed the turn elsewhere; the route is frozen on the turn.
          const effortOf = await tx.selectFrom('agents').innerJoin('teams', 'teams.id', 'agents.team_id').select(['agents.effort', 'teams.default_effort']).where('agents.id', '=', item.agentId).executeTakeFirst();
          const engine = route.providerId ? (await tx.selectFrom('providers').select('engine').where('id', '=', route.providerId).executeTakeFirst())?.engine ?? null : null;
          const row = await tx.selectFrom('work_items').select(['thread_id', 'dedupe_key']).where('id', '=', item.id).executeTakeFirstOrThrow();
          const subject = item.taskId ? await tx.selectFrom('tasks').select(['key', 'title', 'head_sha']).where('id', '=', item.taskId).executeTakeFirst() : undefined, taskKey = subject?.key ?? null;
          // `review:<task>:<kind>:<head>` is how a review is asked for; the head itself is read from the task, which is what the verdict is checked against.
          const review = kind === 'review' && subject?.head_sha ? { headSha: subject.head_sha, reviewer: /^review:[^:]+:([a-z]+):/.exec(row.dedupe_key ?? '')?.[1] ?? 'reviewer' } : null;
          await tx.insertInto('turns').values({ id: turnId, work_item_id: item.id, agent_id: item.agentId, project_id: item.projectId, task_id: item.taskId, kind, lane: item.lane, access, state: 'running', stop_reason: null, worker_id: request.workerId, lease_token_hash: hashToken(leaseToken), lease_until: now() + LEASE_MS, grants: JSON.stringify(grants), summary: null, tokens_in: 0, tokens_out: 0, cost_minor: 0, started_at: now(), finished_at: null, provider_id: route.providerId, model: route.model }).execute();
          await tx.updateTable('work_items').set({ state: 'leased', defer_reason: null }).where('id', '=', item.id).execute();
          if (kind === 'work' && item.taskId) moved.push(...await moveTask(tx, item.taskId, 'in_progress', { from: ['backlog', 'assigned'], now: now(), actor: { actorKind: 'system', agentId: item.agentId, turnId } }));
          // A work turn resumes its (agent, task) session or starts a new one; everything else is a fresh packet.
          const session = await sessions.open(tx, { turnId, workItemId: item.id, kind, agentId: item.agentId, projectId: item.projectId, taskId: item.taskId, workerId: request.workerId, providerId: route.providerId, model: route.model, engine });
          // Frozen with the grants: the tools the seat's roles allow now. The tokens are read from the platform's keys, never from the packet.
          const tools = ['deliver', 'capture', 'publish'].includes(kind) ? [] : turnTools(await agentTools(tx, item.agentId, item.projectId), name => context.secrets.get(name) ?? context.env[name] ?? null);
          const started = await events.append(tx, [{ type: 'turn.started', actorKind: 'worker', projectId: item.projectId, agentId: item.agentId, taskId: item.taskId, turnId, payload: { kind, workerId: request.workerId, providerId: route.providerId } }, ...moved]);
          return { expired: [...expired, ...session.published, ...started], claimed: { turnId, leaseToken, leaseMs: LEASE_MS, kind, agentId: item.agentId, projectId: item.projectId, taskId: item.taskId, taskKey, taskTitle: subject?.title ?? null, threadId: row.thread_id, grants, engine, model: route.model, effort: effortOf?.effort ?? effortOf?.default_effort ?? null, capture: wanted ? { url: wanted.url, viewport: wanted.viewport as Viewport } : null, review, tools, resume: session.resume, packet: session.packet ?? await buildPacket(tx, { kind, agentId: item.agentId, projectId: item.projectId, taskId: item.taskId, threadId: row.thread_id }) } satisfies Claimed };
        }
      });
      events.published(result.expired);
      return result.claimed;
    },

    async heartbeat(turnId: string, workerId: string, leaseToken: string) {
      await storage.transaction(async tx => {
        await leased(tx, turnId, workerId, leaseToken);
        await tx.updateTable('turns').set({ lease_until: now() + LEASE_MS }).where('id', '=', turnId).execute();
      });
    },

    // The worker says when it starts and when it has finished changing a checkout's shared git state; expiry reads the mark.
    async gitAdmin(turnId: string, workerId: string, leaseToken: string, state: 'begin' | 'end') {
      await storage.transaction(async tx => {
        const turn = await leased(tx, turnId, workerId, leaseToken);
        await tx.updateTable('turns').set({ git_admin: state === 'begin' ? checkoutRef(turn.worker_id, turn.project_id) : null }).where('id', '=', turnId).execute();
      });
    },

    async steps(turnId: string, workerId: string, leaseToken: string, steps: TraceStepInput[]) {
      const published = await storage.transaction(async tx => {
        const turn = await leased(tx, turnId, workerId, leaseToken);
        for (const step of steps) await tx.insertInto('trace_steps').values({ turn_id: turnId, seq: step.seq, at: now(), kind: step.kind, title: step.title.slice(0, 160), detail: step.detail?.slice(0, 80) ?? null, status: step.status, artifact_id: null }).onConflict(oc => oc.columns(['turn_id', 'seq']).doNothing()).execute();
        const last = steps.at(-1);
        if (last) await tx.updateTable('agents').set({ doing: last.title.slice(0, 80) }).where('id', '=', turn.agent_id).execute();
        // One log entry per batch, carrying the range; the rows themselves live in trace_steps.
        return steps.length ? events.append(tx, [{ type: 'turn.steps', category: 'trace', actorKind: 'worker', projectId: turn.project_id, agentId: turn.agent_id, turnId, payload: { from: steps[0]!.seq, to: last!.seq, doing: last!.title.slice(0, 80) } }]) : [];
      });
      events.published(published);
    },

    async finish(turnId: string, workerId: string, leaseToken: string, outcome: Outcome) {
      let reviewTaskId: string | null = null, requeue: { agentId: string; projectId: string; taskId: string } | null = null, stalledTask: { projectId: string; taskId: string; agentId: string; reason?: string } | null = null;
      const published = await storage.transaction(async tx => {
        const turn = await leased(tx, turnId, workerId, leaseToken);
        if (turn.kind === 'work' && turn.task_id && outcome.state === 'completed' && (await tx.selectFrom('tasks').select('state').where('id', '=', turn.task_id).executeTakeFirst())?.state === 'in_review') reviewTaskId = turn.task_id;
        // The report the agent wrote during the turn is the turn's log entry and no engine summary erases it — not even a generic one.
// An engine that reports through its final summary (sessions decides what that is worth) fills only a turn that has nothing yet.
        await tx.updateTable('turns').set({ state: outcome.state, stop_reason: outcome.stopReason ?? null, summary: turn.summary?.trim() ? turn.summary : (outcome.summary?.trim() && !saysNothing(outcome.summary) ? outcome.summary.slice(0, 2000) : null), tokens_in: outcome.tokensIn ?? 0, tokens_out: outcome.tokensOut ?? 0, cost_minor: outcome.costMinor ?? 0, finished_at: now() }).where('id', '=', turnId).execute();
        // Sessions decide the two continuations that happen on their own: a lost resume and a turn without a report.
        const after = await sessions.afterFinish(tx, turn, outcome);
        if (after.stalled && turn.task_id) stalledTask = { projectId: turn.project_id, taskId: turn.task_id, agentId: turn.agent_id, reason: String((after.drafts.find(draft => draft.type === 'task.stalled')?.payload as { reason?: string } | undefined)?.reason ?? '') };
        const drafts = [...after.drafts];
        const seat = await tx.selectFrom('agents').select(['provider_id', 'idle_at']).where('id', '=', turn.agent_id).executeTakeFirst();
        const providerId = turn.provider_id ?? seat?.provider_id ?? null;
        const agent = providerId ? { provider_id: providerId, kind: (await tx.selectFrom('providers').select('kind').where('id', '=', providerId).executeTakeFirst())?.kind } : undefined;
        // A usage limit is nobody's fault: the provider is limited until its reset, every item routed to it waits with that reason, and work resumes by itself.
        const limited = outcome.state === 'deferred' && RATE_LIMITED.test(outcome.stopReason ?? ''), until = limited && outcome.resetAt !== undefined && outcome.resetAt > now() ? outcome.resetAt : outcome.stopReason === 'worker-restarted' ? now() : now() + LIMIT_BACKOFF_MS;
        if (limited && providerId) {
          await tx.updateTable('providers').set({ limited_until: until, status_detail: `Usage limit reached; resumes ${new Date(until).toISOString()}` }).where('id', '=', providerId).execute();
          drafts.push({ type: 'provider.limited', actorKind: 'system' as const, projectId: turn.project_id, agentId: turn.agent_id, turnId, payload: { providerId, until } });
        }
        // Deferred work returns to the queue; nobody is at fault. Everything else closes the item.
        const reason = limited ? 'provider-limited' : DeferReason.safeParse(outcome.stopReason).data ?? 'deferred';
        await tx.updateTable('work_items').set(outcome.state === 'deferred' ? { state: 'queued', defer_reason: reason, not_before: until } : { state: 'done' }).where('id', '=', turn.work_item_id).execute();
        await tx.updateTable('agents').set({ doing: null }).where('id', '=', turn.agent_id).execute();
        // Idle is announced once per idle period: enqueue clears the mark.
        const live = await tx.selectFrom('work_items').select(eb => eb.fn.countAll<number>().as('n')).where('agent_id', '=', turn.agent_id).where('state', 'in', ['queued', 'leased']).executeTakeFirstOrThrow();
        if (scheduler.idleFires({ liveItems: Number(live.n), idleAt: seat?.idle_at === null || seat?.idle_at === undefined ? null : Number(seat.idle_at) })) {
          await tx.updateTable('agents').set({ idle_at: now() }).where('id', '=', turn.agent_id).execute();
          drafts.push({ type: 'agent.idle', actorKind: 'system' as const, projectId: turn.project_id, agentId: turn.agent_id, payload: { since: now() } });
        }
        await costs.record(tx, { turnId, agentId: turn.agent_id, projectId: turn.project_id, providerId: agent?.provider_id ?? null, billingKind: (agent?.kind as 'metered' | 'subscription' | 'local' | undefined) ?? 'metered', tokensIn: outcome.tokensIn ?? 0, tokensOut: outcome.tokensOut ?? 0, amountMinor: outcome.costMinor ?? 0 });
        if (turn.task_id && outcome.prUrl) await tx.updateTable('tasks').set({ pr_url: outcome.prUrl }).where('id', '=', turn.task_id).execute();
        // A delivery that comes back later leaves the queue as it found it.
        if (turn.kind === 'deliver' && turn.task_id && outcome.state === 'deferred') {
          // A bare line is no reason to wait by: the queue states what it knows, or nothing.
          await tx.updateTable('merge_queue').set({ state: 'queued', reason: outcome.summary?.trim() && !saysNothing(outcome.summary) ? outcome.summary.slice(0, 300) : null }).where('task_id', '=', turn.task_id).where('state', '=', 'running').execute();
          drafts.push(...await moveTask(tx, turn.task_id, 'approved', { from: ['merging'], now: now(), actor: { actorKind: 'system', agentId: turn.agent_id, turnId }, payload: { reason: 'delivery-deferred' } }));
        }
        if (turn.kind === 'deliver' && turn.task_id && outcome.delivery) {
          const merged = outcome.delivery.state === 'merged';
          await tx.updateTable('merge_queue').set({ state: merged ? 'merged' : 'blocked', reason: outcome.delivery.reason, finished_at: now() }).where('task_id', '=', turn.task_id).where('state', 'in', ['queued', 'running']).execute();
          // Not mergeable as it stands (the base moved under it): that is the author's to put right, not a person's. Once per revision; if the
          // same revision comes back unmergeable, a person is asked after all.
          const sentBack = !merged && /conflicts with the base branch/i.test(outcome.delivery.reason) ? await sendBackToMerge(tx, turn.task_id, { now: now(), approved: true, actor: { actorKind: 'system', agentId: turn.agent_id, turnId }, drafts }) : null;
          if (sentBack) requeue = sentBack;
          else drafts.push(...await moveTask(tx, turn.task_id, merged ? 'done' : 'blocked', { ...(merged ? {} : { set: { blocked_reason: outcome.delivery.reason.slice(0, 200) } }), now: now(), actor: { actorKind: 'system', agentId: turn.agent_id, turnId }, payload: { reason: merged ? 'merged' : outcome.delivery.reason.slice(0, 200) } }));
        }
        if (turn.kind === 'capture' && outcome.state !== 'deferred') {
          // A capture turn that ends without having uploaded its image has failed, whatever it says.
          const missed = await tx.selectFrom('snapshots').select(['id', 'env_id', 'viewport']).where('work_item_id', '=', turn.work_item_id).where('state', '=', 'requested').execute();
          for (const snapshot of missed) {
            const reason = (outcome.summary ?? outcome.stopReason ?? 'No image was captured').slice(0, 300);
            await tx.updateTable('snapshots').set({ state: 'failed', error: reason }).where('id', '=', snapshot.id).execute();
            await tx.updateTable('product_envs').set({ last_status: 'failed', last_latency_ms: null }).where('id', '=', snapshot.env_id).execute();
            drafts.push({ type: 'snapshot.failed', actorKind: 'worker' as const, projectId: turn.project_id, turnId, payload: { snapshotId: snapshot.id, envId: snapshot.env_id, viewport: snapshot.viewport, reason } });
          }
        }
        // Only the work itself failing sets the task aside. A review, a merge or a reply that failed says nothing about the task: a review is
        // asked for again, a merge has its own outcome, and the task stays where it was.
        if (turn.task_id && turn.kind === 'work' && !after.requeued && (outcome.state === 'failed' || outcome.state === 'timed_out')) { const reason = outcome.state === 'timed_out' ? 'The work ran out of time before it reported' : `The work stopped with an error${outcome.summary ? `: ${outcome.summary.slice(0, 120)}` : ''}`; drafts.push(...await moveTask(tx, turn.task_id, 'blocked', { unless: ['quarantined', 'done', 'canceled', 'stopped'], set: { blocked_reason: reason }, now: now(), actor: { actorKind: 'system', agentId: turn.agent_id, turnId }, payload: { reason } })); }
        return events.append(tx, [...drafts, { type: `turn.${outcome.state}`, actorKind: 'worker', projectId: turn.project_id, agentId: turn.agent_id, taskId: turn.task_id, turnId, payload: { stopReason: outcome.stopReason ?? null } }]);
      });
      events.published(published);
      // Turn after turn that changed nothing: the PM is told at once, in the task's own thread, rather than the task waiting to be noticed.
      const stalled = stalledTask as { projectId: string; taskId: string; agentId: string; reason?: string } | null;
      if (stalled) await this.bringInPm(stalled);
      const again = requeue as { agentId: string; projectId: string; taskId: string } | null;
      if (again) await this.enqueue({ agentId: again.agentId, projectId: again.projectId, kind: 'work', taskId: again.taskId, dedupeKey: `work:${again.taskId}` });
      return { reviewTaskId: reviewTaskId as string | null };
    },

    // Puts a task its owner is not moving in front of the PM, as a triage turn on the project's discussion with the facts in it.
    async bringInPm(input: { projectId: string; taskId: string; agentId: string; reason?: string }) {
      const db = storage.db;
      const project = await db.selectFrom('projects').select(['id', 'team_id', 'parent_id']).where('id', '=', input.projectId).executeTakeFirst();
      const root = project?.parent_id ? await db.selectFrom('projects').select(['id', 'team_id']).where('id', '=', project.parent_id).executeTakeFirst() : project;
      const pm = root?.team_id ? await db.selectFrom('agents').select(['id', 'name']).where('team_id', '=', root.team_id).where('is_pm', '=', true).where('status', '=', 'active').executeTakeFirst() : undefined;
      const thread = await db.selectFrom('threads').select('id').where('project_id', '=', input.projectId).where('kind', '=', 'discussion').executeTakeFirst();
      const task = await db.selectFrom('tasks').select(['key', 'title']).where('id', '=', input.taskId).executeTakeFirst();
      const owner = await db.selectFrom('agents').select('name').where('id', '=', input.agentId).executeTakeFirst();
      if (!pm || !thread || !task || pm.id === input.agentId) return false;
      const taken = await db.selectFrom('turns').select(eb => eb.fn.countAll<number>().as('n')).where('task_id', '=', input.taskId).where('agent_id', '=', input.agentId).where('kind', '=', 'work').executeTakeFirstOrThrow();
      const what = input.reason === 'many-turns' ? `has taken ${Number(taken.n)} turns on ${task.key} (${task.title}) and says there is more to do` : `has taken ${STALLED_AFTER} turns in a row on ${task.key} (${task.title}) without changing anything`;
      const body = `${owner?.name ?? 'Its owner'} ${what}. ${pm.name}: read the task's journal and thread, then decide: answer what it is stuck on, split the task, give it to someone else with task.assign, tell its owner to carry on, or raise it to the owner.`;
      const published = await storage.transaction(async tx => {
        const id = newId(now());
        await tx.insertInto('messages').values({ id, thread_id: thread.id, author_kind: 'system', author_id: null, kind: 'system', body, payload: JSON.stringify({ stalled: input.taskId }), created_at: now() }).execute();
        return events.append(tx, [{ type: 'message.posted', actorKind: 'system', projectId: input.projectId, threadId: thread.id, taskId: input.taskId, payload: { messageId: id, kind: 'system' } }]);
      });
      events.published(published);
      await this.enqueue({ agentId: pm.id, projectId: input.projectId, kind: 'triage', threadId: thread.id, dedupeKey: `stalled:${input.taskId}` });
      return true;
    },

    // For worker routes that carry more than a lease body: the caller's transaction, the same validation.
    leased,

    async sweep() { events.published(await storage.transaction(expire)); },
  };
}
export type Turns = ReturnType<typeof createTurns>;
