import { z } from 'zod';
import { Conclusion, FeedbackBlock, Proposal, Revision } from '../deliberation.ts';
import { MessageKind, type TurnKind } from '../enums.ts';
import { PermissionGrant } from '../permissions.ts';
import { ProposalInput, ProposalVote } from '../proposals.ts';

const Words = (max: number) => z.string().min(1).max(max * 8);
const ALL: readonly TurnKind[] = ['work', 'review', 'feedback', 'revise', 'conclude', 'triage', 'reply', 'retro', 'ideate'];
const Recorded = z.object({ recorded: z.literal(true) });

// One idea for the backlog, in the shape the owner reads it in the tracker.
export const IdeaProposal = z.object({ title: z.string().trim().min(1).max(160), problem: z.string().trim().min(1).max(800), benefit: z.string().trim().min(1).max(600), scope: z.string().trim().min(1).max(1200),
  successCriteria: z.array(z.string().trim().min(1).max(400)).min(1).max(6), effort: z.enum(['S', 'M', 'L']), evidence: z.array(z.string().trim().min(1).max(400)).min(1).max(6), whyNow: z.string().trim().min(1).max(600) });
export type IdeaProposal = z.infer<typeof IdeaProposal>;

// Who a mention is for, and whether it asks for the one reply it may get or only informs.
export const MentionTarget = z.object({ type: z.enum(['agent', 'role', 'team', 'user']), id: z.string().min(1).max(80) });
export type MentionTarget = z.infer<typeof MentionTarget>;
export const MentionExpects = z.enum(['reply', 'fyi']);
export type MentionExpects = z.infer<typeof MentionExpects>;

// Calls per turn, per tool. Counted from tool_calls, so a limit survives a coordinator restart.
export const RATE_LIMITS = { read: 30, write: 10, post: 6, few: 5, rare: 2, once: 1 } as const;
export type RateClass = keyof typeof RATE_LIMITS;
export const MAX_TOOL_CALLS_PER_TURN = 200;

// A graded key of the grant and the least value that allows the tool; null needs no grant beyond the turn kind.
export type ToolPermission = 'issues:comment' | 'issues:edit' | 'comms:post' | null;
export function permits(grants: PermissionGrant, permission: ToolPermission): boolean {
  if (permission === null) return true;
  const [key, least] = permission.split(':') as ['issues' | 'comms', string];
  const order: readonly string[] = PermissionGrant.shape[key].unwrap().options;
  return order.indexOf(grants[key]) >= order.indexOf(least);
}

export interface ToolSpec<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> { description: string; input: I; output: O; permission: ToolPermission; turnKinds: readonly TurnKind[]; mutating: boolean; rateClass: RateClass }
const tool = <I extends z.ZodType, O extends z.ZodType>(spec: ToolSpec<I, O>) => spec;

