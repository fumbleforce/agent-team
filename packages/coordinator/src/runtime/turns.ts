import type { z } from 'zod';
import { effective, newId, PermissionGrant, Role, type ClaimBody, type FinishBody, type Lane, type TraceStepInput, type TurnKind, type Viewport } from '@agent-team/protocol';
import type { Tx } from '@agent-team/storage';
import { hashToken, newToken, sameSecret } from '../auth/secrets.ts';
import { HttpError, type Context } from '../context.ts';
import { createCosts } from '../costs/costs.ts';
import { buildPacket, type Packet } from './packet.ts';

export const LEASE_MS = 90_000;
const BOUNDED: readonly TurnKind[] = ['capture', 'review', 'feedback', 'revise', 'conclude', 'triage', 'reply', 'retro', 'ideate'];
// 1 reply to a human, 2 unblock others, 3 owed feedback, 4 continue, 5 new work, 6 upkeep.
const CLASS: Record<TurnKind, number> = { reply: 1, conclude: 2, revise: 2, review: 3, feedback: 3, triage: 3, work: 5, publish: 4, deliver: 4, retro: 6, ideate: 6, capture: 4 };

export const laneOf = (kind: TurnKind): Lane => (kind === 'deliver' || kind === 'publish' ? 'deliver' : BOUNDED.includes(kind) ? 'bounded' : 'work');
const accessOf = (kind: TurnKind) => (kind === 'work' || kind === 'publish' || kind === 'deliver' ? 'write' : kind === 'feedback' || kind === 'conclude' || kind === 'revise' || kind === 'capture' ? 'none' : 'read');

export type ClaimRequest = z.infer<typeof ClaimBody>;
export interface Claimed { turnId: string; leaseToken: string; leaseMs: number; kind: TurnKind; agentId: string; projectId: string; taskId: string | null; taskKey: string | null; threadId: string | null; packet: Packet; grants: PermissionGrant; engine: string | null; model: string | null; capture: { url: string; viewport: Viewport } | null }
export type Outcome = z.infer<typeof FinishBody>['outcome'];

