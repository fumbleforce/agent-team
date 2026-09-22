import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { outsideWriteScope, STEP_ARTIFACT_LIMITS, STREAM_ARTIFACT_SEQ, turnToken, type Lane, type PermissionGrant, type TraceStepInput, type TurnKind, type Viewport } from '@agent-team/protocol';
import { enforcesToolPolicy, type EngineAdapter } from '../../../adapters/engine/contract.ts';
import { publish as publishChange, type Exec } from '../../../adapters/scm/publish.ts';
import { SCM_GATES } from '../../../adapters/scm/gates.ts';
import { deliver as gate, type Approvals, type DeliveryConfig } from './deliver/gate.ts';
import { capturePage, type CaptureFn } from './capture.ts';
import { executeTurn, turnDirectory, type TurnResult } from './execute.ts';
import { clearRun, identifyRun, recordRun, sweepOrphans } from './orphans.ts';
import { createRedactor } from './redact.ts';
import { createTracer, type StepArtifact } from './trace.ts';
import { cappedBy, changedPaths, committedCeiling, ensureReviewWorktree, ensureWorktree, headSha, publishAuthorized, removeReviewWorktrees, reviewedTasks, untouchedOverlays, worktreeFor, type AdminHooks, type ReviewWorktree, type Worktree } from './worktree.ts';

// A change is named after its task, the same way whichever path opens it. What an agent said at the end of its turn is a report to
// the team ("ready for review, commit abc on the branch"), not a name for the change, so it never becomes the title.
export const changeTitle = (taskKey: string | null, taskTitle: string | null | undefined): string => (taskKey && taskTitle ? `${taskKey}: ${taskTitle}` : taskTitle || taskKey || 'Change from the team').slice(0, 200);
export const changeBody = (report: string | null): string => (report ? `The author's report at the end of its turn:\n\n${report}` : '');

export interface DeliveryFacts { taskKey: string; title?: string; headSha: string; prUrl: string | null; manifest: { scm?: { kind?: string }; delivery?: DeliveryConfig }; approvals: Approvals }
export interface DeliveryResult { state: 'merged' | 'blocked'; reason: string; mergeAttempted: boolean; mergeCommit?: string; waiting?: boolean }
export type DeliverFn = (input: { config: DeliveryConfig; scm: string; prUrl: string; approvals: () => Promise<Approvals>; worktree: string; branch: string }) => Promise<DeliveryResult>;

// The one path to the base branch, with the SCM chosen by the project's manifest.
const defaultDeliver: DeliverFn = input => {
  const scm = SCM_GATES[input.scm];
  if (!scm) throw new Error(`Unknown SCM "${input.scm}"`);
  return gate({ ...input, scm });
};

// What the coordinator takes as a turn's summary (FinishBody: 2000). Redaction can grow a short secret into its mark, so the cap is enforced on the final text:
// a failed or timed-out turn keeps its end, where the cause and the stderr tail live, anything else keeps its headline.
export function finishSummary(text: string | null, state: TurnResult['state']): string | null {
  if (!text) return null;
  return state === 'failed' || state === 'timed_out' ? text.slice(-2000) : text.slice(0, 2000);
}


export interface WorkerConfig {
  coordinatorUrl: string; token: string; workerId: string; stateDir: string; lanes: Record<Lane, number>; projects: Record<string, string>; engine: EngineAdapter;
  timeoutMs?: number; pollMs?: number; env?: NodeJS.ProcessEnv;
  worktrees?: { branchPrefix: string; base: string } | null;
  publish?: { scm: string; repository: string; base: string; exec: Exec } | null;
  deliver?: DeliverFn;
  // Page captures for the product view; the default drives a locally installed browser.
  capture?: CaptureFn;
  // Other engines installed on this worker, for agents whose provider names one; the default serves everyone else.
  engines?: Record<string, EngineAdapter>;
  // A strict worker runs a restricted turn only on an engine that enforces the restriction itself; instructions are not isolation.
  isolation?: 'strict' | 'isolated';
  // What this machine can run, sent with every claim so the app can say which providers are ready here. Names only.
  ready?: { engines: string[]; variables: string[]; models?: Record<string, { id: string; name: string; note?: string; efforts?: string[] }[]>; efforts?: Record<string, string[]>; runs?: { engine: string; model: string | null } };
  // A disposable host that is gone after its turn (`--once`): it keeps neither a session nor a worktree, so it serves a project only when
  // the committed manifest authorizes publishing, runs every turn from its packet and pushes the branch at the end of every turn.
  ephemeral?: boolean;
}
interface Claimed { /* Keys entered in the app that this turn's engine reads, by variable name. Held in memory for the turn only. */ secrets?: Record<string, string>; review?: { headSha: string; reviewer: string } | null; turnId: string; leaseToken: string; leaseMs: number; kind: TurnKind; agentId: string; projectId: string; taskId: string | null; taskKey: string | null; taskTitle?: string | null; packet: { system: string; prompt: string }; grants: PermissionGrant; engine: string | null; model: string | null; effort?: string | null; capture?: { url: string; viewport: Viewport } | null; resume?: { sessionId: string; prompt: string; baseSha: string | null } | null }
interface Lease { workerId: string; leaseToken: string }
// What one turn shares with its heartbeat: whether it is inside an operation on the checkout's shared git state right now.
interface TurnState { adminOpen: boolean }
const TERMINAL = ['done', 'canceled', 'stopped'];

