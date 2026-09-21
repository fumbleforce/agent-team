import { z } from 'zod';
import { Stance } from './enums.ts';

const Line = (max: number) => z.string().min(1).max(max);

export const Proposal = z.object({
  question: Line(200),
  summary: Line(960),
  options: z.array(z.object({ id: z.string().max(20), title: Line(120), detail: z.string().max(400).optional() })).max(4).default([]),
  recommendation: z.string().max(20).optional(),
  rationale: z.string().max(1600).optional(),
  reviewers: z.array(z.string()).max(3).default([]),
  urgency: z.enum(['blocking', 'normal']).default('normal'),
  // Who decides once feedback is in. `team`: the project manager does, and may escalate. `me`: the owner of the work asks for
  // advice and decides; the feedback arrives in its next work turn and nobody else spends a turn on it.
  decides: z.enum(['team', 'me']).default('team'),
});
// Advice is asked of few and answered fast: it must be cheaper than getting it wrong.
export const MAX_ADVISERS = 2;
export const ADVICE_WINDOW_MS = 5 * 60_000;
export type Proposal = z.infer<typeof Proposal>;

// One block per reviewer: a stance and a few points, never a conversation.
export const FeedbackBlock = z.object({
  stance: Stance,
  points: z.array(Line(240)).min(1).max(4),
  risks: z.array(z.object({ risk: Line(200), severity: z.enum(['low', 'med', 'high']), mitigation: z.string().max(200).optional() })).max(3).default([]),
  conditions: z.array(Line(200)).max(3).default([]),
  confidence: z.enum(['low', 'med', 'high']).default('med'),
  blocking: z.boolean().default(false),
}).refine(block => JSON.stringify(block).length <= 2400, 'A feedback block stays under 1200 characters of prose');
export type FeedbackBlock = z.infer<typeof FeedbackBlock>;

export const Revision = z.object({ summary: Line(960), changes: Line(960) });
export const Conclusion = z.object({
  outcome: z.enum(['accept', 'accept_with_changes', 'reject', 'defer', 'escalate']),
  decision: Line(960),
  rationale: z.string().max(1280).optional(),
  dissent: z.array(z.object({ agentId: z.string(), note: Line(240) })).max(6).default([]),
});
export type Conclusion = z.infer<typeof Conclusion>;

export const MAX_REVIEWERS = 3;
export const FEEDBACK_WINDOW_MS = { blocking: 10 * 60_000, normal: 60 * 60_000 } as const;

// A revision is warranted only when feedback asks for one.
export function needsRevision(blocks: { stance: string; blocking: boolean; conditions: number }[]): boolean {
  if (blocks.length === 0) return false;
  return blocks.some(block => block.blocking || block.conditions > 0) || blocks.filter(block => block.stance === 'against').length * 2 >= blocks.length;
}
export const quorum = (selected: number) => Math.max(1, Math.ceil(selected / 2));
