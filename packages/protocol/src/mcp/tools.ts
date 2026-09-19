import { z } from 'zod';
import { Conclusion, FeedbackBlock, Proposal, Revision } from '../deliberation.ts';
import { MessageKind, type TurnKind } from '../enums.ts';
import { ProposalInput, ProposalVote } from '../proposals.ts';

const Words = (max: number) => z.string().min(1).max(max * 8);
const ALL: readonly TurnKind[] = ['work', 'review', 'feedback', 'revise', 'conclude', 'triage', 'reply', 'retro', 'ideate'];

export interface ToolSpec<I extends z.ZodType = z.ZodType> { description: string; input: I; turnKinds: readonly TurnKind[]; mutating: boolean; maxCallsPerTurn: number }
const tool = <I extends z.ZodType>(spec: ToolSpec<I>) => spec;

// The single registry of what an agent can do on the platform. Handlers and tools/list are typed from it.
export const TOOLS = {
  'thread.read': tool({
    description: 'Read recent messages of a thread in this project.',
    input: z.object({ threadId: z.string(), afterSeq: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(50).default(30) }),
    turnKinds: ALL, mutating: false, maxCallsPerTurn: 30,
  }),
  'discussion.post': tool({
    description: 'Post one note to a thread. Keep it under 120 words; use deliberation tools for proposals and feedback.',
    input: z.object({ threadId: z.string(), kind: MessageKind.extract(['note', 'claim', 'blocker', 'handoff']).default('note'), body: Words(120) }),
    turnKinds: ['work', 'conclude', 'triage', 'reply', 'retro'], mutating: true, maxCallsPerTurn: 6,
  }),
  'task.list': tool({
    description: 'List tasks of this project, optionally only your own.',
    input: z.object({ mine: z.boolean().default(false) }),
    turnKinds: ALL, mutating: false, maxCallsPerTurn: 30,
  }),
  'task.update': tool({
    description: 'Report on the task of this turn. A summary is required; it is what a later turn resumes from.',
    input: z.object({ state: z.enum(['checkpoint', 'ready_for_review', 'blocked']), summary: Words(120), blockedReason: z.string().max(200).optional() }),
    turnKinds: ['work'], mutating: true, maxCallsPerTurn: 10,
  }),
  'knowledge.search': tool({
    description: 'Search the knowledge pages and memories of this project before asking a teammate or guessing.',
    input: z.object({ query: z.string().min(2).max(200) }),
    turnKinds: ALL, mutating: false, maxCallsPerTurn: 30,
  }),
  'knowledge.read': tool({
    description: 'Read a knowledge page found by knowledge.search.',
    input: z.object({ pageId: z.string() }),
    turnKinds: ALL, mutating: false, maxCallsPerTurn: 30,
  }),
  'knowledge.propose_memory': tool({
    description: 'File something the team should not have to learn twice: a gotcha, an observation, a convention or a decision. It is reviewed before it is injected into later turns.',
    input: z.object({ type: z.enum(['observation', 'gotcha', 'decision', 'convention']), title: z.string().min(1).max(160), body: z.string().min(1).max(2000) }),
    turnKinds: ALL, mutating: true, maxCallsPerTurn: 5,
  }),
  'proposal.create': tool({
    description: 'Propose a change to the team itself: a hire, a retirement, roles, limits, routing or direction. Give the reason and evidence; teammates vote, and what is outside the delegated bounds goes to the owner.',
    input: ProposalInput,
    turnKinds: ['work', 'retro', 'conclude', 'triage'], mutating: true, maxCallsPerTurn: 2,
  }),
  'proposal.vote': tool({
    description: 'Vote once on a team proposal with a stance and one reason.',
    input: z.object({ proposalId: z.string(), vote: ProposalVote }),
    turnKinds: ALL, mutating: true, maxCallsPerTurn: 5,
  }),
  'test.report': tool({
    description: 'Report a test or check run you executed: counts and the failing cases. Non-software checks use the same shape.',
    input: z.object({ suite: z.string().min(1).max(60), kind: z.enum(['test', 'check']).default('test'), branch: z.string().min(1).max(200), sha: z.string().regex(/^[0-9a-f]{40}$/).optional(), passed: z.number().int().min(0), failed: z.number().int().min(0), skipped: z.number().int().min(0).default(0), durationMs: z.number().int().min(0).default(0), failing: z.array(z.object({ name: z.string().min(1).max(300), message: z.string().max(1000).optional() })).max(50).default([]) }),
    turnKinds: ['work', 'review'], mutating: true, maxCallsPerTurn: 10,
  }),
  'task.review': tool({
    description: 'Record your verdict on the task at the head you reviewed. Pass only what you verified yourself; findings go back to the author.',
    input: z.object({ kind: z.enum(['tester', 'reviewer', 'pm']), verdict: z.enum(['pass', 'changes', 'fail']), headSha: z.string().regex(/^[0-9a-f]{40}$/), summary: Words(100), findings: z.array(z.object({ severity: z.enum(['low', 'med', 'high']), path: z.string().max(300).optional(), note: z.string().min(1).max(240) })).max(10).default([]) }),
    turnKinds: ['review'], mutating: true, maxCallsPerTurn: 1,
  }),
  'deliberation.propose': tool({
    description: 'Ask the team to weigh in on a decision you cannot make alone. Think it through first; you get one block of feedback per reviewer and at most one revision. With urgency blocking, end your turn afterwards.',
    input: Proposal.extend({ threadId: z.string() }),
    turnKinds: ['work', 'triage'], mutating: true, maxCallsPerTurn: 1,
  }),
  'deliberation.feedback': tool({
    description: 'Give your one block of feedback on a proposal, from your own role: a stance, up to four points, risks and conditions.',
    input: z.object({ deliberationId: z.string(), block: FeedbackBlock }),
    turnKinds: ['feedback'], mutating: true, maxCallsPerTurn: 1,
  }),
  'deliberation.revise': tool({
    description: 'Revise your proposal once, answering the feedback.',
    input: z.object({ deliberationId: z.string(), revision: Revision }),
    turnKinds: ['revise'], mutating: true, maxCallsPerTurn: 1,
  }),
  'deliberation.conclude': tool({
    description: 'Decide. Address every against or blocking block in dissent; use escalate when the decision is outside what the team may decide.',
    input: z.object({ deliberationId: z.string(), conclusion: Conclusion }),
    turnKinds: ['conclude'], mutating: true, maxCallsPerTurn: 1,
  }),
} as const;

export type ToolName = keyof typeof TOOLS;
export type ToolInput<N extends ToolName> = z.infer<(typeof TOOLS)[N]['input']>;
export const isToolName = (name: string): name is ToolName => Object.hasOwn(TOOLS, name);
