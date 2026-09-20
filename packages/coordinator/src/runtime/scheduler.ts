import type { DeferReason, Lane, TurnKind } from '@agent-team/protocol';
import { evaluate, type Notice, type Rules } from './rules.ts';

const BOUNDED: readonly TurnKind[] = ['capture', 'review', 'feedback', 'revise', 'conclude', 'triage', 'reply', 'retro', 'ideate'];
// 1 reply to a human, 2 unblock others, 3 owed feedback, 4 continue, 5 new work, 6 upkeep.
const CLASS: Record<TurnKind, number> = { reply: 1, conclude: 2, revise: 2, review: 3, feedback: 3, triage: 3, work: 5, publish: 4, deliver: 4, retro: 6, ideate: 6, capture: 4 };
export const AGING_MS = 30 * 60_000, AGING_FLOOR = 2, WORKER_FRESH_MS = 3 * 60_000;
export const DEFAULT_MAX_WRITERS = 1, MAX_WRITERS_LIMIT = 16;
// Raised only explicitly, in the ceiling of the project's manifest; anything else is one writer at a time.
export function maxWritersOf(manifest: unknown): number {
  const value = (manifest as { ceiling?: { maxConcurrentWriters?: unknown } } | null)?.ceiling?.maxConcurrentWriters;
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? Math.min(value, MAX_WRITERS_LIMIT) : DEFAULT_MAX_WRITERS;
}

export const laneOf = (kind: TurnKind): Lane => (kind === 'deliver' || kind === 'publish' ? 'deliver' : BOUNDED.includes(kind) ? 'bounded' : 'work');
export const accessOf = (kind: TurnKind) => (kind === 'work' || kind === 'publish' || kind === 'deliver' ? 'write' : kind === 'feedback' || kind === 'conclude' || kind === 'revise' || kind === 'capture' ? 'none' : 'read');

export interface TurnDraft { id: string; agentId: string; projectId: string; kind: TurnKind; lane: Lane; taskId: string | null; priorityClass: number; createdAt: number }
export interface RouteChoice { providerId: string | null; model: string | null }
export interface SnapAgent { status: string; providerId: string | null; model: string | null; dailyCapMinor: number | null; spentTodayMinor: number; lastStartedAt: number }
// holder: the live worker whose checkout has the task's worktree. sticky: the route the task's work already ran on.
export interface SnapTask { state: string; tags: string[]; quarantined: boolean; writerRunning: boolean; holder: string | null; sticky: RouteChoice | null }
export interface SnapProvider { id: string; name: string; status: string; models: string[]; limitedUntil: number | null; running: number; maxConcurrent: number | null; windowPct: number | null }
// budgetPct is the fullest budget that covers the project; budget names it; warned says it already warned this period.
// writersRunning counts the project's running work turns against maxWriters (default 1): worktrees do not isolate ports, databases or containers.
// checkoutQuarantined: the claiming worker's checkout of the project was left in an unknown state by a lost git-admin operation.
export interface SnapProject { status: string; budgetPct: number | null; budget: { scope: string; scopeId: string } | null; warned: boolean; deliveryBusy: boolean; writersRunning?: number; maxWriters?: number; checkoutQuarantined?: boolean }
export interface ClaimDraft { workerId: string; free: { readonly [L in Lane]?: number | undefined }; projects: readonly string[] }
export interface Snapshot { now: number; items: TurnDraft[]; agents: Record<string, SnapAgent>; tasks: Record<string, SnapTask>; providers: Record<string, SnapProvider>; projects: Record<string, SnapProject>; running: { agentId: string; lane: Lane }[]; rules: Rules; claim?: ClaimDraft }

export type Gate = { ok: true; route: RouteChoice; notices: Notice[] } | { ok: false; deferReason: DeferReason; notices: Notice[] };
export interface Picked { picked: { item: TurnDraft; route: RouteChoice } | null; deferrals: { id: string; reason: DeferReason }[]; notices: Notice[] }

// A wake trigger becomes at most one queued item: a live item with the same dedupe key absorbs it.
// Continuing a task the agent is already on outranks starting a new one.
export function enqueue(event: { kind: TurnKind; agentId: string; dedupeKey?: string | null | undefined }, snapshot: { liveDedupeKeys: ReadonlySet<string>; task?: { state: string; assigneeAgentId: string | null } | null | undefined }): { lane: Lane; priorityClass: number } | null {
  if (event.dedupeKey && snapshot.liveDedupeKeys.has(event.dedupeKey)) return null;
  const continues = event.kind === 'work' && snapshot.task?.assigneeAgentId === event.agentId && (snapshot.task.state === 'in_progress' || snapshot.task.state === 'awaiting_decision');
  return { lane: laneOf(event.kind), priorityClass: continues ? 4 : CLASS[event.kind] };
}

// Waiting raises an item one class per 30 minutes, never into the classes reserved for humans and unblocking.
export function effectiveClass(item: Pick<TurnDraft, 'priorityClass' | 'createdAt'>, now: number): number {
  if (item.priorityClass <= AGING_FLOOR) return item.priorityClass;
  return Math.max(AGING_FLOOR, item.priorityClass - Math.max(0, Math.floor((now - item.createdAt) / AGING_MS)));
}

const BLOCKED = ['blocked', 'stopped'], CLOSED = ['canceled', 'done'];

