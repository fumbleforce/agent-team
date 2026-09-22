import { z } from 'zod';
import { TurnKind } from './enums.ts';

// Why a queued item did not start the last time the scheduler looked at it. The Workload page shows it verbatim.
export const DeferReason = z.enum(['agent-paused', 'task-blocked', 'task-closed', 'task-quarantined', 'checkout-quarantined', 'writer-busy', 'writers-busy', 'lane-busy', 'delivery-busy', 'provider-unavailable', 'provider-limited', 'provider-busy', 'provider-window', 'over-cap', 'over-budget', 'project-paused', 'no-worktree-holder', 'no-request', 'deferred']);
export type DeferReason = z.infer<typeof DeferReason>;

const Percent = z.number().int().min(1).max(100);
// Cost rules are toggles with one number each; the amounts themselves live on agents (daily cap) and budgets.
export const CostRules = z.object({
  // An agent over its daily cap waits for tomorrow, or moves to the named provider when one is given.
  dailyCap: z.object({ enabled: z.boolean().default(true), fallbackProvider: z.string().max(80).nullable().default(null) }).prefault({}),
  // One warning in the project's discussion when spend crosses this share of the budget.
  budgetWarn: z.object({ enabled: z.boolean().default(true), percent: Percent.default(80) }).prefault({}),
  // Agents of paused projects stop once their provider's usage window is this full.
  windowPause: z.object({ enabled: z.boolean().default(true), percent: Percent.default(90) }).prefault({}),
});
export type CostRules = z.infer<typeof CostRules>;

// How hard a task looked to the decision model, when the platform has one; a rule may apply only to some levels.
export const Difficulty = z.enum(['trivial', 'standard', 'hard']);
export type Difficulty = z.infer<typeof Difficulty>;
// First enabled route whose kinds, tags and difficulty match wins. Empty kinds, tags or difficulty match everything.
export const Route = z.object({ id: z.string().min(1).max(40), enabled: z.boolean().default(true), kinds: z.array(TurnKind).max(12).default([]), tags: z.array(z.string().min(1).max(40)).max(20).default([]), difficulty: z.array(Difficulty).max(3).default([]), provider: z.string().min(1).max(80), model: z.string().max(120).nullable().default(null) });
export type Route = z.infer<typeof Route>;
export const RoutingRules = z.object({ routes: z.array(Route).max(50).default([]) });
export type RoutingRules = z.infer<typeof RoutingRules>;

export const RuleKind = z.enum(['cost_rules', 'routing_rules']);
export type RuleKind = z.infer<typeof RuleKind>;

export const BudgetBody = z.object({ scope: z.enum(['org', 'project']), scopeId: z.string().max(80).default(''), period: z.literal('month').default('month'), amountMinor: z.number().int().min(0).max(1_000_000_000).nullable() });
export const RebalanceMove = z.object({ workItemId: z.string(), fromAgentId: z.string(), toAgentId: z.string() });
export type RebalanceMove = z.infer<typeof RebalanceMove>;
export const RebalanceApplyBody = z.object({ moves: z.array(RebalanceMove).min(1).max(50) });
