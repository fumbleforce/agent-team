import { z } from 'zod';

// What the API answers with for the resources the web app reads most. The coordinator builds its responses against these
// types and the web app reads them, so neither side writes the shape by hand.

// An agent on a project's roster, as the sidebar, the board and the team page show it.
export const AgentView = z.object({ id: z.string(), name: z.string(), initials: z.string(), tint: z.string(), title: z.string(), persona: z.string(), status: z.string(), provider_id: z.string().nullable(), model: z.string().nullable(), is_pm: z.boolean(), doing: z.string().nullable() });
export type AgentView = z.infer<typeof AgentView>;

export const TaskCardView = z.object({ id: z.string(), key: z.string(), title: z.string(), tag: z.string().nullable(), state: z.string(), assignee_agent_id: z.string().nullable(),
  // Why a task in the backlog is not to be worked on yet (an idea waiting for its owner, say), or why a blocked one is blocked.
  blocked_reason: z.string().nullable().optional() });
export type TaskCardView = z.infer<typeof TaskCardView>;
export const BoardView = z.object({ backlog: z.array(TaskCardView), in_progress: z.array(TaskCardView), review: z.array(TaskCardView), done: z.array(TaskCardView) });
export type BoardView = z.infer<typeof BoardView>;

export const ProjectView = z.object({
  project: z.object({ id: z.string(), slug: z.string(), name: z.string(), kind: z.string(), status: z.string(), parent: z.object({ slug: z.string(), name: z.string() }).nullable() }),
  roster: z.array(AgentView), board: BoardView, discussionThreadId: z.string().nullable(),
  customTabs: z.array(z.object({ label: z.string(), url: z.string() })).optional(), seq: z.number(),
});
export type ProjectView = z.infer<typeof ProjectView>;

export const MessageView = z.object({ id: z.string(), seq: z.number(), authorKind: z.enum(['user', 'agent', 'system']), authorId: z.string().nullable(), kind: z.string(), body: z.string(), payload: z.record(z.string(), z.unknown()), createdAt: z.number() });
export type MessageView = z.infer<typeof MessageView>;
export const ThreadMessagesView = z.object({ messages: z.array(MessageView), next: z.number().nullable(), seq: z.number() });
export type ThreadMessagesView = z.infer<typeof ThreadMessagesView>;

// Costs are shown in the organization's currency. `rate` is how many of it one US dollar buys, which is what engines report in.
export const CostCurrency = z.object({ currency: z.string().regex(/^[A-Z]{3}$/), rate: z.number().positive().max(1_000_000) });
export type CostCurrency = z.infer<typeof CostCurrency>;
export const CostTotal = z.object({ id: z.string(), amountMinor: z.number(), tokens: z.number() });
export type CostTotal = z.infer<typeof CostTotal>;
export const CostsSummaryView = z.object({ currency: z.string(), rate: z.number(), totalMinor: z.number(), budgetMinor: z.number().nullable(), daily: z.array(CostTotal), byAgent: z.array(CostTotal), byProject: z.array(CostTotal) });
export type CostsSummaryView = z.infer<typeof CostsSummaryView>;

export const SeatView = z.object({ id: z.string(), name: z.string(), initials: z.string(), tint: z.string(), title: z.string(), persona: z.string(), status: z.string(), providerId: z.string().nullable(), model: z.string().nullable(), isPm: z.boolean(), roles: z.array(z.string()) });
export type SeatView = z.infer<typeof SeatView>;
export const RoleChoiceView = z.object({ slug: z.string(), summary: z.string() });
export type RoleChoiceView = z.infer<typeof RoleChoiceView>;
export const TeamView = z.object({ seats: z.array(SeatView), roles: z.array(RoleChoiceView), canEdit: z.boolean() });
export type TeamView = z.infer<typeof TeamView>;

// Harness health, derived on read from the check runs of the base branch.
export const HarnessSuiteView = z.object({ suite: z.string(), kind: z.string(), total: z.number(), failed: z.number(), quarantined: z.number(), durationMs: z.number(), at: z.number() });
export const HarnessChangeView = z.object({ at: z.number(), suite: z.string(), totalBefore: z.number(), totalAfter: z.number(), quarantinedAdded: z.array(z.string()), quarantinedRemoved: z.array(z.string()) });
export const HarnessHealthView = z.object({ branch: z.string(), totalCases: z.number(), quarantinedCases: z.array(z.object({ suite: z.string(), name: z.string() })), suites: z.array(HarnessSuiteView), changes: z.array(HarnessChangeView) });
export type HarnessHealthView = z.infer<typeof HarnessHealthView>;
