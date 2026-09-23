import type { DeferReason, Lane, TurnKind } from '@agent-team/protocol';
import { modelFamily } from '../../../../adapters/engine/providers.ts';
import { evaluate, type Notice, type Rules } from './rules.ts';

const BOUNDED: readonly TurnKind[] = ['capture', 'review', 'feedback', 'revise', 'conclude', 'triage', 'reply', 'retro', 'ideate', 'remember'];
// 1 reply to a human, 2 unblock others, 3 owed feedback, 4 continue, 5 new work, 6 upkeep.
const CLASS: Record<TurnKind, number> = { reply: 1, conclude: 2, revise: 2, review: 3, feedback: 3, triage: 3, work: 5, publish: 4, deliver: 4, retro: 6, ideate: 6, capture: 4, remember: 6 };
export const STICKY_FALLBACK_MS = 15 * 60_000, SPILL_AT_PCT = 90;
export const AGING_MS = 30 * 60_000, AGING_FLOOR = 2, WORKER_FRESH_MS = 3 * 60_000;
export const DEFAULT_MAX_WRITERS = 1, MAX_WRITERS_LIMIT = 16;
// Raised only explicitly, in the ceiling of the project's manifest; anything else is one writer at a time.
export function maxWritersOf(manifest: unknown): number {
  const value = (manifest as { ceiling?: { maxConcurrentWriters?: unknown } } | null)?.ceiling?.maxConcurrentWriters;
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? Math.min(value, MAX_WRITERS_LIMIT) : DEFAULT_MAX_WRITERS;
}

export const laneOf = (kind: TurnKind): Lane => (kind === 'deliver' || kind === 'publish' ? 'deliver' : BOUNDED.includes(kind) ? 'bounded' : 'work');
export const accessOf = (kind: TurnKind) => (kind === 'work' || kind === 'publish' || kind === 'deliver' ? 'write' : kind === 'feedback' || kind === 'conclude' || kind === 'revise' || kind === 'capture' || kind === 'remember' ? 'none' : 'read');

export interface TurnDraft { id: string; agentId: string; projectId: string; kind: TurnKind; lane: Lane; taskId: string | null; priorityClass: number; createdAt: number }
export interface RouteChoice { providerId: string | null; model: string | null }
export interface SnapAgent { status: string; providerId: string | null; model: string | null; dailyCapMinor: number | null; spentTodayMinor: number; lastStartedAt: number }
// holder: the live worker whose checkout has the task's worktree. sticky: the route the task's work already ran on.
// difficulty: how hard the task looked to the decision model, when one read it; a routing rule may filter on it.
export interface SnapTask { state: string; tags: string[]; difficulty: string | null; quarantined: boolean; writerRunning: boolean; holder: string | null; sticky: RouteChoice | null }
// `fallbacks`: where its work goes, in order, when it cannot take it; a model named there, else the same model where the fallback has it, else its first.
export interface SnapProvider { id: string; name: string; status: string; engine?: string; fallbacks?: { providerId: string; model: string | null }[]; models: string[]; limitedUntil: number | null; running: number; maxConcurrent: number | null; windowPct: number | null }
// budgetPct is the fullest budget that covers the project; budget names it; warned says it already warned this period.
// writersRunning counts the project's running work turns against maxWriters (default 1): worktrees do not isolate ports, databases or containers.
// checkoutQuarantined: the claiming worker's checkout of the project was left in an unknown state by a lost git-admin operation.
export interface SnapProject { status: string; budgetPct: number | null; budget: { scope: string; scopeId: string } | null; warned: boolean; deliveryBusy: boolean; writersRunning?: number; maxWriters?: number; checkoutQuarantined?: boolean }
// `ready` is what the worker said it can run; a worker that says nothing is not held to it.
export interface ClaimDraft { workerId: string; free: { readonly [L in Lane]?: number | undefined }; projects: readonly string[]; ready?: { engines: readonly string[] } | undefined }
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

