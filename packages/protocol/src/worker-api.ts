import { z } from 'zod';
import { TraceKind } from './enums.ts';

const WorkerId = z.string().regex(/^[\w.-]{1,128}$/);
export const LeaseBody = z.object({ workerId: WorkerId, leaseToken: z.string().min(20) });
export const ClaimBody = z.object({
  workerId: WorkerId,
  free: z.object({ work: z.number().int().min(0), bounded: z.number().int().min(0), deliver: z.number().int().min(0) }).partial(),
  projects: z.array(z.string()).max(100),
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
    tokensIn: z.number().int().min(0).optional(), tokensOut: z.number().int().min(0).optional(), costMinor: z.number().int().min(0).optional(),
    // The worker reads it from the worktree; it is what reviewers are asked to look at.
    headSha: z.string().regex(/^[0-9a-f]{40}$/).optional(),
    prUrl: z.string().url().max(500).optional(),
    delivery: z.object({ state: z.enum(['merged', 'blocked']), reason: z.string().max(500), mergeAttempted: z.boolean(), mergeCommit: z.string().optional() }).optional(),
  }),
});
// Posted the moment the engine names its session, so the next turn of the same agent and task can resume it.
export const SessionBody = LeaseBody.extend({ sessionId: z.string().min(1).max(200), baseSha: z.string().regex(/^[0-9a-f]{40}$/).optional() });
// Text a trace step carries beside its title: a git diff, run output or think text, already redacted and clipped by the worker.
export const StepArtifactKind = z.enum(['diff', 'output', 'think']);
export type StepArtifactKind = z.infer<typeof StepArtifactKind>;
export const STEP_ARTIFACT_LIMITS: Record<StepArtifactKind, number> = { diff: 64 * 1024, output: 16 * 1024, think: 2 * 1024 };