export function createTurns(context: Context) {
  const { storage, events, now } = context;
  const costs = createCosts(context);

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
      if (turn.access === 'write' && turn.task_id) {
        await tx.insertInto('quarantines').values({ id: newId(now()), scope: 'task', ref_id: turn.task_id, turn_id: turn.id, reason: 'Lease expired; inspect the worktree before releasing', opened_at: now(), released_by: null, released_at: null }).execute();
        await tx.updateTable('tasks').set({ state: 'quarantined', updated_at: now() }).where('id', '=', turn.task_id).execute();
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

  async function leased(tx: Tx, turnId: string, workerId: string, leaseToken: string) {
    const turn = await tx.selectFrom('turns').selectAll().where('id', '=', turnId).executeTakeFirst();
    if (!turn || turn.state !== 'running' || turn.worker_id !== workerId || Number(turn.lease_until) < now() || !sameSecret(turn.lease_token_hash, hashToken(leaseToken))) throw new HttpError(409, 'lease', 'Lease lost or invalid');
    return turn;
  }

  return {
    async enqueue(input: { agentId: string; projectId: string; kind: TurnKind; taskId?: string | null; threadId?: string | null; dedupeKey?: string; causeEventId?: string; notBefore?: number; prepare?: (tx: Tx, workItemId: string) => Promise<void> }): Promise<string | null> {
      const id = newId(now());
      const published = await storage.transaction(async tx => {
        if (input.dedupeKey && await tx.selectFrom('work_items').select('id').where('dedupe_key', '=', input.dedupeKey).where('state', 'in', ['queued', 'leased']).executeTakeFirst()) return null;
        await tx.insertInto('work_items').values({ id, agent_id: input.agentId, project_id: input.projectId, kind: input.kind, lane: laneOf(input.kind), task_id: input.taskId ?? null, thread_id: input.threadId ?? null, priority_class: CLASS[input.kind], state: 'queued', defer_reason: null, not_before: input.notBefore ?? null, dedupe_key: input.dedupeKey ?? null, cause_event_id: input.causeEventId ?? null, created_at: now() }).execute();
        // What the turn needs beyond the item itself is written with it, so a claim never sees one without the other.
        await input.prepare?.(tx, id);
        return events.append(tx, [{ type: 'work_item.queued', actorKind: 'system', projectId: input.projectId, agentId: input.agentId, taskId: input.taskId ?? null, payload: { workItemId: id, kind: input.kind } }]);
      });
      if (!published) return null;
      events.published(published);
      return id;
    },

    // One transaction: expire, gate, pick, insert the turn, lease the item.
    async claim(request: ClaimRequest): Promise<Claimed | null> {
      const result = await storage.transaction(async tx => {
        const expired = await expire(tx);
        const lanes = (Object.entries(request.free) as [Lane, number | undefined][]).filter(([, free]) => (free ?? 0) > 0).map(([lane]) => lane);
        if (lanes.length === 0 || request.projects.length === 0) return { expired, claimed: null };
        const candidates = await tx.selectFrom('work_items').innerJoin('agents', 'agents.id', 'work_items.agent_id').select(['agents.daily_cap_minor', 'work_items.id', 'work_items.agent_id', 'work_items.project_id', 'work_items.kind', 'work_items.lane', 'work_items.task_id', 'work_items.thread_id'])
          .where('work_items.state', '=', 'queued').where('work_items.lane', 'in', lanes).where('work_items.project_id', 'in', request.projects).where('agents.status', '=', 'active')
          .where(eb => eb.or([eb('work_items.not_before', 'is', null), eb('work_items.not_before', '<=', now())]))
          .orderBy('work_items.priority_class').orderBy('work_items.created_at').limit(50).execute();
        for (const item of candidates) {
          const kind = item.kind as TurnKind;
          // The spend gate: an agent over its daily cap waits for tomorrow; replies to a human still run.
          if (item.daily_cap_minor !== null && kind !== 'reply' && await costs.spentToday(item.agent_id, tx) >= item.daily_cap_minor) {
            await tx.updateTable('work_items').set({ defer_reason: 'over-cap' }).where('id', '=', item.id).execute();
            continue;
          }
          const access = accessOf(kind);
          if (await tx.selectFrom('turns').select('id').where('agent_id', '=', item.agent_id).where('lane', '=', item.lane).where('state', '=', 'running').executeTakeFirst()) continue;
          // A provider serves a bounded number of turns at once, across all its agents.
          const provider = await tx.selectFrom('agents').innerJoin('providers', 'providers.id', 'agents.provider_id').select(['providers.id', 'providers.limits']).where('agents.id', '=', item.agent_id).executeTakeFirst();
          const limit = provider ? (JSON.parse(provider.limits) as { maxConcurrentTurns?: number }).maxConcurrentTurns : undefined;
          if (provider && limit !== undefined) {
            const busy = await tx.selectFrom('turns').innerJoin('agents', 'agents.id', 'turns.agent_id').select(eb => eb.fn.countAll<number>().as('n')).where('turns.state', '=', 'running').where('agents.provider_id', '=', provider.id).executeTakeFirstOrThrow();
            if (Number(busy.n) >= limit) { await tx.updateTable('work_items').set({ defer_reason: 'provider-busy' }).where('id', '=', item.id).execute(); continue; }
          }
          if (kind === 'deliver') {
            if (await tx.selectFrom('merge_queue').select('id').where('project_id', '=', item.project_id).where('state', 'in', ['running', 'uncertain']).executeTakeFirst()) continue;
            await tx.updateTable('merge_queue').set({ state: 'running' }).where('task_id', '=', item.task_id).where('state', '=', 'queued').execute();
            await tx.updateTable('tasks').set({ state: 'merging', updated_at: now() }).where('id', '=', item.task_id).execute();
          }
          if (item.task_id) {
            if (await tx.selectFrom('quarantines').select('id').where('scope', '=', 'task').where('ref_id', '=', item.task_id).where('released_at', 'is', null).executeTakeFirst()) continue;
            if (access === 'write' && await tx.selectFrom('turns').select('id').where('task_id', '=', item.task_id).where('access', '=', 'write').where('state', '=', 'running').executeTakeFirst()) continue;
          }
          const wanted = kind === 'capture' ? await tx.selectFrom('snapshots').select(['url', 'viewport']).where('work_item_id', '=', item.id).where('state', '=', 'requested').executeTakeFirst() : undefined;
          if (kind === 'capture' && !wanted) { await tx.updateTable('work_items').set({ state: 'done', defer_reason: 'no-request' }).where('id', '=', item.id).execute(); continue; }
          const turnId = newId(now()), leaseToken = newToken();
          const grants = await grantsFor(tx, item.agent_id, item.project_id);
          // Provider and model belong to the agent, not to the job or the worker.
          const seat = await tx.selectFrom('agents').leftJoin('providers', 'providers.id', 'agents.provider_id').select(['agents.model', 'providers.engine']).where('agents.id', '=', item.agent_id).executeTakeFirst();
          const taskKey = item.task_id ? (await tx.selectFrom('tasks').select('key').where('id', '=', item.task_id).executeTakeFirst())?.key ?? null : null;
          await tx.insertInto('turns').values({ id: turnId, work_item_id: item.id, agent_id: item.agent_id, project_id: item.project_id, task_id: item.task_id, kind, lane: item.lane, access, state: 'running', stop_reason: null, worker_id: request.workerId, lease_token_hash: hashToken(leaseToken), lease_until: now() + LEASE_MS, grants: JSON.stringify(grants), summary: null, tokens_in: 0, tokens_out: 0, cost_minor: 0, started_at: now(), finished_at: null }).execute();
          await tx.updateTable('work_items').set({ state: 'leased' }).where('id', '=', item.id).execute();
          if (kind === 'work' && item.task_id) await tx.updateTable('tasks').set({ state: 'in_progress', updated_at: now() }).where('id', '=', item.task_id).where('state', 'in', ['backlog', 'assigned']).execute();
          const started = await events.append(tx, [{ type: 'turn.started', actorKind: 'worker', projectId: item.project_id, agentId: item.agent_id, taskId: item.task_id, turnId, payload: { kind, workerId: request.workerId } }]);
          return { expired: [...expired, ...started], claimed: { turnId, leaseToken, leaseMs: LEASE_MS, kind, agentId: item.agent_id, projectId: item.project_id, taskId: item.task_id, taskKey, threadId: item.thread_id, grants, engine: seat?.engine ?? null, model: seat?.model ?? null, capture: wanted ? { url: wanted.url, viewport: wanted.viewport as Viewport } : null, packet: await buildPacket(tx, { kind, agentId: item.agent_id, projectId: item.project_id, taskId: item.task_id, threadId: item.thread_id }) } satisfies Claimed };
        }
        return { expired, claimed: null };
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
      let reviewTaskId: string | null = null;
      const published = await storage.transaction(async tx => {
        const turn = await leased(tx, turnId, workerId, leaseToken);
        if (turn.kind === 'work' && turn.task_id && outcome.state === 'completed' && (await tx.selectFrom('tasks').select('state').where('id', '=', turn.task_id).executeTakeFirst())?.state === 'in_review') reviewTaskId = turn.task_id;
        await tx.updateTable('turns').set({ state: outcome.state, stop_reason: outcome.stopReason ?? null, summary: outcome.summary?.slice(0, 2000) ?? null, tokens_in: outcome.tokensIn ?? 0, tokens_out: outcome.tokensOut ?? 0, cost_minor: outcome.costMinor ?? 0, finished_at: now() }).where('id', '=', turnId).execute();
        // Deferred work returns to the queue; nobody is at fault. Everything else closes the item.
        await tx.updateTable('work_items').set(outcome.state === 'deferred' ? { state: 'queued', defer_reason: outcome.stopReason ?? 'deferred', not_before: now() + 5 * 60_000 } : { state: 'done' }).where('id', '=', turn.work_item_id).execute();
        await tx.updateTable('agents').set({ doing: null }).where('id', '=', turn.agent_id).execute();
        const agent = await tx.selectFrom('agents').leftJoin('providers', 'providers.id', 'agents.provider_id').select(['agents.provider_id', 'providers.kind']).where('agents.id', '=', turn.agent_id).executeTakeFirst();
        await costs.record(tx, { turnId, agentId: turn.agent_id, projectId: turn.project_id, providerId: agent?.provider_id ?? null, billingKind: (agent?.kind as 'metered' | 'subscription' | 'local' | undefined) ?? 'metered', tokensIn: outcome.tokensIn ?? 0, tokensOut: outcome.tokensOut ?? 0, amountMinor: outcome.costMinor ?? 0 });
        if (turn.task_id && outcome.prUrl) await tx.updateTable('tasks').set({ pr_url: outcome.prUrl }).where('id', '=', turn.task_id).execute();
        if (turn.kind === 'deliver' && turn.task_id && outcome.delivery) {
          const merged = outcome.delivery.state === 'merged';
          await tx.updateTable('merge_queue').set({ state: merged ? 'merged' : 'blocked', reason: outcome.delivery.reason, finished_at: now() }).where('task_id', '=', turn.task_id).where('state', 'in', ['queued', 'running']).execute();
          await tx.updateTable('tasks').set(merged ? { state: 'done', updated_at: now() } : { state: 'blocked', blocked_reason: outcome.delivery.reason.slice(0, 200), updated_at: now() }).where('id', '=', turn.task_id).execute();
        }
        const drafts = [];
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
        if (turn.task_id && (outcome.state === 'failed' || outcome.state === 'timed_out')) await tx.updateTable('tasks').set({ state: 'blocked', blocked_reason: 'needs-attention', updated_at: now() }).where('id', '=', turn.task_id).execute();
        return events.append(tx, [...drafts, { type: `turn.${outcome.state}`, actorKind: 'worker', projectId: turn.project_id, agentId: turn.agent_id, taskId: turn.task_id, turnId, payload: { stopReason: outcome.stopReason ?? null } }]);
      });
      events.published(published);
      return { reviewTaskId: reviewTaskId as string | null };
    },

    // For worker routes that carry more than a lease body: the caller's transaction, the same validation.
    leased,

    async sweep() { events.published(await storage.transaction(expire)); },
  };
}
export type Turns = ReturnType<typeof createTurns>;