const MODELLESS: readonly TurnKind[] = ['deliver', 'publish', 'capture'];

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
  // A merge, a publish and a page capture run no model: they take no slot on a provider, wait for no usage limit and spend no budget,
  // whoever's seat they are shown under. Holding them behind the team's model turns kept finished work from merging.
  const verdict = MODELLESS.includes(item.kind) ? { allow: true, route: { providerId: null, model: null }, notices: [] } : evaluate(item, snapshot);
  if (!verdict.allow || !verdict.route) return refuse(verdict.deferReason ?? 'deferred', verdict.notices);
  let route = verdict.route;
  if (route.providerId !== null) {
    const provider = snapshot.providers[route.providerId], reason = unable(snapshot, route.providerId);
    if (reason) {
      // A provider that cannot take the work hands it to its first fallback that can, unless it is only busy. Work already under way on
      // a task moves only after it has waited a while: moving it means starting its session again from the packet.
      const sticky = item.kind === 'work' && task?.sticky?.providerId === route.providerId;
      const next = reason !== 'provider-busy' && (!sticky || snapshot.now - item.createdAt >= STICKY_FALLBACK_MS) ? provider?.fallbacks?.find(fallback => fallback.providerId !== route.providerId && unable(snapshot, fallback.providerId) === null) : undefined;
      if (!next) return refuse(reason, verdict.notices);
      route = onto(snapshot, next, route.model);
    } else if ((provider?.windowPct ?? 0) >= SPILL_AT_PCT && item.priorityClass >= 5 && !(item.kind === 'work' && task?.sticky?.providerId === route.providerId)) {
      // A window nearly used up is kept for the work already under way: new and background work goes to a fallback that has room.
      const next = provider?.fallbacks?.find(fallback => fallback.providerId !== route.providerId && unable(snapshot, fallback.providerId) === null && (snapshot.providers[fallback.providerId]?.windowPct ?? 0) < SPILL_AT_PCT);
      if (next) route = onto(snapshot, next, route.model);
    }
  }
  // A review runs on another family of model than the work it checks, wherever one is connected: checkers of one family share blind spots.
  if (item.kind === 'review' && task?.sticky?.model && route.providerId !== null && modelFamily(route.model) !== null && modelFamily(route.model) === modelFamily(task.sticky.model)) {
    const author = modelFamily(task.sticky.model), from = snapshot.providers[route.providerId];
    const candidates = [...(from?.fallbacks ?? []).map(fallback => fallback.providerId), ...Object.keys(snapshot.providers)].filter((id, index, all) => all.indexOf(id) === index && id !== route.providerId);
    for (const id of candidates) {
      if (unable(snapshot, id) !== null) continue;
      const model = snapshot.providers[id]!.models.find(name => modelFamily(name) !== null && modelFamily(name) !== author);
      if (model) { route = { providerId: id, model }; break; }
    }
  }
  // A write turn goes to the worker that holds the task's worktree while that worker is alive.
  // Anything that needs the repository waits while this worker's checkout of it is in an unknown state.
  if (snapshot.claim && accessOf(item.kind) !== 'none' && home?.checkoutQuarantined) return refuse('checkout-quarantined', verdict.notices);
  if (snapshot.claim && accessOf(item.kind) === 'write' && task?.holder && task.holder !== snapshot.claim.workerId) return refuse('no-worktree-holder', verdict.notices);
  return { ok: true, route, notices: verdict.notices };
}

// A fallback's route: the model named for it, else the same model where it has it, else its first.
const onto = (snapshot: Snapshot, next: { providerId: string; model: string | null }, model: string | null) => {
  const models = snapshot.providers[next.providerId]!.models;
  return { providerId: next.providerId, model: next.model ?? (model && models.includes(model) ? model : models[0] ?? null) };
};

// Why a provider cannot take a turn from this claim right now, or null when it can.
function unable(snapshot: Snapshot, providerId: string): DeferReason | null {
  const provider = snapshot.providers[providerId];
  if (provider?.status !== 'connected') return 'provider-unavailable';
  if (provider.limitedUntil !== null && provider.limitedUntil > snapshot.now) return 'provider-limited';
  if (provider.maxConcurrent !== null && provider.running >= provider.maxConcurrent) return 'provider-busy';
  if (provider.windowPct !== null && provider.windowPct >= 100) return 'provider-window';
  // A turn goes only to a worker that has the provider's tool; another worker that has it takes the turn.
  if (snapshot.claim?.ready && provider.engine && !snapshot.claim.ready.engines.includes(provider.engine)) return 'engine-missing';
  return null;
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
