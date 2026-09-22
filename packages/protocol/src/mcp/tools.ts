import { z } from 'zod';
import { Conclusion, FeedbackBlock, Proposal, Revision } from '../deliberation.ts';
import { MessageKind, type TurnKind } from '../enums.ts';
import { PermissionGrant } from '../permissions.ts';
import { ProposalInput, ProposalVote, StaffingDecision } from '../proposals.ts';
import { Charter, OrgPlan } from '../orgPlan.ts';
import { DeliverableSubmission, DeliverableTarget } from '../deliverables.ts';

const Words = (max: number) => z.string().min(1).max(max * 8);
const ALL: readonly TurnKind[] = ['work', 'review', 'feedback', 'revise', 'conclude', 'triage', 'reply', 'retro', 'ideate'];
const Recorded = z.object({ recorded: z.literal(true) });

// One idea for the backlog, in the shape the owner reads it in the tracker.
export const IdeaProposal = z.object({ title: z.string().trim().min(1).max(160), problem: z.string().trim().min(1).max(800), benefit: z.string().trim().min(1).max(600), scope: z.string().trim().min(1).max(1200),
  successCriteria: z.array(z.string().trim().min(1).max(400)).min(1).max(6), effort: z.enum(['S', 'M', 'L']), evidence: z.array(z.string().trim().min(1).max(400)).min(1).max(6), whyNow: z.string().trim().min(1).max(600),
  // The figure of the scorecard this should move, and which way: what the team looks at afterwards to say whether the idea was worth it.
  measure: z.object({ figure: z.string().regex(/^[A-Z]\d{1,2}$/), expect: z.enum(['up', 'down']) }).optional() });
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
export type ToolPermission = 'issues:comment' | 'issues:edit' | 'comms:post' | 'staffing:decide' | 'org:plan' | null;
export function permits(grants: PermissionGrant, permission: ToolPermission): boolean {
  if (permission === null) return true;
  const [key, least] = permission.split(':') as ['issues' | 'comms' | 'staffing' | 'org', string];
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
    description: 'Report on the task of this turn. A summary is required; it is what a later turn resumes from. The summary is a log entry a reader must be able to audit on its own: name the task, the concrete step or file it touched, what actually happened and the outcome. A bare "done" or "completed" is refused: a line that cannot say what was done does not get logged. When the result of the task is a document, ready_for_review takes `document`: the path of the knowledge page you wrote, which is then reviewed as it reads at that moment. With checkpoint, say in `next` what you will do in your next turn, which then starts at once, and in `open` what is still undecided: together they are the task\'s journal, the only thing your next turn is sure to have. not_needed closes the task: use it only when the base branch already contains what the task was for, and say where in the summary.',
    input: z.object({ state: z.enum(['checkpoint', 'ready_for_review', 'blocked', 'not_needed']), summary: Words(120), blockedReason: z.string().max(200).optional(), next: z.string().max(600).optional(), open: z.string().max(600).optional(), document: z.string().min(4).max(200).optional() }),
    output: z.object({ state: z.string() }),
    permission: null, turnKinds: ['work'], mutating: true, rateClass: 'write',
  }),
  'document.review': tool({
    description: 'Record your verdict on the document under review, as it reads in your packet. pass means you would stand behind it going out as it is; changes means it must change first, and each finding says what and why. Judge whether it does what the task is for. The summary is a log entry: say what you looked at and what you found; a bare "pass" or "ok" is refused.',
    input: z.object({ verdict: z.enum(['pass', 'changes']), summary: Words(80), findings: z.array(z.object({ severity: z.enum(['must', 'should']), note: z.string().min(1).max(400) })).max(8).default([]) }),
    output: z.object({ recorded: z.boolean(), state: z.string() }),
    permission: null, turnKinds: ['review'], mutating: true, rateClass: 'once',
  }),
  'notebook.write': tool({
    description: 'Replace your notebook: what you, in this seat, have learned that your later turns on any task should know (how this project is built and tested, what the owner cares about, mistakes not to repeat). It is given to every turn of yours, so keep it short and current: rewrite it, do not append to it. Not for the state of a task; that goes in task.update.',
    input: z.object({ text: z.string().max(2400) }),
    output: z.object({ saved: z.boolean() }),
    permission: null, turnKinds: ['work', 'review', 'feedback', 'revise', 'conclude', 'triage', 'reply', 'retro', 'ideate'], mutating: true, rateClass: 'few',
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
  'skill.read': tool({
    description: 'Read one of your skills in full (its method, before the work it is for), or one of the files it names.',
    input: z.object({ name: z.string().min(1).max(63), file: z.string().max(160).optional() }),
    output: z.object({ name: z.string(), description: z.string(), body: z.string(), files: z.array(z.string()) }).or(z.object({ name: z.string(), file: z.string(), content: z.string() })),
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
  'staffing.review': tool({
    description: 'The team as it stands, for whoever staffs it: every seat with its roles and its figures over the last days (turns, failures, spend, tasks finished and open, work waiting, reviews that asked for changes), what you may decide without the owner, and who and what can be brought in: library agents, team templates and the role library. Read it before any staffing decision.',
    input: z.object({ days: z.number().int().min(1).max(60).default(14) }),
    output: z.object({
      limits: z.object({ decides: z.boolean(), maxSeats: z.number(), maxDailyCapMinor: z.number() }),
      seats: z.array(z.object({ agentId: z.string(), name: z.string(), title: z.string(), roles: z.array(z.string()), status: z.string(), isPm: z.boolean(), dailyCapMinor: z.number().nullable(), turns: z.number(), failed: z.number(), spentMinor: z.number(), tasksDone: z.number(), tasksOpen: z.number(), waiting: z.number(), changesRequested: z.number() })),
      library: z.array(z.object({ slug: z.string(), name: z.string(), title: z.string(), roles: z.array(z.string()), summary: z.string() })),
      templates: z.array(z.object({ slug: z.string(), name: z.string(), summary: z.string(), seats: z.number() })),
      roles: z.array(z.object({ slug: z.string(), summary: z.string() })),
    }),
    permission: 'staffing:decide', turnKinds: ['work', 'reply', 'retro', 'triage', 'conclude'], mutating: false, rateClass: 'few',
  }),
  'staffing.decide': tool({
    description: 'Make one staffing decision: hire from the library (hire_agent), make a new seat from roles in the role library (create_agent), retire a seat (retire_agent), change the title, persona or roles of a seat (change_seat), pause or resume one (set_status), set a daily cap (set_daily_cap), or add the seats of a template to the team (staff_from_template). Inside what the owner allows it takes effect at once; otherwise it waits for the owner, and the result says which. Say why in words the owner can check, with figures from staffing.review as evidence. For advice without a change, use proposal.create.',
    input: StaffingDecision,
    output: z.object({ proposalId: z.string(), state: z.enum(['applied', 'needs_owner']), note: z.string().nullable(), agentIds: z.array(z.string()) }),
    permission: 'staffing:decide', turnKinds: ['work', 'reply', 'retro', 'triage', 'conclude'], mutating: true, rateClass: 'few',
  }),
  'test.report': tool({
    description: 'Report a test or check run you executed: counts, the failing cases, and the names of cases skipped because they are quarantined as flaky. Non-software checks use the same shape.',
    input: z.object({ suite: z.string().min(1).max(60), kind: z.enum(['test', 'check']).default('test'), branch: z.string().min(1).max(200), sha: z.string().regex(/^[0-9a-f]{40}$/).optional(), passed: z.number().int().min(0), failed: z.number().int().min(0), skipped: z.number().int().min(0).default(0), durationMs: z.number().int().min(0).default(0), failing: z.array(z.object({ name: z.string().min(1).max(300), message: z.string().max(1000).optional() })).max(50).default([]), quarantined: z.array(z.string().min(1).max(300)).max(200).default([]) }),
    output: z.object({ id: z.string(), status: z.string() }),
    permission: null, turnKinds: ['work', 'review'], mutating: true, rateClass: 'write',
  }),
  'task.review': tool({
    description: 'Record your verdict on the task as it stands in the folder you were given, which is checked out at the head under review. Pass only what you verified yourself; findings go back to the author. The summary is a log entry: say what you checked and what you found; a bare "pass" or "ok" is refused.',
    input: z.object({ kind: z.enum(['tester', 'reviewer', 'pm']), verdict: z.enum(['pass', 'changes', 'fail']), headSha: z.string().regex(/^[0-9a-f]{40}$/).optional(), summary: Words(100), findings: z.array(z.object({ severity: z.enum(['low', 'med', 'high']), path: z.string().max(300).optional(), note: z.string().min(1).max(240) })).max(10).default([]) }),
    output: z.object({ approved: z.boolean() }),
    permission: null, turnKinds: ['review'], mutating: true, rateClass: 'once',
  }),
  'deliberation.propose': tool({
    description: 'Ask colleagues to weigh in. With decides "me" it is advice on your own work: up to two colleagues each give one block of feedback without seeing the other\'s, it reaches you in your next turn, and the decision stays yours; use it as a senior colleague would, when a second view is worth a few minutes, not for what you can settle yourself. With decides "team" (the default) it is a decision you cannot make alone: the project manager decides after feedback and at most one revision. With urgency blocking, end your turn afterwards.',
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
    description: 'Settle what was raised in this thread: answer (a plain reply, not recorded as a decision), accept with an owner (it becomes a task on the board for that owner; give a title when the thread is not an issue), decline, duplicate, or escalate to the owner of the project. On an issue this is its decision.',
    input: z.object({ threadId: z.string(), outcome: z.enum(['answer', 'accept', 'decline', 'duplicate', 'escalate']), decision: Words(120), ownerAgentId: z.string().optional(), priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(), title: z.string().trim().min(3).max(140).optional() }),
    output: z.object({ decisionId: z.string().nullable(), messageId: z.string(), taskId: z.string().nullable().optional() }),
    permission: null, turnKinds: ['triage'], mutating: true, rateClass: 'once',
  }),
  'retro.submit': tool({
    description: 'Your one retro note: what went well in a line, and at most three problems, each with evidence and a suggestion.',
    input: z.object({ wentWell: z.string().min(1).max(300), problems: z.array(z.object({ problem: z.string().min(1).max(240), evidence: z.string().min(1).max(240), suggestion: z.string().min(1).max(240) })).max(3).default([]) }),
    output: z.object({ messageId: z.string() }),
    permission: null, turnKinds: ['retro'], mutating: true, rateClass: 'once',
  }),
  'duty.set': tool({
    description: 'PM only. Give a teammate a standing duty: something that comes round (every morning, every Monday) and that they own without being asked, such as watching the checks, reading what users reported, or reviewing a campaign\'s figures. Each time it comes round it opens a task for them, unless the last one is still open. Say what done looks like each time in the brief. With a deliverable it asks for a number of them each time (4 records, 3 messages to send, 2 changes merged) and counts those a teammate approved. everyHours 0 ends the duty.',
    input: z.object({ title: z.string().trim().min(3).max(120), brief: z.string().trim().min(1).max(2000), ownerAgentId: z.string(), everyHours: z.number().int().min(0).max(24 * 31), result: z.enum(['change', 'document']).default('document'), deliverable: DeliverableTarget.optional() }),
    output: z.object({ dutyId: z.string().nullable(), state: z.string() }),
    permission: null, turnKinds: ['triage', 'reply', 'conclude', 'retro'], mutating: true, rateClass: 'few',
  }),
  'ideas.propose': tool({
    description: 'Your ideas for what the team should build next, once per ideation turn. Each becomes an issue in the tracker that waits for the owner: nothing is built before the owner approves it. Ground each in what you observed (a failing check, a figure of the scorecard, a report from a user), and where a figure of the scorecard should move, name it in `measure`: that is how the team says afterwards whether the idea was worth it.',
    input: z.object({ proposals: z.array(IdeaProposal).min(1).max(10) }),
    output: z.object({ recorded: z.number().int() }),
    permission: null, turnKinds: ['ideate'], mutating: true, rateClass: 'rare',
  }),
  'desk.handover': tool({
    description: 'Front desk only. Pass what the owner asked for in this thread to the PM, with one line saying what they want. The PM triages it: it may become a task, a decision or an answer.',
    input: z.object({ threadId: z.string(), wants: Words(60) }),
    output: z.object({ messageId: z.string(), passedTo: z.string() }),
    permission: null, turnKinds: ['reply'], mutating: true, rateClass: 'once',
  }),
  'task.create': tool({
    description: 'PM only. Put a new task on the board: a title, a brief that says what done looks like, and optionally the teammate who takes it (they are started on it at once; without one it waits in the backlog). Say `result: "document"` when what is wanted is a piece of writing (a brief, a plan, a report) rather than a change to the repository: it is then written as a knowledge page, reviewed as it reads, and done when accepted, with no branch or merge. One call per task. Check task.list first so nothing is added twice.',
    input: z.object({ title: z.string().trim().min(3).max(140), brief: z.string().trim().min(1).max(4000), ownerAgentId: z.string().optional(), tag: z.string().trim().max(40).optional(), result: z.enum(['change', 'document']).default('change') }),
    output: z.object({ taskId: z.string(), key: z.string(), state: z.string() }),
    permission: null, turnKinds: ['triage', 'reply', 'conclude', 'retro'], mutating: true, rateClass: 'few',
  }),
  'task.assign': tool({
    description: 'PM only. Give a task to another teammate: one that waits in the backlog, or one that waits behind its owner\'s other work. The new owner needs a role that lets it do the work (a developer for code). A task someone is working on right now cannot be moved.',
    input: z.object({ taskId: z.string(), ownerAgentId: z.string(), why: Words(40) }),
    output: z.object({ taskId: z.string(), key: z.string(), assigneeAgentId: z.string() }),
    permission: null, turnKinds: ['triage', 'reply', 'conclude', 'retro'], mutating: true, rateClass: 'few',
  }),
  'task.claim': tool({
    description: 'Take an unassigned backlog task of this project. The claim is atomic: if a teammate got there first it is refused.',
    input: z.object({ taskId: z.string() }),
    output: z.object({ taskId: z.string(), key: z.string(), state: z.string() }),
    permission: null, turnKinds: ['work', 'triage'], mutating: true, rateClass: 'rare',
  }),
  'task.handoff': tool({
    description: 'Hand the task of this turn to a teammate, with what you did and what is left. The summary is a log entry: name the task, the step or file it touched, what happened and the outcome; a bare "done" is refused. End your turn afterwards.',
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
  'deliverable.submit': tool({
    description: 'Hand in one deliverable of the task of this turn: a card for the board, a record (a lead, a person to contact, a follow-up), a message ready to send, a piece of material (a deck, a poster) or a campaign set up and not launched. Write it so someone can act on it as it stands: the body is the thing itself, the link is where it lives outside the platform. Hand in each one as soon as it is ready; when you have handed in what the task asks for, call task.update with ready_for_review and a teammate reviews them all. Nothing you hand in is sent or published by itself.',
    input: DeliverableSubmission,
    output: z.object({ deliverableId: z.string(), handedIn: z.number().int(), target: z.number().int() }),
    permission: null, turnKinds: ['work'], mutating: true, rateClass: 'write',
  }),
  'deliverable.review': tool({
    description: 'Judge the deliverables under review, as they read in your packet: one verdict per deliverable, in one call. pass means it can go out as it stands; changes means it cannot, and the note says what is wrong. A rejected one does not count; its author is told why.',
    input: z.object({ verdicts: z.array(z.object({ deliverableId: z.string(), verdict: z.enum(['pass', 'changes']), note: z.string().trim().min(1).max(400) })).min(1).max(50) }),
    output: z.object({ approved: z.number().int(), rejected: z.number().int(), target: z.number().int(), state: z.string() }),
    permission: null, turnKinds: ['review'], mutating: true, rateClass: 'once',
  }),
  'org.review': tool({
    description: 'The organisation as it stands: every team with what it is for, its seats and their roles, its standing duties with what each should deliver and how far today is, what it is connected to and what it spent; and what can be brought in: the agent library, team templates, the role library, the tools that can be connected and the models there are. Read it before you plan.',
    input: z.object({ days: z.number().int().min(1).max(60).default(7) }),
    output: z.object({
      teams: z.array(z.object({ team: z.string(), name: z.string(), charter: Charter.nullable(), seats: z.array(z.object({ agentId: z.string(), name: z.string(), title: z.string(), roles: z.array(z.string()), status: z.string(), isPm: z.boolean() })),
        duties: z.array(z.object({ title: z.string(), owner: z.string(), everyHours: z.number(), deliverable: DeliverableTarget.nullable(), today: z.number() })), connected: z.array(z.string()), openTasks: z.number(), spentMinor: z.number() })),
      library: z.array(z.object({ slug: z.string(), name: z.string(), title: z.string(), roles: z.array(z.string()), summary: z.string() })),
      templates: z.array(z.object({ slug: z.string(), name: z.string(), summary: z.string(), seats: z.array(z.string()) })),
      roles: z.array(z.object({ slug: z.string(), summary: z.string() })),
      integrations: z.array(z.object({ integration: z.string(), title: z.string(), summary: z.string() })),
      models: z.array(z.object({ providerId: z.string(), provider: z.string(), models: z.array(z.string()) })),
    }),
    permission: 'org:plan', turnKinds: ['reply'], mutating: false, rateClass: 'few',
  }),
  'org.plan': tool({
    description: 'Put one plan in front of the owner: the changes to the organisation that do what they asked, in the order they are made. Nothing changes until the owner applies it; they see each step in plain words and apply or dismiss the whole plan. A step can name a team an earlier step creates by the $name it gave it, and a seat an earlier step brings in by its name. One plan per request; a new plan replaces the one still waiting in this thread.',
    input: OrgPlan.extend({ threadId: z.string() }),
    output: z.object({ planId: z.string(), steps: z.number().int() }),
    permission: 'org:plan', turnKinds: ['reply'], mutating: true, rateClass: 'rare',
  }),
  'org.handover': tool({
    description: 'Give a team a request or an area of responsibility to run with: its PM gets it in the team\'s discussion and decides what work it becomes. Use it for what a team does, not for who is on it.',
    input: z.object({ team: z.string().min(1).max(63), wants: Words(120) }),
    output: z.object({ messageId: z.string(), passedTo: z.string() }),
    permission: 'org:plan', turnKinds: ['reply'], mutating: true, rateClass: 'few',
  }),
} as const;

export type ToolName = keyof typeof TOOLS;
export type ToolInput<N extends ToolName> = z.infer<(typeof TOOLS)[N]['input']>;
export type ToolOutput<N extends ToolName> = z.infer<(typeof TOOLS)[N]['output']>;
export const isToolName = (name: string): name is ToolName => Object.hasOwn(TOOLS, name);
