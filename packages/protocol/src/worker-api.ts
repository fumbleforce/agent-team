import { z } from 'zod';
import { TraceKind } from './enums.ts';

const WorkerId = z.string().regex(/^[\w.-]{1,128}$/);
export const LeaseBody = z.object({ workerId: WorkerId, leaseToken: z.string().min(20) });
export const ClaimBody = z.object({
  workerId: WorkerId,
  free: z.object({ work: z.number().int().min(0), bounded: z.number().int().min(0), deliver: z.number().int().min(0) }).partial(),
  projects: z.array(z.string()).max(100),
  // From the worker's own config file: a strict worker refuses a restricted turn its engine cannot enforce.
  isolation: z.enum(['strict', 'isolated']).optional(),
  // What this worker can run: engines whose command-line tool it found, and which credential variables are set. Names only, never values.
  ready: z.object({ engines: z.array(z.string().max(40)).max(20), variables: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/)).max(40),
    // The models a tool on the worker says it has, by engine. Names and descriptions only.
    models: z.record(z.string().max(40), z.array(z.object({ id: z.string().regex(/^\S{1,120}$/), name: z.string().max(120), note: z.string().max(160).optional(), efforts: z.array(z.string().regex(/^[a-z]{2,12}$/)).max(12).optional() })).max(100)).optional(),
    // The effort levels each tool says it takes, by engine.
    efforts: z.record(z.string().max(40), z.array(z.string().regex(/^[a-z]{2,12}$/)).max(12)).optional(),
    // What a turn that names no provider runs on here: the worker's own tool, and that tool's own default model when its settings name one.
    runs: z.object({ engine: z.string().max(40), model: z.string().max(120).nullable() }).optional() }).optional(),
});
export const TraceStepInput = z.object({ seq: z.number().int().min(0), kind: TraceKind, title: z.string().min(1).max(400), detail: z.string().max(200).optional(), status: z.enum(['running', 'ok', 'error']) });
export type TraceStepInput = z.infer<typeof TraceStepInput>;
export const StepsBody = LeaseBody.extend({ steps: z.array(TraceStepInput).max(400) });
export const FinishBody = LeaseBody.extend({
  outcome: z.object({
    state: z.enum(['completed', 'failed', 'deferred', 'interrupted', 'timed_out']),
    stopReason: z.string().max(80).optional(), summary: z.string().max(2000).optional(),
    // When a usage limit lifts, if the engine said; the provider stays limited until then.
    resetAt: z.number().int().min(0).optional(),
    // The usage window as the engine last said: the share used (above 1 when past its cap) and when it resets.
    window: z.object({ used: z.number().min(0).max(10), resetsAt: z.number().int().min(0) }).optional(),
    tokensIn: z.number().int().min(0).optional(), tokensOut: z.number().int().min(0).optional(), contextTokens: z.number().int().min(0).optional(), costMinor: z.number().int().min(0).optional(),
    // The worker reads it from the worktree; it is what reviewers are asked to look at.
    headSha: z.string().regex(/^[0-9a-f]{40}$/).optional(),
    // A review turn: the head its own detached worktree was verified to be at before the engine started and after it ended.
    // An approval recorded in the turn counts only when both are the task's current head.
    headShaStart: z.string().regex(/^[0-9a-f]{40}$/).optional(), headShaEnd: z.string().regex(/^[0-9a-f]{40}$/).optional(),
    prUrl: z.string().url().max(500).optional(),
    // The task's branch as it was pushed to the code host, so its checks can be matched to the task.
    branch: z.string().regex(/^[\w./-]{1,200}$/).optional(),
    delivery: z.object({ state: z.enum(['merged', 'blocked']), reason: z.string().max(500), mergeAttempted: z.boolean(), mergeCommit: z.string().optional() }).optional(),
  }),
});
// Said before and after an operation that writes the primary checkout's shared git state (worktree add, remove, prune, fetch, gc):
// a lease lost in between leaves the checkout, and not only the task, in an unknown state.
export const GitAdminBody = LeaseBody.extend({ state: z.enum(['begin', 'end']) });
// A worker asks which of the tasks it keeps review worktrees for are over, so it can remove them.
export const TaskStatesBody = z.object({ workerId: WorkerId, projectId: z.string().min(1).max(200), taskKeys: z.array(z.string().min(1).max(200)).max(200) });
// Posted the moment the engine names its session, so the next turn of the same agent and task can resume it.
export const SessionBody = LeaseBody.extend({ sessionId: z.string().min(1).max(200), baseSha: z.string().regex(/^[0-9a-f]{40}$/).optional() });
// Text a trace step carries beside its title: a git diff, run output or think text, already redacted and clipped by the worker.
export const StepArtifactKind = z.enum(['diff', 'output', 'think', 'image', 'stream']);
export type StepArtifactKind = z.infer<typeof StepArtifactKind>;
// The most a worker sends and the coordinator keeps, per kind. An image is a screenshot the engine's browser tool left behind and
// a stream is the raw engine stream of the whole turn, archived once when the turn ends.
export const STEP_ARTIFACT_LIMITS: Record<StepArtifactKind, number> = { diff: 64 * 1024, output: 1024 * 1024, think: 2 * 1024, image: 8 * 1024 * 1024, stream: 4 * 1024 * 1024 };
// Text up to this size stays in the database row; anything larger, and everything that is not text, goes to the artifact store.
export const STEP_ARTIFACT_INLINE_BYTES = 16 * 1024;
// The raw stream belongs to the turn, not to a step: it is filed under this sequence number, which no step has.
export const STREAM_ARTIFACT_SEQ = -1;
