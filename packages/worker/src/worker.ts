import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { outsideWriteScope, turnToken, type Lane, type PermissionGrant, type TraceStepInput, type TurnKind } from '@agent-team/protocol';
import type { EngineAdapter } from '../../../adapters/engine/contract.ts';
import { publish as publishChange, type Exec } from '../../../adapters/scm/publish.ts';
import { SCM_GATES } from '../../../adapters/scm/gates.ts';
import { deliver as gate, type Approvals, type DeliveryConfig } from './deliver/gate.ts';
import { executeTurn, turnDirectory } from './execute.ts';
import { cappedBy, changedPaths, committedCeiling, ensureWorktree, headSha, worktreeFor } from './worktree.ts';

export interface DeliveryFacts { taskKey: string; headSha: string; prUrl: string; manifest: { scm?: { kind?: string }; delivery?: DeliveryConfig }; approvals: Approvals }
export interface DeliveryResult { state: 'merged' | 'blocked'; reason: string; mergeAttempted: boolean; mergeCommit?: string }
export type DeliverFn = (input: { config: DeliveryConfig; scm: string; prUrl: string; approvals: () => Promise<Approvals>; worktree: string; branch: string }) => Promise<DeliveryResult>;

// The one path to the base branch, with the SCM chosen by the project's manifest.
const defaultDeliver: DeliverFn = input => {
  const scm = SCM_GATES[input.scm];
  if (!scm) throw new Error(`Unknown SCM "${input.scm}"`);
  return gate({ ...input, scm });
};


export interface WorkerConfig {
  coordinatorUrl: string; token: string; workerId: string; stateDir: string; lanes: Record<Lane, number>; projects: Record<string, string>; engine: EngineAdapter;
  timeoutMs?: number; pollMs?: number; env?: NodeJS.ProcessEnv;
  worktrees?: { branchPrefix: string; base: string } | null;
  publish?: { scm: string; repository: string; base: string; exec: Exec } | null;
  deliver?: DeliverFn;
  // Other engines installed on this worker, for agents whose provider names one; the default serves everyone else.
  engines?: Record<string, EngineAdapter>;
}
interface Claimed { turnId: string; leaseToken: string; leaseMs: number; kind: TurnKind; agentId: string; projectId: string; taskId: string | null; taskKey: string | null; packet: { system: string; prompt: string }; grants: PermissionGrant; engine: string | null; model: string | null }
interface Lease { workerId: string; leaseToken: string }

class LeaseLost extends Error {}