// Every reason a queued item may not start now, checked in a fixed order so the stored reason is stable.
export function gate(item: TurnDraft, snapshot: Snapshot): Gate {
  const refuse = (deferReason: DeferReason, notices: Notice[] = []): Gate => ({ ok: false, deferReason, notices });
  const agent = snapshot.agents[item.agentId], task = item.taskId ? snapshot.tasks[item.taskId] : undefined;
  if (agent?.status !== 'active') return refuse('agent-paused');
  if (task?.quarantined || task?.state === 'quarantined') return refuse('task-quarantined');
  // Work on a finished task is moot: the claim closes the item instead of letting it wait forever.
  if (item.kind === 'work' && task && CLOSED.includes(task.state)) return refuse('task-closed');
  if (item.kind === 'work' && task && BLOCKED.includes(task.state)) return refuse('task-blocked');
  if (snapshot.running.some(turn => turn.agentId === item.agentId && turn.lane === item.lane)) return refuse('lane-busy');
  if (accessOf(item.kind) === 'write' && task?.writerRunning) return refuse('writer-busy');
  // Deliveries have their own queue; every other writer shares the project's ports, databases and containers.
  const home = snapshot.projects[item.projectId];
  if (accessOf(item.kind) === 'write' && item.kind !== 'deliver' && (home?.writersRunning ?? 0) >= (home?.maxWriters ?? DEFAULT_MAX_WRITERS)) return refuse('writers-busy');
  if (item.kind === 'deliver' && snapshot.projects[item.projectId]?.deliveryBusy) return refuse('delivery-busy');
  const verdict = evaluate(item, snapshot);
  if (!verdict.allow || !verdict.route) return refuse(verdict.deferReason ?? 'deferred', verdict.notices);
  if (verdict.route.providerId !== null) {
    const provider = snapshot.providers[verdict.route.providerId];
    if (!provider || provider.status !== 'connected') return refuse('provider-unavailable', verdict.notices);
    if (provider.limitedUntil !== null && provider.limitedUntil > snapshot.now) return refuse('provider-limited', verdict.notices);
    if (provider.maxConcurrent !== null && provider.running >= provider.maxConcurrent) return refuse('provider-busy', verdict.notices);
    if (provider.windowPct !== null && provider.windowPct >= 100) return refuse('provider-window', verdict.notices);
  }
  // A write turn goes to the worker that holds the task's worktree while that worker is alive.
  // Anything that needs the repository waits while this worker's checkout of it is in an unknown state.
  if (snapshot.claim && accessOf(item.kind) !== 'none' && home?.checkoutQuarantined) return refuse('checkout-quarantined', verdict.notices);
  if (snapshot.claim && accessOf(item.kind) === 'write' && task?.holder && task.holder !== snapshot.claim.workerId) return refuse('no-worktree-holder', verdict.notices);
  return { ok: true, route: verdict.route, notices: verdict.notices };
}

// Order: effective class, then the agent that has gone longest without a turn, then age. The first item that passes
// its gate wins; everything refused before it carries its reason out.
export function pick(snapshot: Snapshot, claim: ClaimDraft): Picked {
  const scoped = { ...snapshot, claim }, deferrals: Picked['deferrals'] = [], notices: Notice[] = [];
  const order = snapshot.items.filter(item => (claim.free[item.lane] ?? 0) > 0 && claim.projects.includes(item.projectId))
    .map(item => ({ item, rank: effectiveClass(item, snapshot.now), waited: snapshot.agents[item.agentId]?.lastStartedAt ?? 0 }))
    .sort((a, b) => a.rank - b.rank || a.waited - b.waited || a.item.createdAt - b.item.createdAt || (a.item.id < b.item.id ? -1 : 1));
  for (const { item } of order) {
    const result = gate(item, scoped);
    for (const notice of result.notices) if (!notices.some(seen => JSON.stringify(seen) === JSON.stringify(notice))) notices.push(notice);
    if (result.ok) return { picked: { item, route: result.route }, deferrals, notices };
    deferrals.push({ id: item.id, reason: result.deferReason });
  }
  return { picked: null, deferrals, notices };
}

// Idle is announced once: when the agent's last live item closes, and not again until it has had work.
export const idleFires = (agent: { liveItems: number; idleAt: number | null }): boolean => agent.liveItems === 0 && agent.idleAt === null;

// A seat is working while a turn of its runs, queued while an item of its waits for one, and idle only when it has
// neither. Read from the same work items a claim picks from, so no view calls a seat idle while work is scheduled on it.
export type SeatActivity = 'working' | 'queued' | 'idle';
export const seatActivity = (seat: { running: number; queued: number }): SeatActivity => (seat.running > 0 ? 'working' : seat.queued > 0 ? 'queued' : 'idle');

export interface ThreadItem { agentId: string; kind: TurnKind; state: 'queued' | 'leased'; deferReason: string | null; createdAt: number }
export interface ThreadPending { agentId: string; kind: TurnKind; state: 'queued' | 'running'; deferReason: string | null; others: number }

// What a thread is waiting for: the turn already running on it, else the item that has waited longest, with the
// reason that item last failed its gate. A running turn has no reason to give: it is under way. `others` counts
// the teammates woken alongside it, which is how one line stays true when a whole role was asked.
export function pendingOf(items: readonly ThreadItem[]): ThreadPending | null {
  const chosen = items.find(item => item.state === 'leased') ?? [...items].sort((a, b) => a.createdAt - b.createdAt)[0];
  if (!chosen) return null;
  const others = new Set(items.filter(item => item.agentId !== chosen.agentId).map(item => item.agentId));
  return { agentId: chosen.agentId, kind: chosen.kind, state: chosen.state === 'leased' ? 'running' : 'queued', deferReason: chosen.state === 'leased' ? null : chosen.deferReason, others: others.size };
}
