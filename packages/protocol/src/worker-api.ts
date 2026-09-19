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
    tokensIn: z.number().int().min(0).optional(), tokensOut: z.number().int().min(0).optional(), costMinor: z.number().int().min(0).optional(),
    // The worker reads it from the worktree; it is what reviewers are asked to look at.
    headSha: z.string().regex(/^[0-9a-f]{40}$/).optional(),
    prUrl: z.string().url().max(500).optional(),
    delivery: z.object({ state: z.enum(['merged', 'blocked']), reason: z.string().max(500), mergeAttempted: z.boolean(), mergeCommit: z.string().optional() }).optional(),
  }),
});