export function createWorker(config: WorkerConfig) {
  const busy: Record<Lane, number> = { work: 0, bounded: 0, deliver: 0 };
  const running = new Set<Promise<void>>();
  let stopped = false;

  async function call<T>(route: string, body: unknown): Promise<T> {
    const response = await fetch(config.coordinatorUrl + route, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${config.token}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    if (response.status === 409) throw new LeaseLost();
    if (!response.ok) throw new Error(`Coordinator answered ${response.status}`);
    return await response.json() as T;
  }

  // No model runs here: the gate re-reads the change, the checks and the approvals, merges once, and confirms.
  async function runDelivery(turn: Claimed, lease: Lease) {
    const facts = await call<DeliveryFacts>(`/worker/turns/${turn.turnId}/delivery`, lease);
    const checkout = config.projects[turn.projectId] ?? process.cwd();
    const worktree = worktreeFor(checkout, facts.taskKey, config.worktrees?.branchPrefix ?? 'agents/');
    const scm = facts.manifest.scm?.kind;
    if (!scm) throw new Error('The project manifest names no source host');
    if (!facts.manifest.delivery) throw new Error('The project manifest has no delivery section');
    // Approvals are re-read from the platform each time the gate asks, so one withdrawn in between stops the merge.
    const approvals = async () => (await call<DeliveryFacts>(`/worker/turns/${turn.turnId}/delivery`, lease)).approvals;
    const delivery = await Promise.resolve().then(() => (config.deliver ?? defaultDeliver)({ config: facts.manifest.delivery!, scm, prUrl: facts.prUrl, approvals, worktree: worktree.path, branch: worktree.branch }))
      .catch((error: Error): DeliveryResult => ({ state: 'blocked', reason: error.message, mergeAttempted: false }));
    const result = { state: delivery.state, reason: delivery.reason.slice(0, 500), mergeAttempted: delivery.mergeAttempted, ...(delivery.mergeCommit ? { mergeCommit: delivery.mergeCommit } : {}) };
    await call(`/worker/turns/${turn.turnId}/finish`, { ...lease, outcome: { state: 'completed', summary: result.reason, delivery: result } });
  }

  async function runEngine(turn: Claimed, lane: Lane, lease: Lease, signal: AbortSignal, lost: () => boolean) {
    let pending: TraceStepInput[] = [];
    const flush = async () => { const steps = pending; pending = []; if (steps.length && !lost()) await call(`/worker/turns/${turn.turnId}/steps`, { ...lease, steps }).catch(() => {}); };
    const flusher = setInterval(() => { void flush(); }, 1000);
    try {
      // The agent reaches the platform with a token derived from this lease; it travels in a private file, never in argv.
      const turnDir = turnDirectory(config.stateDir, turn.turnId);
      mkdirSync(turnDir, { recursive: true, mode: 0o700 });
      const tokenFile = path.join(turnDir, 'platform-token');
      writeFileSync(tokenFile, turnToken(config.token, turn.turnId, turn.leaseToken), { mode: 0o600 });
      const checkout = config.projects[turn.projectId] ?? process.cwd();
      // Writers work in their task's own worktree; bounded turns read the checkout.
      const worktree = lane === 'work' && turn.taskKey && config.worktrees ? await ensureWorktree({ checkout, taskKey: turn.taskKey, ...config.worktrees }) : null;
      // The committed ceiling wins even over what the coordinator sent.
      const grants = cappedBy(turn.grants, config.worktrees ? await committedCeiling(checkout, config.worktrees.base) : null);
      const result = await executeTurn({
        adapter: (turn.engine ? config.engines?.[turn.engine] : undefined) ?? config.engine, turnDir, env: config.env ?? process.env, timeoutMs: config.timeoutMs ?? 45 * 60_000, signal,
        spec: { turnId: turn.turnId, kind: turn.kind, cwd: worktree?.path ?? checkout, prompt: turn.packet.prompt, systemPrompt: turn.packet.system, model: turn.model, sessionId: null, toolProfile: lane === 'work' && grants.codeWrite !== 'none' ? 'write' : 'read-only', platform: { url: `${config.coordinatorUrl}/mcp`, tokenFile } },
        onSteps: steps => { pending.push(...steps); },
      });
      await flush();
      // The diff gate: whatever tool made a change, a path outside the write scope means nothing is published or reviewed.
      const violations = worktree ? outsideWriteScope(grants, await changedPaths(worktree.path, worktree.baseCommit)) : [];
      if (violations.length) {
        if (!lost()) await call(`/worker/turns/${turn.turnId}/finish`, { ...lease, outcome: { state: 'failed', stopReason: 'write-scope', summary: `Changed outside the write scope: ${violations.slice(0, 20).join(', ')}`, tokensIn: result.tokensIn, tokensOut: result.tokensOut, costMinor: Math.round(result.costUsd * 100) } });
        return;
      }
      // Publishing is worker code: after a completed work turn the branch is pushed and a draft change opened or reused.
      const title = `${turn.taskKey ?? ''} ${result.summary?.split('\n')[0]?.slice(0, 80) ?? ''}`.trim();
      const published = worktree && config.publish && result.state === 'completed'
        ? await publishChange(config.publish.scm, { worktree: worktree.path, repository: config.publish.repository, branch: worktree.branch, base: config.publish.base, title, body: result.summary ?? '' }, config.publish.exec)
          .catch((error: Error) => { console.error(`Publish failed: ${error.message}`); return null; })
        : null;
      // With the lease gone the coordinator has already marked the turn uncertain; nothing more may be reported.
      if (!lost()) await call(`/worker/turns/${turn.turnId}/finish`, { ...lease, outcome: {
        state: result.state, stopReason: result.stopReason, ...(result.summary ? { summary: result.summary } : {}), tokensIn: result.tokensIn, tokensOut: result.tokensOut, costMinor: Math.round(result.costUsd * 100),
        ...(worktree ? { headSha: await headSha(worktree.path) } : {}), ...(published ? { prUrl: published.url } : {}),
      } });
    } finally { clearInterval(flusher); }
  }

  async function run(turn: Claimed, lane: Lane) {
    const lease: Lease = { workerId: config.workerId, leaseToken: turn.leaseToken };
    const abort = new AbortController();
    let leaseLost = false;
    // Fail-stop: a heartbeat that cannot be confirmed ends the process, because ownership is then unknown.
    const heartbeat = setInterval(() => { call(`/worker/turns/${turn.turnId}/heartbeat`, lease).catch(() => { leaseLost = true; abort.abort(); }); }, turn.leaseMs / 3);
    try {
      if (turn.kind === 'deliver') await runDelivery(turn, lease);
      else await runEngine(turn, lane, lease, abort.signal, () => leaseLost);
    } finally { clearInterval(heartbeat); busy[lane]--; }
  }

  return {
    // Claims one turn if a lane is free; returns whether anything was claimed.
    async tick(): Promise<boolean> {
      const free = Object.fromEntries((Object.keys(busy) as Lane[]).map(lane => [lane, config.lanes[lane] - busy[lane]]));
      const { turn } = await call<{ turn: Claimed | null }>('/worker/claim', { workerId: config.workerId, free, projects: Object.keys(config.projects) });
      if (!turn) return false;
      const lane: Lane = turn.kind === 'work' ? 'work' : turn.kind === 'deliver' || turn.kind === 'publish' ? 'deliver' : 'bounded';
      busy[lane]++;
      const job = run(turn, lane).catch(error => { if (!(error instanceof LeaseLost)) console.error(`Turn ${turn.turnId}: ${(error as Error).message}`); });
      running.add(job);
      void job.finally(() => running.delete(job));
      return true;
    },
    async loop() { while (!stopped) { if (!await this.tick().catch(() => false)) await new Promise(resolve => setTimeout(resolve, config.pollMs ?? 2000)); } },
    idle: () => Promise.all([...running]).then(() => undefined),
    stop() { stopped = true; },
  };
}
