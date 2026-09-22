import { newId, Role, type EventDraft } from '@agent-team/protocol';
import type { Tx } from '@agent-team/storage';
import { confidenceOf, levelOf, type Answer, type Decision, type Question } from '../../../../adapters/decider/contract.ts';
import type { Context } from '../context.ts';
import { createCosts } from '../costs/costs.ts';
import { teamIdOf } from '../repos/issueTasks.ts';

// The decision model answers what is a classification, not a judgement, in a fraction of a second for a fraction of a cent:
// what kind of report this is and who fits it, how hard a task looks. A seat or a person still decides; the read is shown to
// them, and every read is kept so the scorecard can say how often they chose otherwise. Below UNSURE a read is shown as unsure
// and changes nothing; from SURE up it is counted as a call the model made.
export const UNSURE = 0.6, SURE = 0.85;
// Levels of difficulty, as a routing rule names them and in the order the model scores them.
export const DIFFICULTIES = ['trivial', 'standard', 'hard'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];
const DIFFICULTY_LEVELS = ['Trivial: one place to change, nothing to design, done in one short turn', 'Standard: a few files, a known shape, some checking', 'Hard: cuts across the codebase, needs design or domain knowledge, or the brief may be wrong'];
export const KINDS = { defect: 'Something that exists does not work as it should', change: 'Something that exists should work differently', request: 'Something new is wanted', question: 'A question that needs an answer, not work', duplicate: 'What is raised is already on the board', noise: 'Nothing to do: spam, a test message, or an empty report' } as const;
const SEVERITY_LEVELS = ['Cosmetic: nothing stops working', 'Degraded: a feature is broken or worse, a workaround exists', 'Blocking: no workaround'];
// What the PM's outcome would be for each kind the model can name.
export const OUTCOME_OF_KIND: Record<keyof typeof KINDS, string> = { defect: 'accept', change: 'accept', request: 'accept', question: 'answer', duplicate: 'duplicate', noise: 'decline' };
const MAX_THREAD = 6, MAX_OPEN_TASKS = 40, JUDGE_WITHIN_MS = 14 * 24 * 3600_000;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

export interface Read { purpose: string; model: string; questions: Record<string, Question>; answers: Record<string, Answer>; confidence: number; inputTokens: number; usdMicro: number }
export interface TriageRead { read: Read; kind: string | null; urgent: boolean; seat: string | null }

const lowest = (answers: Record<string, Answer>) => Object.values(answers).reduce((low, answer) => Math.min(low, confidenceOf(answer)), 1);
// A choice is taken only when it is at least a suggestion; below that the model is unsure and says nothing.
const sure = (answer: Answer | undefined, floor = UNSURE) => answer !== undefined && confidenceOf(answer) >= floor;
export const choiceOf = (answer: Answer | undefined): string | null => (answer?.type === 'choice' && sure(answer) ? answer.choice : null);
export const difficultyOf = (answer: Answer | undefined): Difficulty | null => (answer?.type === 'score' && sure(answer) ? DIFFICULTIES[Number(Object.entries(answer.probabilities).sort((a, b) => b[1] - a[1])[0]?.[0] ?? -1)] ?? null : null);

// A read as a person or a seat is shown it: one line per answer with how sure the model was, names in place of ids.
export function readLines(read: Pick<Read, 'answers'>, names: Record<string, string> = {}): string[] {
  const said = (answer: Answer) => (answer.type === 'noul' ? (answer.noul >= 0.5 ? 'yes' : 'no') : answer.type === 'choice' ? names[answer.choice] ?? answer.choice : levelOf(answer).split(':')[0]!.toLowerCase());
  return Object.entries(read.answers).map(([key, answer]) => { const confidence = confidenceOf(answer).toFixed(2); return confidenceOf(answer) < UNSURE ? `- ${key}: unsure (${said(answer)} ${confidence})` : `- ${key}: ${said(answer)} (${confidence})`; });
}

// The latest read of a thread or a task, for the packet that shows it and the tests that check it.
export async function latestRead(tx: Tx, purpose: string, ref: { threadId?: string; taskId?: string }): Promise<(Read & { id: string; createdAt: number }) | null> {
  let query = tx.selectFrom('machine_decisions').selectAll().where('purpose', '=', purpose);
  query = ref.threadId ? query.where('thread_id', '=', ref.threadId) : query.where('task_id', '=', ref.taskId ?? '');
  const row = await query.orderBy('created_at', 'desc').executeTakeFirst();
  return row ? { id: row.id, createdAt: Number(row.created_at), purpose: row.purpose, model: row.model, questions: JSON.parse(row.questions) as Record<string, Question>, answers: JSON.parse(row.answers) as Record<string, Answer>, confidence: row.confidence, inputTokens: row.input_tokens, usdMicro: row.usd_micro } : null;
}