// The single registry of what an agent can do on the platform. Handlers and tools/list are typed from it.
export const TOOLS = {
  'thread.read': tool({
    description: 'Read recent messages of a thread in this project.',
    input: z.object({ threadId: z.string(), afterSeq: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(50).default(30) }),
    output: z.array(z.object({ id: z.string(), seq: z.number(), authorKind: z.string(), authorId: z.string().nullable(), kind: z.string(), body: z.string(), payload: z.unknown(), createdAt: z.number() })),
    permission: null, turnKinds: ALL, mutating: false, rateClass: 'read',
  }),
  'discussion.post': tool({
    description: 'Post one note to a thread. Keep it under 120 words; use deliberation tools for proposals and feedback.',
    input: z.object({ threadId: z.string(), kind: MessageKind.extract(['note', 'claim', 'blocker', 'handoff']).default('note'), body: Words(120) }),
    output: z.object({ messageId: z.string() }),
    permission: null, turnKinds: ['work', 'conclude', 'triage', 'reply', 'retro'], mutating: true, rateClass: 'post',
  }),
  'task.list': tool({
    description: 'List tasks of this project, optionally only your own.',
    input: z.object({ mine: z.boolean().default(false) }),
    output: z.array(z.object({ id: z.string(), key: z.string(), title: z.string(), state: z.string(), assignee_agent_id: z.string().nullable() })),
    permission: null, turnKinds: ALL, mutating: false, rateClass: 'read',
  }),
  'task.update': tool({
    description: 'Report on the task of this turn. A summary is required; it is what a later turn resumes from.',
    input: z.object({ state: z.enum(['checkpoint', 'ready_for_review', 'blocked']), summary: Words(120), blockedReason: z.string().max(200).optional() }),
    output: z.object({ state: z.string() }),
    permission: null, turnKinds: ['work'], mutating: true, rateClass: 'write',
  }),
  'knowledge.search': tool({
    description: 'Search the knowledge pages, memories, discussion messages and issues of this project before asking a teammate or guessing. Every word must match; a word matches from its start. A message or issue hit carries its thread in `ref`.',
    input: z.object({ query: z.string().min(2).max(200) }),
    output: z.array(z.object({ type: z.string(), id: z.string(), title: z.string(), excerpt: z.string(), ref: z.string().nullable().optional() })),
    permission: null, turnKinds: ALL, mutating: false, rateClass: 'read',
  }),
  'knowledge.read': tool({
    description: 'Read a knowledge page found by knowledge.search.',
    input: z.object({ pageId: z.string() }),
    output: z.object({ id: z.string(), path: z.string(), title: z.string(), rev: z.number(), body: z.string(), authorKind: z.string(), authorId: z.string().nullable(), updatedAt: z.number(), readByToday: z.number() }),
    permission: null, turnKinds: ALL, mutating: false, rateClass: 'read',
  }),
  'knowledge.propose_memory': tool({
    description: 'File something the team should not have to learn twice: a gotcha, an observation, a convention or a decision. It is reviewed before it is injected into later turns.',
    input: z.object({ type: z.enum(['observation', 'gotcha', 'decision', 'convention']), title: z.string().min(1).max(160), body: z.string().min(1).max(2000) }),
    output: z.object({ memoryId: z.string() }),
    permission: null, turnKinds: ALL, mutating: true, rateClass: 'few',
  }),
  'proposal.create': tool({
    description: 'Propose a change to the team itself: a hire, a retirement, roles, limits, routing or direction. Give the reason and evidence; teammates vote, and what is outside the delegated bounds goes to the owner.',
    input: ProposalInput,
    output: z.object({ proposalId: z.string() }),
    permission: null, turnKinds: ['work', 'retro', 'conclude', 'triage'], mutating: true, rateClass: 'rare',
  }),
  'proposal.vote': tool({
    description: 'Vote once on a team proposal with a stance and one reason.',
    input: z.object({ proposalId: z.string(), vote: ProposalVote }),
    output: z.object({ state: z.string() }),
    permission: null, turnKinds: ALL, mutating: true, rateClass: 'few',
  }),
  'test.report': tool({
    description: 'Report a test or check run you executed: counts, the failing cases, and the names of cases skipped because they are quarantined as flaky. Non-software checks use the same shape.',
    input: z.object({ suite: z.string().min(1).max(60), kind: z.enum(['test', 'check']).default('test'), branch: z.string().min(1).max(200), sha: z.string().regex(/^[0-9a-f]{40}$/).optional(), passed: z.number().int().min(0), failed: z.number().int().min(0), skipped: z.number().int().min(0).default(0), durationMs: z.number().int().min(0).default(0), failing: z.array(z.object({ name: z.string().min(1).max(300), message: z.string().max(1000).optional() })).max(50).default([]), quarantined: z.array(z.string().min(1).max(300)).max(200).default([]) }),
    output: z.object({ id: z.string(), status: z.string() }),
    permission: null, turnKinds: ['work', 'review'], mutating: true, rateClass: 'write',
  }),
  'task.review': tool({
    description: 'Record your verdict on the task as it stands in the folder you were given, which is checked out at the head under review. Pass only what you verified yourself; findings go back to the author.',
    input: z.object({ kind: z.enum(['tester', 'reviewer', 'pm']), verdict: z.enum(['pass', 'changes', 'fail']), headSha: z.string().regex(/^[0-9a-f]{40}$/).optional(), summary: Words(100), findings: z.array(z.object({ severity: z.enum(['low', 'med', 'high']), path: z.string().max(300).optional(), note: z.string().min(1).max(240) })).max(10).default([]) }),
    output: z.object({ approved: z.boolean() }),
    permission: null, turnKinds: ['review'], mutating: true, rateClass: 'once',
  }),
  'deliberation.propose': tool({
    description: 'Ask the team to weigh in on a decision you cannot make alone. Think it through first; you get one block of feedback per reviewer and at most one revision. With urgency blocking, end your turn afterwards.',
    input: Proposal.extend({ threadId: z.string() }),
    output: z.object({ deliberationId: z.string(), reviewers: z.array(z.string()), endTurn: z.boolean() }),
    permission: null, turnKinds: ['work', 'triage'], mutating: true, rateClass: 'once',
  }),
  'deliberation.feedback': tool({
    description: 'Give your one block of feedback on a proposal, from your own role: a stance, up to four points, risks and conditions.',
    input: z.object({ deliberationId: z.string(), block: FeedbackBlock }),
    output: Recorded,
    permission: null, turnKinds: ['feedback'], mutating: true, rateClass: 'once',
  }),
  'deliberation.revise': tool({
    description: 'Revise your proposal once, answering the feedback.',
    input: z.object({ deliberationId: z.string(), revision: Revision }),
    output: Recorded,
    permission: null, turnKinds: ['revise'], mutating: true, rateClass: 'once',
  }),
  'deliberation.conclude': tool({
    description: 'Decide. Address every against or blocking block in dissent; use escalate when the decision is outside what the team may decide.',
    input: z.object({ deliberationId: z.string(), conclusion: Conclusion }),
    output: Recorded,
    permission: null, turnKinds: ['conclude'], mutating: true, rateClass: 'once',
  }),
  'agent.mention': tool({
    description: 'Ask one teammate, role or the team a directed question in a thread. They get exactly one reply turn, so ask everything at once; chains stop at two levels and overflow goes to the PM.',
    input: z.object({ threadId: z.string(), target: MentionTarget, body: Words(120), expects: MentionExpects.default('reply') }),
    output: z.object({ messageId: z.string(), mentions: z.array(z.object({ mentionId: z.string(), agentId: z.string().nullable(), state: z.enum(['woken', 'noted', 'overflow']), reason: z.string().nullable() })) }),
    permission: null, turnKinds: ['work', 'conclude', 'triage', 'reply', 'retro'], mutating: true, rateClass: 'rare',
  }),
  'deliberation.stand': tool({
    description: 'Stand aside instead of giving feedback when the question is outside your role. It counts as an abstention and is final.',
    input: z.object({ deliberationId: z.string(), reason: z.string().min(1).max(240) }),
    output: Recorded,
    permission: null, turnKinds: ['feedback'], mutating: true, rateClass: 'once',
  }),
  'triage.decide': tool({
    description: 'Record what happens with what was raised in this thread: answer, accept with an owner (an accepted issue becomes a task for that owner, linked to the issue), decline, duplicate, or escalate to the owner of the project. On an issue this is its decision.',
    input: z.object({ threadId: z.string(), outcome: z.enum(['answer', 'accept', 'decline', 'duplicate', 'escalate']), decision: Words(120), ownerAgentId: z.string().optional(), priority: z.enum(['low', 'normal', 'high', 'urgent']).optional() }),
    output: z.object({ decisionId: z.string(), messageId: z.string(), taskId: z.string().nullable().optional() }),
    permission: null, turnKinds: ['triage'], mutating: true, rateClass: 'once',
  }),
  'retro.submit': tool({
    description: 'Your one retro note: what went well in a line, and at most three problems, each with evidence and a suggestion.',
    input: z.object({ wentWell: z.string().min(1).max(300), problems: z.array(z.object({ problem: z.string().min(1).max(240), evidence: z.string().min(1).max(240), suggestion: z.string().min(1).max(240) })).max(3).default([]) }),
    output: z.object({ messageId: z.string() }),
    permission: null, turnKinds: ['retro'], mutating: true, rateClass: 'once',
  }),
  'ideas.propose': tool({
    description: 'Your ideas for what the team should build next, once per ideation turn. Each becomes an issue in the tracker that waits for the owner: nothing is built before the owner approves it.',
    input: z.object({ proposals: z.array(IdeaProposal).min(1).max(10) }),
    output: z.object({ recorded: z.number().int() }),
    permission: null, turnKinds: ['ideate'], mutating: true, rateClass: 'rare',
  }),
  'task.claim': tool({
    description: 'Take an unassigned backlog task of this project. The claim is atomic: if a teammate got there first it is refused.',
    input: z.object({ taskId: z.string() }),
    output: z.object({ taskId: z.string(), key: z.string(), state: z.string() }),
    permission: null, turnKinds: ['work', 'triage'], mutating: true, rateClass: 'rare',
  }),
  'task.handoff': tool({
    description: 'Hand the task of this turn to a teammate, with what you did and what is left. End your turn afterwards.',
    input: z.object({ toAgentId: z.string(), summary: Words(120) }),
    output: z.object({ taskId: z.string(), assigneeAgentId: z.string() }),
    permission: null, turnKinds: ['work'], mutating: true, rateClass: 'once',
  }),
  'issue.create': tool({
    description: 'File an issue for something that is not part of your task: a bug, a gap or a follow-up. The PM triages it.',
    input: z.object({ title: z.string().min(1).max(200), body: z.string().min(1).max(8000) }),
    output: z.object({ id: z.string(), number: z.number(), threadId: z.string() }),
    permission: 'issues:edit', turnKinds: ['work', 'review', 'triage', 'conclude', 'retro'], mutating: true, rateClass: 'few',
  }),
  'issue.comment': tool({
    description: 'Comment on an issue of this project by its number.',
    input: z.object({ number: z.number().int().min(1), body: Words(200) }),
    output: z.object({ messageId: z.string() }),
    permission: 'issues:comment', turnKinds: ['work', 'review', 'triage', 'conclude', 'reply'], mutating: true, rateClass: 'post',
  }),
  'issue.link': tool({
    description: 'Link an issue to a task, page, decision, thread or another issue of this project.',
    input: z.object({ number: z.number().int().min(1), to: z.object({ type: z.enum(['task', 'issue', 'page', 'decision', 'thread']), id: z.string() }), rel: z.enum(['relates', 'blocks', 'duplicates', 'fixes', 'documents']).default('relates') }),
    output: z.object({ linked: z.literal(true) }),
    permission: 'issues:edit', turnKinds: ['work', 'review', 'triage', 'conclude'], mutating: true, rateClass: 'write',
  }),
  'knowledge.write': tool({
    description: 'Write or revise a knowledge page of this project. Pass the revision you read as expectedRev so a concurrent edit is refused instead of overwritten.',
    input: z.object({ path: z.string().min(4).max(200), title: z.string().min(1).max(160), body: z.string().min(1).max(20000), note: z.string().max(200).optional(), expectedRev: z.number().int().min(1).optional() }),
    output: z.object({ id: z.string(), rev: z.number() }),
    permission: null, turnKinds: ['work', 'conclude', 'triage', 'retro'], mutating: true, rateClass: 'few',
  }),
  'cost.status': tool({
    description: 'What you spent today against your daily cap, and what the project spent this month against its budget.',
    input: z.object({}),
    output: z.object({ agent: z.object({ spentTodayMinor: z.number(), dailyCapMinor: z.number().nullable(), remainingMinor: z.number().nullable() }), project: z.object({ monthMinor: z.number(), budgetMinor: z.number().nullable() }) }),
    permission: null, turnKinds: ALL, mutating: false, rateClass: 'read',
  }),
  'handoff.send': tool({
    description: 'Hand work to someone outside the team: a named destination, a title, a summary and the context they need. It is recorded for a human to deliver; nothing is sent by itself.',
    input: z.object({ destination: z.string().min(1).max(40), title: z.string().min(1).max(200), summary: z.string().max(4000).default(''), context: z.record(z.string(), z.unknown()).default({}), taskId: z.string().optional() }),
    output: z.object({ handoffId: z.string() }),
    permission: 'comms:post', turnKinds: ['work', 'conclude', 'triage'], mutating: true, rateClass: 'rare',
  }),
} as const;

export type ToolName = keyof typeof TOOLS;
export type ToolInput<N extends ToolName> = z.infer<(typeof TOOLS)[N]['input']>;
export type ToolOutput<N extends ToolName> = z.infer<(typeof TOOLS)[N]['output']>;
export const isToolName = (name: string): name is ToolName => Object.hasOwn(TOOLS, name);
