import { z } from 'zod';

export const OrgRole = z.enum(['owner', 'admin', 'member', 'viewer']);
export type OrgRole = z.infer<typeof OrgRole>;
export const ProjectRole = z.enum(['admin', 'member', 'viewer']);
export type ProjectRole = z.infer<typeof ProjectRole>;

export const ProjectStatus = z.enum(['active', 'paused', 'archived']);
export const AgentStatus = z.enum(['active', 'paused', 'retired']);
export const TaskState = z.enum(['inbox', 'backlog', 'assigned', 'in_progress', 'awaiting_decision', 'in_review', 'approved', 'merging', 'done', 'blocked', 'quarantined', 'stopped', 'canceled']);
export type TaskState = z.infer<typeof TaskState>;
export const TurnKind = z.enum(['work', 'review', 'feedback', 'revise', 'conclude', 'triage', 'reply', 'retro', 'ideate', 'publish', 'deliver', 'capture']);
export const Viewport = z.enum(['desktop', 'tablet', 'mobile']);
export type Viewport = z.infer<typeof Viewport>;
export type TurnKind = z.infer<typeof TurnKind>;
export const TurnState = z.enum(['running', 'completed', 'failed', 'deferred', 'interrupted', 'timed_out', 'uncertain']);
export type TurnState = z.infer<typeof TurnState>;
export const Lane = z.enum(['work', 'bounded', 'deliver']);
export type Lane = z.infer<typeof Lane>;
export const WorkItemState = z.enum(['queued', 'leased', 'done', 'canceled', 'expired']);
export const ThreadKind = z.enum(['discussion', 'issue', 'dm', 'proposal', 'handoff']);
export type ThreadKind = z.infer<typeof ThreadKind>;
export const MessageKind = z.enum(['note', 'claim', 'blocker', 'handoff', 'question', 'proposal', 'feedback', 'revision', 'decision', 'system']);
export type MessageKind = z.infer<typeof MessageKind>;
export const ActorKind = z.enum(['user', 'agent', 'system', 'worker']);
export type ActorKind = z.infer<typeof ActorKind>;
export const EventCategory = z.enum(['domain', 'trace', 'audit']);
export type EventCategory = z.infer<typeof EventCategory>;
export const BillingKind = z.enum(['metered', 'subscription', 'local']);
export const TraceKind = z.enum(['read', 'edit', 'run', 'think', 'message']);
export const Stance = z.enum(['for', 'against', 'neutral']);

// Board columns are a projection of task state.
export const BOARD_COLUMNS = {
  // Raised and not settled yet: a report from the product view, from a person, from an agent. Nobody works on it until it is accepted.
  inbox: ['inbox'],
  backlog: ['backlog', 'assigned'],
  in_progress: ['in_progress', 'awaiting_decision', 'blocked', 'quarantined'],
  review: ['in_review', 'approved', 'merging'],
  done: ['done'],
} as const satisfies Record<string, readonly TaskState[]>;
export type BoardColumn = keyof typeof BOARD_COLUMNS;

export function boardColumn(state: TaskState): BoardColumn | null {
  for (const [column, states] of Object.entries(BOARD_COLUMNS)) if ((states as readonly string[]).includes(state)) return column as BoardColumn;
  return null;
}