// The worker's side of the rule the launcher applies before it starts a disposable host; the two give the same reasons.
export function ephemeralRefusal(input: { publishAuthorized: boolean; publish?: { scm?: string; repository?: string; base?: string } | null | undefined; worktrees?: unknown }): string | null {
  const missing = [...(input.publishAuthorized ? [] : ['the project manifest does not authorize publishing (publishAuthorized)']),
    ...(input.publish?.scm && input.publish.repository && input.publish.base ? [] : ['no publish target (scm, repository, base) is configured, so the branch cannot be pushed at the end of each turn']),
    ...(input.worktrees === null ? ['worktrees are turned off, so there is no branch to push'] : [])];
  return missing.length ? `An ephemeral worker is refused: ${missing.join('; ')}` : null;
}

class LeaseLost extends Error {}

export function createWorker(config: WorkerConfig) {
  const busy: Record<Lane, number> = { work: 0, bounded: 0, deliver: 0 };
  const running = new Set<Promise<void>>();
  let stopped = false;
  // Checkouts a lost lease left in the middle of a git-admin operation: nothing more is claimed for them by this process.
  const unknownCheckouts = new Set<string>();
  const refused = new Map<string, string>();

  // Which projects this worker may claim for right now.
  async function servable(): Promise<string[]> {
    const projects = Object.keys(config.projects).filter(id => !unknownCheckouts.has(id));
    if (!config.ephemeral) return projects;
    const allowed: string[] = [];
    for (const id of projects) {
      const authorized = config.worktrees ? await publishAuthorized(config.projects[id]!, config.worktrees.base).catch(() => false) : false;
      const refusal = ephemeralRefusal({ publishAuthorized: authorized, publish: config.publish, worktrees: config.worktrees });
      if (refusal) refused.set(id, refusal); else { refused.delete(id); allowed.push(id); }
    }
    return allowed;
  }

  // Review worktrees of tasks that are over are removed; the author's worktree and branch are kept.
  async function cleanReviews(): Promise<string[]> {
    const removed: string[] = [];
    if (!config.worktrees) return removed;
    for (const [projectId, checkout] of Object.entries(config.projects)) {
      if (unknownCheckouts.has(projectId)) continue;
      let taskKeys: string[];
      try { taskKeys = reviewedTasks(checkout); } catch { continue; }
      if (!taskKeys.length) continue;
      const { states } = await call<{ states: Record<string, string> }>('/worker/tasks/states', { workerId: config.workerId, projectId, taskKeys: taskKeys.slice(0, 200) });
      for (const taskKey of taskKeys) if (TERMINAL.includes(states[taskKey] ?? '')) removed.push(...await removeReviewWorktrees(checkout, taskKey));
    }
    return removed;
  }

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
    // Approved but never published (the worker had nowhere to push at the time): the change is opened now, from the approved branch.
    let prUrl = facts.prUrl;
    if (!prUrl && config.publish) prUrl = (await publishChange(config.publish.scm, { worktree: worktree.path, repository: config.publish.repository, branch: worktree.branch, base: config.publish.base, title: changeTitle(facts.taskKey, facts.title), body: '' }, config.publish.exec).catch((error: Error) => { console.error(`Publish failed: ${error.message}`); return null; }))?.url ?? null;
    const delivery = await Promise.resolve().then(() => (prUrl ? (config.deliver ?? defaultDeliver)({ config: facts.manifest.delivery!, scm, prUrl, approvals, worktree: worktree.path, branch: worktree.branch }) : Promise.reject(new Error('No change was published for this task, and this worker has nowhere to publish to'))))
      .catch((error: Error): DeliveryResult => ({ state: 'blocked', reason: error.message, mergeAttempted: false }));
    // A check that has not finished is no verdict: the delivery goes back to the queue and is tried again in a few minutes.
    if (delivery.waiting) { await call(`/worker/turns/${turn.turnId}/finish`, { ...lease, outcome: { state: 'deferred', stopReason: 'checks-running', summary: delivery.reason.slice(0, 500), ...(prUrl && !facts.prUrl ? { prUrl } : {}) } }); return; }
    const result = { state: delivery.state, reason: delivery.reason.slice(0, 500), mergeAttempted: delivery.mergeAttempted, ...(delivery.mergeCommit ? { mergeCommit: delivery.mergeCommit } : {}) };
    await call(`/worker/turns/${turn.turnId}/finish`, { ...lease, outcome: { state: 'completed', summary: result.reason, delivery: result, ...(prUrl && !facts.prUrl ? { prUrl } : {}) } });
  }

  // No model runs here either: one headless browser run, the image uploaded under the lease, then the outcome.
  // A capture changes nothing, so every failure is a plain failure with its reason, never an uncertain one.
  async function runCapture(turn: Claimed, lease: Lease, lost: () => boolean) {
    const turnDir = turnDirectory(config.stateDir, turn.turnId);
    const outFile = path.join(turnDir, 'capture.png');
    let outcome: { state: 'completed' | 'failed'; stopReason?: string; summary: string };
    try {
      if (!turn.capture) throw new Error('The claim names no page to capture');
      mkdirSync(turnDir, { recursive: true, mode: 0o700 });
      const captured = await (config.capture ?? capturePage)({ url: turn.capture.url, viewport: turn.capture.viewport, outFile, env: config.env ?? process.env });
      const response = await fetch(`${config.coordinatorUrl}/worker/turns/${turn.turnId}/artifacts`, { method: 'POST', headers: { 'content-type': 'image/png', authorization: `Bearer ${config.token}`, 'x-worker-id': lease.workerId, 'x-lease-token': lease.leaseToken, 'x-latency-ms': String(captured.latencyMs) }, body: readFileSync(captured.file), signal: AbortSignal.timeout(30_000) });
      if (response.status === 409) throw new LeaseLost();
      if (!response.ok) throw new Error(`The coordinator refused the image (${response.status})`);
      outcome = { state: 'completed', summary: `Captured ${turn.capture.url} at ${turn.capture.viewport} in ${captured.latencyMs} ms` };
    } catch (error) {
      if (error instanceof LeaseLost) throw error;
      outcome = { state: 'failed', stopReason: 'capture', summary: (error as Error).message.slice(0, 500) };
    } finally { rmSync(outFile, { force: true }); }
    if (!lost()) await call(`/worker/turns/${turn.turnId}/finish`, { ...lease, outcome });
  }

  async function runEngine(turn: Claimed, lane: Lane, lease: Lease, signal: AbortSignal, lost: () => boolean, state: TurnState) {
    let pending: TraceStepInput[] = [];
    const flush = async () => { const steps = pending; pending = []; if (steps.length && !lost()) await call(`/worker/turns/${turn.turnId}/steps`, { ...lease, steps }).catch(() => {}); };
    const flusher = setInterval(() => { void flush(); }, 1000);
    const turnDir = turnDirectory(config.stateDir, turn.turnId);
    try {
      // The agent reaches the platform with a token derived from this lease; it travels in a private file, never in argv.
      mkdirSync(turnDir, { recursive: true, mode: 0o700 });
      const tokenFile = path.join(turnDir, 'platform-token');
      const platformToken = turnToken(config.token, turn.turnId, turn.leaseToken), env = config.env ?? process.env;
      writeFileSync(tokenFile, platformToken, { mode: 0o600 });
      const checkout = config.projects[turn.projectId] ?? process.cwd();
      // Announced to the coordinator on both sides, so a lease lost in between is known to have left the checkout itself unknown.
      const admin: AdminHooks = {
        begin: async () => { await call(`/worker/turns/${turn.turnId}/git-admin`, { ...lease, state: 'begin' }); state.adminOpen = true; },
        end: async () => { await call(`/worker/turns/${turn.turnId}/git-admin`, { ...lease, state: 'end' }); state.adminOpen = false; },
      };
      // Writers work in their task's own worktree; a review reads a tree of its own, detached at the head under review, never the author's;
      // other bounded turns read the checkout. A worktree that cannot be made safely fails the turn: nothing was run, so nothing is uncertain.
      let worktree: Worktree | null = null, reviewTree: ReviewWorktree | null = null, grants = turn.grants;
      try {
        // The base is read fresh from the code host before a task's worktree is made from it; a task already under way keeps its own.
        const remoteBase = config.worktrees ? /^origin\/(.+)$/.exec(config.worktrees.base)?.[1] : undefined;
        if (lane === 'work' && remoteBase && config.publish) await config.publish.exec('git', ['-C', checkout, 'fetch', '--quiet', 'origin', remoteBase], { cwd: checkout }).catch((error: Error) => console.error(`Fetching ${remoteBase} failed: ${error.message}`));
        if (lane === 'work' && turn.taskKey && config.worktrees) worktree = await ensureWorktree({ checkout, taskKey: turn.taskKey, ...config.worktrees, admin });
        else if (turn.kind === 'review' && turn.taskKey && turn.review && config.worktrees) reviewTree = await ensureReviewWorktree({ checkout, taskKey: turn.taskKey, reviewer: turn.review.reviewer, headSha: turn.review.headSha, projectId: turn.projectId, admin });
        // The committed ceiling wins even over what the coordinator sent.
        grants = cappedBy(turn.grants, config.worktrees ? await committedCeiling(checkout, config.worktrees.base) : null);
      } catch (error) {
        if (error instanceof LeaseLost || lost()) throw error;
        await call(`/worker/turns/${turn.turnId}/finish`, { ...lease, outcome: { state: 'failed', stopReason: 'worktree-refused', summary: `The worktree could not be prepared safely; nothing was run. ${(error as Error).message}`.slice(0, 500) } });
        return;
      }
      const adapter = (turn.engine ? config.engines?.[turn.engine] : undefined) ?? config.engine;
      // A review runs in its own detached checkout of the head, so a reviewer whose role allows a shell may run the tests there; it still edits nothing, and the worker checks the head did not move.
      const toolProfile = lane === 'work' && grants.codeWrite !== 'none' ? 'write' : turn.kind === 'review' && reviewTree && grants.shell !== 'none' ? 'verify' : 'read-only';
      // Anything short of an unrestricted writer is a restriction someone has to hold the engine to.
      const restricted = toolProfile !== 'write' || grants.shell !== 'full';
      if (config.isolation === 'strict' && restricted && !enforcesToolPolicy(adapter.capabilities)) {
        if (!lost()) await call(`/worker/turns/${turn.turnId}/finish`, { ...lease, outcome: { state: 'failed', stopReason: 'isolation-refused', summary: `This worker is strict and the ${adapter.name} engine cannot enforce the turn's restrictions (${toolProfile}, shell ${grants.shell}); nothing was run.` } });
        return;
      }
      // Whatever leaves this worker is stripped of its secrets first.
      const redact = createRedactor(env, [config.token, turn.leaseToken, platformToken, ...Object.values(turn.secrets ?? {})]);
      const artifact = (item: StepArtifact) => lost() ? Promise.resolve() : fetch(`${config.coordinatorUrl}/worker/turns/${turn.turnId}/artifacts`, { method: 'POST', headers: { 'content-type': item.mime, authorization: `Bearer ${config.token}`, 'x-worker-id': lease.workerId, 'x-lease-token': lease.leaseToken, 'x-step-seq': String(item.seq), 'x-step-kind': item.kind, 'x-step-truncated': item.truncated ? '1' : '0' }, body: item.body, signal: AbortSignal.timeout(30_000) }).then(() => {});
      const tracer = createTracer({ worktree: worktree?.path ?? null, turnDir, redact, screenshotDir: path.join(turnDir, 'browser'), onSteps: steps => { pending.push(...steps); }, onArtifact: artifact });
      tracer.start();
      // The raw engine stream, redacted line by line as it arrives and archived as one artifact when the turn ends.
      const stream: string[] = [];
      let streamBytes = 0, streamCut = false;
      const keepLine = (line: string) => { const clean = redact(line); streamBytes += Buffer.byteLength(clean) + 1; if (streamBytes <= STEP_ARTIFACT_LIMITS.stream) stream.push(clean); else streamCut = true; };
      // Only an engine that can resume gets the session and the delta; every other one starts from the packet, which carries the same history.
      // A disposable host has no session to come back to: every turn there starts from its packet.
      const resume = turn.resume && adapter.capabilities.resume === 'id' && !config.ephemeral ? turn.resume : null;
      const moved = resume?.baseSha && worktree && resume.baseSha !== worktree.baseCommit ? `\n\n# The base moved\nThe base branch was at ${resume.baseSha.slice(0, 10)} when this session last ran and is at ${worktree.baseCommit.slice(0, 10)} now. Bring your branch up to date before you continue.` : '';
      const result = await executeTurn({
        adapter, turnDir, env, ...(turn.secrets ? { secrets: turn.secrets } : {}), timeoutMs: config.timeoutMs ?? (lane === 'work' ? 45 : 15) * 60_000, signal,
        spec: { turnId: turn.turnId, kind: turn.kind, cwd: worktree?.path ?? reviewTree?.path ?? checkout, prompt: resume ? resume.prompt + moved : turn.packet.prompt, systemPrompt: turn.packet.system, model: turn.model, effort: turn.effort ?? null, sessionId: resume?.sessionId ?? null, toolProfile, platform: { url: `${config.coordinatorUrl}/mcp`, tokenFile } },
        onSteps: steps => tracer.steps(steps),
        onLine: keepLine,
        // What a crash leaves behind is found by the next start of this worker.
        // The record also says who that pid is, so a later sweep never ends a stranger that inherited the number.
        onSpawn: pid => { const record = { turnId: turn.turnId, leaseToken: turn.leaseToken, pid: pid ?? null, startedAt: Date.now() }; recordRun(turnDir, record); void identifyRun(turnDir, record).catch(() => {}); },
        // Posted at once: a session named only at the end of a turn is lost with the turn.
        onSession: sessionId => { if (turn.kind === 'work' && !lost()) void call(`/worker/turns/${turn.turnId}/session`, { ...lease, sessionId, ...(worktree ? { baseSha: worktree.baseCommit } : {}) }).catch(() => {}); },
      });
      await tracer.finish();
      if (stream.length) await artifact({ seq: STREAM_ARTIFACT_SEQ, kind: 'stream', body: stream.map(line => `${line}\n`).join(''), mime: 'text/plain; charset=utf-8', truncated: streamCut }).catch(() => {});
      await flush();
      const summary = finishSummary(result.summary ? redact(result.summary) : null, result.state);
      // The diff gate: whatever tool made a change, a path outside the write scope means nothing is published or reviewed.
      // Overlays the turn left as they were written are setup, not the agent's change.
      const setup = worktree ? await untouchedOverlays(worktree.path) : [];
      const violations = worktree ? outsideWriteScope(grants, (await changedPaths(worktree.path, worktree.baseCommit)).filter(file => !setup.includes(file))) : [];
      if (violations.length) {
        if (!lost()) await call(`/worker/turns/${turn.turnId}/finish`, { ...lease, outcome: { state: 'failed', stopReason: 'write-scope', summary: `Changed outside the write scope: ${violations.slice(0, 20).join(', ')}`, tokensIn: result.tokensIn, tokensOut: result.tokensOut, contextTokens: result.contextTokens, costMinor: Math.round(result.costUsd * 100) } });
        return;
      }
      // Publishing is worker code: after a completed work turn the branch is pushed and a draft change opened or reused.
      const published = worktree && config.publish && result.state === 'completed'
        ? await publishChange(config.publish.scm, { worktree: worktree.path, repository: config.publish.repository, branch: worktree.branch, base: config.publish.base, title: changeTitle(turn.taskKey, turn.taskTitle), body: changeBody(summary) }, config.publish.exec)
          .catch((error: Error) => { console.error(`Publish failed: ${error.message}`); return null; })
        : null;
      // On a disposable host whatever is not pushed is gone with the host, so the branch is pushed however the turn ended, never with force.
      let unpushed: string | null = null;
      if (config.ephemeral && worktree && config.publish && !published) {
        const target = config.publish;
        unpushed = await target.exec('git', ['-C', worktree.path, 'push', '--set-upstream', 'origin', `${worktree.branch}:${worktree.branch}`], { cwd: worktree.path }).then(() => null, (error: Error) => error.message);
      }
      if (unpushed !== null) {
        if (!lost()) await call(`/worker/turns/${turn.turnId}/finish`, { ...lease, outcome: { state: 'failed', stopReason: 'push-failed', summary: `The branch could not be pushed from a disposable host, so this turn's work is not kept: ${redact(unpushed)}`.slice(0, 500), tokensIn: result.tokensIn, tokensOut: result.tokensOut, costMinor: Math.round(result.costUsd * 100) } });
        return;
      }
      // With the lease gone the coordinator has already marked the turn uncertain; nothing more may be reported.
      if (!lost()) await call(`/worker/turns/${turn.turnId}/finish`, { ...lease, outcome: {
        // The head the review worktree was verified at before the engine ran, and where it is now: a verdict counts only if both are the task's head.
        ...(reviewTree ? { headShaStart: reviewTree.headSha, headShaEnd: await headSha(reviewTree.path) } : {}),
        state: result.state, stopReason: result.stopReason, ...(summary ? { summary } : {}), tokensIn: result.tokensIn, tokensOut: result.tokensOut, costMinor: Math.round(result.costUsd * 100),
        ...(worktree ? { headSha: await headSha(worktree.path) } : {}), ...(published ? { prUrl: published.url } : {}),
      } });
    } finally { clearInterval(flusher); clearRun(turnDir); }
  }

  async function run(turn: Claimed, lane: Lane) {
    const lease: Lease = { workerId: config.workerId, leaseToken: turn.leaseToken };
    const abort = new AbortController();
    let leaseLost = false;
    const state: TurnState = { adminOpen: false };
    // A lease lost while the checkout's shared git state was being changed leaves the checkout unknown: this process claims nothing more for it.
    const unknown = () => { if (state.adminOpen) unknownCheckouts.add(turn.projectId); };
    // Fail-stop: a heartbeat that cannot be confirmed ends the process, because ownership is then unknown.
    const heartbeat = setInterval(() => { call(`/worker/turns/${turn.turnId}/heartbeat`, lease).catch(() => { leaseLost = true; unknown(); abort.abort(); }); }, turn.leaseMs / 3);
    try {
      if (turn.kind === 'deliver') await runDelivery(turn, lease);
      else if (turn.kind === 'capture') await runCapture(turn, lease, () => leaseLost);
      else await runEngine(turn, lane, lease, abort.signal, () => leaseLost, state);
      // A merged task is over: its review worktrees go.
      if (turn.kind === 'deliver') await cleanReviews().catch(() => []);
    } catch (error) {
      if (error instanceof LeaseLost) unknown();
      throw error;
    } finally { clearInterval(heartbeat); busy[lane]--; }
  }

  return {
    // Claims one turn if a lane is free; returns whether anything was claimed.
    async tick(): Promise<boolean> {
      const free = Object.fromEntries((Object.keys(busy) as Lane[]).map(lane => [lane, config.lanes[lane] - busy[lane]]));
      const projects = await servable();
      if (projects.length === 0) return false;
      const { turn } = await call<{ turn: Claimed | null }>('/worker/claim', { workerId: config.workerId, free, projects, isolation: config.isolation ?? 'isolated', ...(config.ready ? { ready: config.ready } : {}) });
      if (!turn) return false;
      const lane: Lane = turn.kind === 'work' ? 'work' : turn.kind === 'deliver' || turn.kind === 'publish' ? 'deliver' : 'bounded';
      busy[lane]++;
      const job = run(turn, lane).catch(error => { if (!(error instanceof LeaseLost)) console.error(`Turn ${turn.turnId}: ${(error as Error).message}`); });
      running.add(job);
      void job.finally(() => running.delete(job));
      return true;
    },
    // Turns a previous run of this worker left behind: their processes are ended and they are reported, never resumed.
    sweep: () => sweepOrphans(config.stateDir, record => call(`/worker/turns/${record.turnId}/orphaned`, { workerId: config.workerId, leaseToken: record.leaseToken })),
    async loop() { await this.sweep().catch(() => []); while (!stopped) { if (!await this.tick().catch(() => false)) await new Promise(resolve => setTimeout(resolve, config.pollMs ?? 2000)); } },
    idle: () => Promise.all([...running]).then(() => undefined),
    cleanReviews,
    // Why this worker serves nothing for a project, by project: a disposable host whose repository does not authorize publishing.
    refusals: async () => { await servable(); return Object.fromEntries(refused); },
    quarantinedCheckouts: () => [...unknownCheckouts],
    stop() { stopped = true; },
  };
}
