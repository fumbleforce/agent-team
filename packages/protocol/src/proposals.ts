import { z } from 'zod';
import { Stance } from './enums.ts';

export const ProposalCategory = z.enum(['hire', 'retire', 'composition', 'limits', 'roles', 'direction', 'routing']);
export type ProposalCategory = z.infer<typeof ProposalCategory>;

const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
// A seat made for the job when nobody in the library fits. It never carries the PM flag: moving that is the owner's own action.
export const NewSeat = z.object({ name: z.string().trim().min(1).max(60), title: z.string().trim().max(80).default(''), persona: z.string().trim().max(2000).default(''), roles: z.array(Slug).min(1).max(12) });
export type NewSeat = z.infer<typeof NewSeat>;

// What a proposal would change, as data the platform can apply. Categories without a machine-applicable change are recorded only.
export const ProposalChange = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('set_daily_cap'), agentId: z.string(), capMinor: z.number().int().min(0) }),
  z.object({ kind: z.literal('add_role'), agentId: z.string(), role: z.string().max(40) }),
  z.object({ kind: z.literal('retire_agent'), agentId: z.string() }),
  z.object({ kind: z.literal('hire_agent'), library: Slug, name: z.string().trim().min(1).max(60).optional() }),
  z.object({ kind: z.literal('create_agent'), seat: NewSeat }),
  z.object({ kind: z.literal('change_seat'), agentId: z.string(), title: z.string().trim().max(80).optional(), persona: z.string().trim().max(2000).optional(), roles: z.array(Slug).min(1).max(12).optional() }),
  z.object({ kind: z.literal('set_status'), agentId: z.string(), status: z.enum(['active', 'paused']) }),
  z.object({ kind: z.literal('staff_from_template'), template: Slug }),
  z.object({ kind: z.literal('none') }),
]);
export type ProposalChange = z.infer<typeof ProposalChange>;

// A change is filed under what it does, whatever its proposer called it, so a hire cannot pass as a change of limits.
const CATEGORY_OF: Record<Exclude<ProposalChange['kind'], 'none'>, ProposalCategory> = { set_daily_cap: 'limits', add_role: 'roles', change_seat: 'roles', retire_agent: 'retire', hire_agent: 'hire', create_agent: 'hire', set_status: 'composition', staff_from_template: 'composition' };
export const categoryOf = (change: ProposalChange, stated: ProposalCategory): ProposalCategory => (change.kind === 'none' ? stated : CATEGORY_OF[change.kind]);

const Evidence = z.array(z.object({ label: z.string().max(80), value: z.string().max(40) })).max(6).default([]);
export const ProposalInput = z.object({
  category: ProposalCategory, title: z.string().min(1).max(160), why: z.string().min(1).max(1600), whatChanges: z.string().min(1).max(1600),
  change: ProposalChange.default({ kind: 'none' }), evidence: Evidence,
});
export type ProposalInput = z.infer<typeof ProposalInput>;
export const ProposalVote = z.object({ stance: Stance, note: z.string().min(1).max(400) });

// A staffing decision by whoever holds the staffing permission: no vote, one change, and the reason in words the owner will read.
export const StaffingDecision = z.object({ title: z.string().min(1).max(160), why: z.string().min(1).max(1600), change: ProposalChange.refine(change => change.kind !== 'none', 'Name the change to make'), evidence: Evidence });
export type StaffingDecision = z.infer<typeof StaffingDecision>;

// What the team may apply on its own; everything else reaches a human.
export const DelegationRules = z.object({
  autoApply: z.array(ProposalCategory).default(['limits', 'roles', 'routing']),
  maxDailyCapMinor: z.number().int().min(0).default(1500),
  // What the seat that staffs the team may do without asking: whether it decides at all, and how large the team may grow.
  staffing: z.object({ decides: z.boolean().default(true), maxSeats: z.number().int().min(1).max(40).default(8) }).prefault({}),
});
export type DelegationRules = z.infer<typeof DelegationRules>;
export const StaffingLimitsBody = z.object({ decides: z.boolean(), maxSeats: z.number().int().min(1).max(40) });

export function withinBounds(rules: DelegationRules, category: ProposalCategory, change: ProposalChange): boolean {
  if (!rules.autoApply.includes(categoryOf(change, category))) return false;
  // A vote settles caps, an added role and what is only recorded. Who sits on the team is for a human or the seat that staffs it.
  if (!['set_daily_cap', 'add_role', 'none'].includes(change.kind)) return false;
  return change.kind !== 'set_daily_cap' || change.capMinor <= rules.maxDailyCapMinor;
}