export function createDecisions(context: Context) {
  const { storage, decider, now } = context, db = storage.db;
  const costs = createCosts(context);
  let complained = false;
  // A decider without its key yet is the same as none: nothing is gathered for a question that cannot be asked.
  const on = () => decider !== null && (decider.ready?.() ?? true);

  // Outside any transaction: the network is never held inside one. Nothing the model cannot do stops the platform.
  async function read(purpose: string, state: string | object, questions: Record<string, Question>): Promise<Read | null> {
    if (!decider || !on()) return null;
    let decision: Decision;
    try { decision = await decider.decide(state, questions); } catch (error) {
      if (!complained) { complained = true; console.error(`The decision model did not answer (${purpose}): ${(error as Error).message}`); }
      return null;
    }
    const answers = Object.fromEntries(Object.keys(questions).flatMap(key => (decision.answers[key] ? [[key, decision.answers[key]]] : [])));
    if (Object.keys(answers).length === 0) return null;
    return { purpose, model: decision.model, questions, answers, confidence: lowest(answers), inputTokens: decision.usage.inputTokens, usdMicro: decision.usage.usdMicro };
  }

  // Inside the caller's transaction, with the event the caller appends among its own: the row, the cost and the event never disagree.
  async function record(tx: Tx, read: Read, refs: { projectId: string; taskId?: string | null; threadId?: string | null; applied?: boolean }): Promise<{ id: string; event: EventDraft }> {
    const id = newId(now());
    await tx.insertInto('machine_decisions').values({ id, project_id: refs.projectId, task_id: refs.taskId ?? null, thread_id: refs.threadId ?? null, purpose: read.purpose, model: read.model, questions: JSON.stringify(read.questions), answers: JSON.stringify(read.answers), confidence: read.confidence, input_tokens: read.inputTokens, usd_micro: read.usdMicro, applied: refs.applied ?? false, judged_at: null, overturned_at: null, overturned_by: null, created_at: now() }).execute();
    // Tokens count toward the project like any turn's; the money is kept here to the millionth, since one read rounds to no cents.
    await costs.record(tx, { turnId: null, agentId: null, projectId: refs.projectId, providerId: null, billingKind: 'metered', tokensIn: read.inputTokens, tokensOut: 0, amountMinor: Math.round(read.usdMicro / 10_000) });
    const top = Object.fromEntries(Object.entries(read.answers).map(([key, answer]) => [key, answer.type === 'noul' ? answer.noul >= 0.5 : answer.type === 'choice' ? answer.choice : levelOf(answer)]));
    return { id, event: { type: 'decision.machine', actorKind: 'system', projectId: refs.projectId, taskId: refs.taskId ?? null, threadId: refs.threadId ?? null, payload: { decisionId: id, purpose: read.purpose, confidence: read.confidence, answers: top } } };
  }

  // The first read of what was raised in a thread: what it is, how bad, whether it can wait, who fits, whether it is already on the board.
  async function triage(projectId: string, threadId: string): Promise<TriageRead | null> {
    if (!on()) return null;
    const tail = await db.selectFrom('messages').select(['author_kind', 'body']).where('thread_id', '=', threadId).orderBy('seq', 'desc').limit(MAX_THREAD).execute();
    const issue = await db.selectFrom('issues').select(['title', 'body']).where('thread_id', '=', threadId).executeTakeFirst();
    if (tail.length === 0 && !issue) return null;
    const teamId = await storage.transaction(tx => teamIdOf(tx, projectId));
    const team = teamId ? await db.selectFrom('agents').select(['id', 'name', 'title', 'is_pm']).where('team_id', '=', teamId).where('status', '=', 'active').orderBy('sort').execute() : [];
    const roles = team.length ? await db.selectFrom('agent_roles').innerJoin('versioned_docs', 'versioned_docs.slug', 'agent_roles.role_slug').select(['agent_roles.agent_id', 'versioned_docs.doc']).where('versioned_docs.kind', '=', 'role').where('agent_roles.agent_id', 'in', team.map(agent => agent.id)).execute() : [];
    const held = team.length ? await db.selectFrom('tasks').select('assignee_agent_id').where('assignee_agent_id', 'in', team.map(agent => agent.id)).where('state', 'in', ['assigned', 'in_progress', 'awaiting_decision', 'in_review', 'approved', 'merging']).execute() : [];
    const open = await db.selectFrom('tasks').select(['key', 'title']).where('project_id', '=', projectId).where('state', 'not in', ['done', 'canceled', 'inbox']).orderBy('updated_at', 'desc').limit(MAX_OPEN_TASKS).execute();
    const about = (agentId: string) => { const looks = roles.filter(row => row.agent_id === agentId).map(row => Role.safeParse(JSON.parse(row.doc)).data).map(role => role?.perspective || role?.summary || '').filter(Boolean); const inHand = held.filter(task => task.assignee_agent_id === agentId).length; return `${clip(looks.join(' ') || 'no stated perspective', 400)} Has ${inHand} task${inHand === 1 ? '' : 's'} in hand.`; };
    const questions: Record<string, Question> = {
      kind: { type: 'choice', instructions: 'What is raised in `report` and `thread`?', criteria: { ...KINDS } },
      severity: { type: 'score', instructions: 'If something is broken, how badly? Cosmetic when nothing is broken.', criteria: SEVERITY_LEVELS },
      urgent: { type: 'noul', instructions: 'Does this need attention today rather than in the ordinary course of work?' },
      ...(team.length ? { seat: { type: 'choice' as const, instructions: 'Which teammate in `team` fits this best, by what their roles look for and how much they have in hand?', criteria: Object.fromEntries(team.map(agent => [agent.id, `${agent.name}, ${agent.title}${agent.is_pm ? ' (the PM, who takes only what nobody else fits)' : ''}: ${about(agent.id)}`])) } } : {}),
      ...(open.length ? { duplicateOf: { type: 'choice' as const, instructions: 'Is what is raised already one of the open tasks in `board`?', criteria: { none: 'It is not on the board', ...Object.fromEntries(open.map(task => [task.key, clip(task.title, 160)])) } } } : {}),
    };
    const state = { report: issue ? { title: issue.title, body: clip(issue.body, 6000) } : null, thread: tail.reverse().map(message => ({ from: message.author_kind, said: clip(message.body, 1200) })), team: team.map(agent => `${agent.name} (${agent.id})`), board: open.map(task => `${task.key}: ${clip(task.title, 160)}`) };
    const result = await read('triage', state, questions);
    if (!result) return null;
    const urgent = result.answers.urgent;
    return { read: result, kind: choiceOf(result.answers.kind), urgent: urgent?.type === 'noul' && urgent.noul >= 0.7, seat: choiceOf(result.answers.seat) };
  }

  // How hard a task looks from its title and brief, before its first work turn is routed.
  async function difficulty(task: { title: string; brief: string }): Promise<{ read: Read; difficulty: Difficulty | null } | null> {
    if (!on()) return null;
    const questions: Record<string, Question> = { difficulty: { type: 'score', instructions: 'How hard is the task in `title` and `brief` for one capable engineer?', criteria: DIFFICULTY_LEVELS } };
    const result = await read('difficulty', { title: task.title, brief: clip(task.brief, 8000) }, questions);
    return result ? { read: result, difficulty: difficultyOf(result.answers.difficulty) } : null;
  }

  return {
    on, read, record, triage, difficulty,

    // A triage read is judged once the PM has decided the thread: overturned when the model was sure of a kind or a seat and the
    // PM chose otherwise. Reads nobody decided within two weeks are judged as neither. Runs on the timer; the scorecard only reads.
    async sweep(): Promise<number> {
      const pending = await db.selectFrom('machine_decisions').select(['id', 'thread_id', 'answers', 'created_at']).where('purpose', '=', 'triage').where('judged_at', 'is', null).where('thread_id', 'is not', null).limit(200).execute();
      let judged = 0;
      for (const row of pending) {
        const decided = await db.selectFrom('decisions').innerJoin('messages', 'messages.id', 'decisions.message_id').select(['decisions.outcome', 'decisions.created_at', 'messages.author_id', 'messages.payload']).where('decisions.thread_id', '=', row.thread_id!).where('decisions.kind', '=', 'triage').where('decisions.created_at', '>=', Number(row.created_at)).orderBy('decisions.created_at').executeTakeFirst();
        // An answer is a note, not a decision; the read is judged by it all the same.
        const answered = decided ?? await db.selectFrom('messages').select(['created_at', 'author_id', 'payload']).where('thread_id', '=', row.thread_id!).where('kind', '=', 'note').where('payload', 'like', '%"triage":true%').where('created_at', '>=', Number(row.created_at)).orderBy('created_at').executeTakeFirst().then(note => (note ? { outcome: 'answer', created_at: note.created_at, author_id: note.author_id, payload: note.payload } : undefined));
        if (!answered) { if (now() - Number(row.created_at) > JUDGE_WITHIN_MS) { await db.updateTable('machine_decisions').set({ judged_at: now() }).where('id', '=', row.id).execute(); judged++; } continue; }
        const answers = JSON.parse(row.answers) as Record<string, Answer>, owner = (JSON.parse(answered.payload) as { ownerAgentId?: string | null }).ownerAgentId ?? null;
        const kind = answers.kind, seat = answers.seat;
        const wrongKind = kind?.type === 'choice' && sure(kind, SURE) && OUTCOME_OF_KIND[kind.choice as keyof typeof KINDS] !== answered.outcome;
        const wrongSeat = seat?.type === 'choice' && sure(seat, SURE) && answered.outcome === 'accept' && owner !== null && owner !== seat.choice;
        await db.updateTable('machine_decisions').set({ judged_at: now(), ...(wrongKind || wrongSeat ? { overturned_at: Number(answered.created_at), overturned_by: answered.author_id } : {}) }).where('id', '=', row.id).execute();
        judged++;
      }
      return judged;
    },
  };
}
