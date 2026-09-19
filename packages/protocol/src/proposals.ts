import { z } from 'zod';
import { Stance } from './enums.ts';

export const ProposalCategory = z.enum(['hire', 'retire', 'composition', 'limits', 'roles', 'direction', 'routing']);
export type ProposalCategory = z.infer<typeof ProposalCategory>;

// What a proposal would change, as data the platform can apply. Categories without a machine-applicable change are recorded only.
export const ProposalChange = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('set_daily_cap'), agentId: z.string(), capMinor: z.number().int().min(0) }),
  z.object({ kind: z.literal('add_role'), agentId: z.string(), role: z.string().max(40) }),
  z.object({ kind: z.literal('retire_agent'), agentId: z.string() }),
  z.object({ kind: z.literal('none') }),
]);
export type ProposalChange = z.infer<typeof ProposalChange>;

export const ProposalInput = z.object({
  category: ProposalCategory, title: z.string().min(1).max(160), why: z.string().min(1).max(1600), whatChanges: z.string().min(1).max(1600),
  change: ProposalChange.default({ kind: 'none' }), evidence: z.array(z.object({ label: z.string().max(80), value: z.string().max(40) })).max(6).default([]),
});
export type ProposalInput = z.infer<typeof ProposalInput>;
export const ProposalVote = z.object({ stance: Stance, note: z.string().min(1).max(400) });

// What the team may apply on its own; everything else reaches a human.
export const DelegationRules = z.object({
  autoApply: z.array(ProposalCategory).default(['limits', 'roles', 'routing']),
  maxDailyCapMinor: z.number().int().min(0).default(1500),
});
export type DelegationRules = z.infer<typeof DelegationRules>;

export function withinBounds(rules: DelegationRules, category: ProposalCategory, change: ProposalChange): boolean {
  if (!rules.autoApply.includes(category)) return false;
  if (change.kind === 'retire_agent') return false;
  return change.kind !== 'set_daily_cap' || change.capMinor <= rules.maxDailyCapMinor;
}
