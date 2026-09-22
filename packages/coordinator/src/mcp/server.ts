import { createDuties } from '../runtime/duties.ts';
import { createDocuments } from '../runtime/documents.ts';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { isToolName, MAX_TOOL_CALLS_PER_TURN, PermissionGrant, permits, RATE_LIMITS, TOOLS, type ToolInput, type ToolName, type ToolOutput, type TurnKind } from '@agent-team/protocol';
import { sameSecret, turnTokenFromHash } from '../auth/secrets.ts';
import type { Context } from '../context.ts';
import type { Workspace } from '../repos/workspace.ts';
import type { Deliberation } from '../runtime/deliberation.ts';
import type { Reviews } from '../runtime/reviews.ts';
import type { Knowledge, Scope } from '../knowledge/knowledge.ts';
import type { Issues } from '../repos/issues.ts';
import type { Integrations } from '../repos/integrations.ts';
import type { Mentions } from '../runtime/mentions.ts';
import type { Turns } from '../runtime/turns.ts';
import { createChecks } from '../checks/checks.ts';
import { createCosts } from '../costs/costs.ts';
import { createActions } from './actions.ts';
import { createProposals } from '../runtime/proposals.ts';
import { HttpError } from '../context.ts';
import { ideationOf } from '../sync/tracker.ts';

interface Turn { id: string; work_item_id: string; agent_id: string; project_id: string; task_id: string | null; kind: string; grants: string }
class ToolError extends Error {}
type Handlers = { [N in ToolName]: (turn: Turn, input: ToolInput<N>) => Promise<ToolOutput<N>> };
export interface McpDeps { workspace: Workspace; deliberation: Deliberation; reviews: Reviews; knowledge: Knowledge; turns: Turns; issues: Issues; integrations: Integrations; mentions: Mentions }

const RECORDED = { recorded: true } as const;
// A log entry that names no step and no outcome says nothing: refuse it whole, before anything is written.
const NOTHING_SAID = new Set(['done', 'ok', 'okay', 'completed', 'complete', 'finished', 'in progress', 'working on it', 'wip', 'started', 'picked up', 'took it', 'nothing to report']);
const saysNothing = (summary: string) => NOTHING_SAID.has(summary.trim().toLowerCase().replace(/[.!?]+$/, '').replace(/\s+/g, ' '));
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
// Keys sorted at every level, so the same arguments hash the same however the client ordered them.
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value !== null && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}` : JSON.stringify(value) ?? 'null';
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

// Tools-only MCP over plain JSON-RPC. Every call re-checks the lease, the turn kind, the frozen grants and the project;
// mutations are remembered by key, so a retried call returns what the first one returned.
export function createMcp(context: Context, deps: McpDeps) {
  const { workspace, deliberation, reviews, knowledge, turns, issues, integrations, mentions } = deps;
  const { storage, events, now } = context;
  const db = storage.db;
  const checks = createChecks(context);
  const proposals = createProposals(context, turns);
  const costs = createCosts(context);
  const actions = createActions(context, turns);
  const documents = createDocuments(context, turns);
  const duties = createDuties(context, turns);

  async function authenticate(header: string | undefined): Promise<Turn | null> {
    const match = /^Bearer (turn\.([0-9a-f-]{36})\.[\w-]+)$/.exec(header ?? '');
    if (!match) return null;
    const turn = await db.selectFrom('turns').selectAll().where('id', '=', match[2]!).executeTakeFirst();
    if (turn?.state !== 'running' || Number(turn.lease_until) < now()) return null;
    return sameSecret(match[1]!, turnTokenFromHash(context.machineToken, turn.id, turn.lease_token_hash)) ? turn : null;
  }

  // The grants were frozen on the turn at claim; a role edited since does not widen or narrow a running turn.
  const grantsOf = (turn: Turn) => PermissionGrant.parse(JSON.parse(turn.grants));
  const allowed = (turn: Turn) => { const grants = grantsOf(turn); return (Object.keys(TOOLS) as ToolName[]).filter(name => (TOOLS[name].turnKinds as readonly TurnKind[]).includes(turn.kind as TurnKind) && permits(grants, TOOLS[name].permission)); };

  // A turn sees the knowledge of its own project and of the project above it.
  async function scopesOf(turn: Turn): Promise<Scope[]> {
    const project = await db.selectFrom('projects').select(['id', 'parent_id']).where('id', '=', turn.project_id).executeTakeFirstOrThrow();
    return project.parent_id ? [{ type: 'subproject', id: project.id }, { type: 'project', id: project.parent_id }] : [{ type: 'project', id: project.id }];
  }

  async function threadInProject(turn: Turn, threadId: string) {
    const thread = await workspace.thread(threadId).catch(() => null);
    // A private thread is open only to the reply turn it caused: no other turn, of this agent or any other, can read or write it.
    const own = thread && thread.visibility !== 'team' ? (await db.selectFrom('work_items').select('thread_id').where('id', '=', turn.work_item_id).executeTakeFirst())?.thread_id === threadId && turn.kind === 'reply' : false;
    if (!thread || thread.project_id !== turn.project_id || (thread.visibility !== 'team' && !own)) throw new ToolError('Thread not found in this project');
    return thread;
  }

  async function issueInProject(turn: Turn, number: number) {
    const issue = await issues.get(turn.project_id, number).catch(() => null);
    if (!issue) throw new ToolError(`Issue #${number} not found in this project`);
    return issue;
  }

  // A reply turn that answers a mention speaks once, in the thread it was asked in.
  async function replying<T extends { messageId: string }>(turn: Turn, threadId: string, post: () => Promise<T>): Promise<T> {
    const owed = turn.kind === 'reply' ? await mentions.owedBy(turn.id) : null;
    if (owed && owed.thread_id !== threadId) throw new ToolError('Answer in the thread you were mentioned in');
    if (owed && owed.state !== 'woken') throw new ToolError('This mention is already answered; a mention gets one reply');
    const posted = await post();
    if (owed) await mentions.answer(owed.id, posted.messageId);
    return posted;
  }

  // Every entity a call names must be in the turn's project; feedback and review turns are held to their own subject.
  async function confine(turn: Turn, input: Record<string, unknown>) {
    if (typeof input.deliberationId === 'string') {
      const row = await db.selectFrom('deliberations').select(['project_id', 'thread_id', 'task_id']).where('id', '=', input.deliberationId).executeTakeFirst();
      if (!row || row.project_id !== turn.project_id) throw new ToolError('Deliberation not found in this project');
      const item = await db.selectFrom('work_items').select('thread_id').where('id', '=', turn.work_item_id).executeTakeFirst();
      if ((turn.kind === 'feedback' || turn.kind === 'review') && ((item?.thread_id && item.thread_id !== row.thread_id) || (turn.task_id ?? null) !== row.task_id)) throw new ToolError('This turn is about another deliberation');
    }
    if (typeof input.taskId === 'string') {
      const task = await db.selectFrom('tasks').select('project_id').where('id', '=', input.taskId).executeTakeFirst();
      if (!task || task.project_id !== turn.project_id) throw new ToolError('Task not found in this project');
      if ((turn.kind === 'feedback' || turn.kind === 'review') && input.taskId !== turn.task_id) throw new ToolError('This turn is about another task');
    }
    if (typeof input.proposalId === 'string' && (await db.selectFrom('proposals').select('project_id').where('id', '=', input.proposalId).executeTakeFirst())?.project_id !== turn.project_id) throw new ToolError('Proposal not found in this project');
  }

  const handlers: Handlers = {
    'thread.read': async (turn, input) => {
      const thread = await threadInProject(turn, input.threadId);
      return workspace.messages(thread.id, { ...(input.afterSeq !== undefined ? { after: input.afterSeq } : {}), limit: input.limit });
    },
    'discussion.post': async (turn, input) => {
      const thread = await threadInProject(turn, input.threadId);
      return replying(turn, thread.id, async () => ({ messageId: await workspace.postMessage({ kind: 'agent', id: turn.agent_id }, thread, { body: input.body, kind: input.kind }) }));
    },
    'agent.mention': async (turn, input) => {
      const thread = await threadInProject(turn, input.threadId);
      const result = await mentions.mention({ projectId: turn.project_id, threadId: thread.id, message: { body: input.body }, author: { kind: 'agent', id: turn.agent_id }, targets: [input.target], expects: input.expects, turnId: turn.id });
      return { messageId: result.messageId, mentions: result.mentions.map(item => ({ mentionId: item.mentionId, agentId: item.agentId, state: item.state, reason: item.reason })) };
    },
    'task.list': async (turn, input) => {
      let query = db.selectFrom('tasks').select(['id', 'key', 'title', 'state', 'assignee_agent_id']).where('project_id', '=', turn.project_id);
      if (input.mine) query = query.where('assignee_agent_id', '=', turn.agent_id);
      return query.orderBy('priority').limit(100).execute();
    },
    'task.update': async (turn, input) => {
      if (!turn.task_id) throw new ToolError('This turn has no task');
      if (saysNothing(input.summary)) throw new ToolError('This summary cannot be logged: it names no step and no outcome. Say what was done — the task, the concrete step or file it touched, what happened and how it ended.');
      const kind = (await db.selectFrom('tasks').select('result_kind').where('id', '=', turn.task_id).executeTakeFirst())?.result_kind;
      if (kind === 'document' && input.state === 'ready_for_review' && !input.document) throw new ToolError('The result of this task is a document: write it with knowledge.write, then pass its path as `document`.');
      if (kind !== 'document' && input.document) throw new ToolError('This task ends in a change, not a document; leave `document` out.');
      const state = input.state === 'ready_for_review' ? (input.document ? 'in_progress' : 'in_review') : input.state === 'blocked' ? 'blocked' : input.state === 'not_needed' ? 'canceled' : 'in_progress';
      const published = await storage.transaction(async tx => {
        // The journal is the owner's own record of where the task stands; the next turn starts from it on whatever worker runs it.
        const journal = JSON.stringify({ standing: input.summary, next: input.next ?? null, open: input.open ?? null, turnId: turn.id, at: now() });
        await tx.updateTable('tasks').set({ state, journal, blocked_reason: input.state === 'blocked' ? (input.blockedReason ?? 'blocked') : null, updated_at: now() }).where('id', '=', turn.task_id!).execute();
        await tx.updateTable('turns').set({ summary: input.summary }).where('id', '=', turn.id).execute();
        // Closed as not needed: nothing of it waits to be merged, and the report it came from is closed with it.
        if (state === 'canceled') {
          await tx.updateTable('merge_queue').set({ state: 'blocked', reason: 'The task was closed as not needed', finished_at: now() }).where('task_id', '=', turn.task_id!).where('state', 'in', ['queued', 'uncertain']).execute();
          const issue = await tx.selectFrom('links').select('from_id').where('from_type', '=', 'issue').where('to_type', '=', 'task').where('to_id', '=', turn.task_id!).executeTakeFirst();
          if (issue) await tx.updateTable('issues').set({ state: 'closed', closed_at: now() }).where('id', '=', issue.from_id).execute();
        }
        return events.append(tx, [{ type: 'task.state_changed', actorKind: 'agent', agentId: turn.agent_id, projectId: turn.project_id, taskId: turn.task_id, turnId: turn.id, payload: { to: state, summary: input.summary } }]);
      });
      events.published(published);
      // A task that ends in a document hands in the page it wrote; from here it is reviewed at that revision.
      if (input.state === 'ready_for_review' && input.document) return { state: (await documents.submit(turn, input.document)).state };
      return { state };
    },
    'document.review': async (turn, input) => documents.review(turn, input),
    'notebook.write': async (turn, input) => {
      await db.updateTable('agents').set({ notebook: input.text.trim() || null }).where('id', '=', turn.agent_id).execute();
      return { saved: true };
    },
    'knowledge.search': async (turn, input) => knowledge.search(await scopesOf(turn), input.query, 10, { countHits: true }),
    'knowledge.read': async (turn, input) => {
      const page = await db.selectFrom('kb_pages').select(['scope_type', 'scope_id']).where('id', '=', input.pageId).executeTakeFirst();
      if (!page || !(await scopesOf(turn)).some(scope => scope.type === page.scope_type && scope.id === page.scope_id)) throw new ToolError('Page not found in this project');
      return knowledge.read(input.pageId, { agentId: turn.agent_id, turnId: turn.id });
    },
    'knowledge.propose_memory': async (turn, input) => ({ memoryId: await knowledge.fileMemory({ scope: (await scopesOf(turn))[0]!, agentId: turn.agent_id, ...input }) }),
    'proposal.create': async (turn, input) => proposals.create(turn, input),
    'proposal.vote': async (turn, input) => proposals.vote(turn, input.proposalId, input.vote),
    'staffing.review': async (turn, input) => proposals.review(turn, input.days),
    'staffing.decide': async (turn, input) => proposals.staff(turn, input),
    'test.report': async (turn, input) => checks.record({ projectId: turn.project_id, suite: input.suite, kind: input.kind, branch: input.branch, sha: input.sha ?? null, source: 'agent', report: { passed: input.passed, failed: input.failed, skipped: input.skipped, total: input.passed + input.failed + input.skipped, durationMs: input.durationMs, failing: input.failing.map(item => ({ name: item.name, status: 'failed' as const, message: item.message ?? null })), quarantined: input.quarantined.map(name => ({ name, status: 'skipped' as const, message: null })) } }),
    // From an agent's turn a verdict is pending until the worker reports the head it verified.
    // The reviewer does not have to know the commit id: the turn was given the head under review, and the worker reports the head it really ran at.
    'task.review': async (turn, input) => {
      const head = input.headSha ?? (turn.task_id ? (await db.selectFrom('tasks').select('head_sha').where('id', '=', turn.task_id).executeTakeFirst())?.head_sha : null);
      if (!head) throw new ToolError('This task has no published head to review yet');
      return reviews.record(turn, { ...input, headSha: head }, { verification: 'worker' });
    },
    'deliberation.propose': async (turn, input) => { const { threadId, ...proposal } = input; await threadInProject(turn, threadId); return deliberation.propose(turn, threadId, proposal); },
    'deliberation.feedback': async (turn, input) => { await deliberation.feedback(turn, input.deliberationId, input.block); return RECORDED; },
    'deliberation.stand': async (turn, input) => { await deliberation.stand(turn, input.deliberationId, input.reason); return RECORDED; },
    'deliberation.revise': async (turn, input) => { await deliberation.revise(turn, input.deliberationId, input.revision); return RECORDED; },
    'deliberation.conclude': async (turn, input) => { await deliberation.conclude(turn, input.deliberationId, input.conclusion); return RECORDED; },
    'task.create': (turn, input) => actions.createTask(turn, input),
    'duty.set': async (turn, input) => {
      const me = await db.selectFrom('agents').select('is_pm').where('id', '=', turn.agent_id).executeTakeFirstOrThrow();
      if (!me.is_pm) throw new ToolError('Only the PM gives out standing duties.');
      return duties.set(turn.project_id, input);
    },
    'desk.handover': async (turn, input) => { await threadInProject(turn, input.threadId); return actions.handover(turn, input); },
    'triage.decide': async (turn, input) => { await threadInProject(turn, input.threadId); return actions.triage(turn, input); },
    'retro.submit': async (turn, input) => {
      const item = await db.selectFrom('work_items').select('thread_id').where('id', '=', turn.work_item_id).executeTakeFirst();
      if (!item?.thread_id) throw new ToolError('This turn has no retro thread');
      return actions.retro(turn, (await threadInProject(turn, item.thread_id)).id, input);
    },
    // Ideas are recorded here and published by the next tracker poll, which knows the backlog cap and what already exists.
    'ideas.propose': async (turn, input) => {
      const config = ideationOf(JSON.parse((await db.selectFrom('projects').select('manifest').where('id', '=', turn.project_id).executeTakeFirstOrThrow()).manifest) as { ideation?: unknown });
      if (!config) throw new ToolError('Ideation is not enabled for this project');
      if (input.proposals.length > config.batchSize) throw new ToolError(`At most ${config.batchSize} ideas per turn`);
      if (new Set(input.proposals.map(proposal => proposal.title.normalize('NFKC').toLowerCase())).size !== input.proposals.length) throw new ToolError('Two ideas share a title');
      const published = await storage.transaction(tx => events.append(tx, [{ type: 'ideation.proposed', actorKind: 'agent', agentId: turn.agent_id, projectId: turn.project_id, turnId: turn.id, payload: { proposals: input.proposals } }]));
      events.published(published);
      return { recorded: input.proposals.length };
    },
    'task.claim': async (turn, input) => actions.claim(turn, input.taskId),
    'task.assign': (turn, input) => actions.assign(turn, input),
    'task.handoff': async (turn, input) => actions.handoff(turn, input),
    'issue.create': async (turn, input) => {
      const created = await issues.create(null, turn.project_id, { title: input.title, body: input.body, source: 'discussion', markers: [] }, turn.agent_id);
      // Like an issue a person raises, it goes to the PM, unless the PM filed it.
      const pm = await workspace.pm(turn.project_id);
      if (pm && pm !== turn.agent_id) await turns.enqueue({ agentId: pm, projectId: turn.project_id, kind: 'triage', threadId: created.threadId, dedupeKey: `triage:${created.threadId}` });
      // @name and @role in the body are directed requests like anywhere else; naming nobody reachable is not an error here.
      await mentions.fromText({ projectId: turn.project_id, threadId: created.threadId, message: { id: created.messageId }, author: { kind: 'agent', id: turn.agent_id }, body: input.body, turnId: turn.id }).catch(() => []);
      return created;
    },
    'issue.comment': async (turn, input) => {
      const issue = await issueInProject(turn, input.number);
      return replying(turn, issue.thread_id, async () => ({ messageId: await workspace.postMessage({ kind: 'agent', id: turn.agent_id }, { id: issue.thread_id, project_id: turn.project_id }, { body: input.body, kind: 'note' }) }));
    },
    'issue.link': async (turn, input) => {
      const issue = await issueInProject(turn, input.number);
      const scopes = await scopesOf(turn);
      const target = input.to.type === 'page' ? await db.selectFrom('kb_pages').select(['scope_type', 'scope_id']).where('id', '=', input.to.id).executeTakeFirst()
        : await db.selectFrom(({ task: 'tasks', issue: 'issues', decision: 'decisions', thread: 'threads' } as const)[input.to.type]).select('project_id').where('id', '=', input.to.id).executeTakeFirst();
      const inside = target && ('project_id' in target ? target.project_id === turn.project_id : scopes.some(scope => scope.type === target.scope_type && scope.id === target.scope_id));
      if (!inside || (input.to.type === 'issue' && input.to.id === issue.id)) throw new ToolError(`That ${input.to.type} is not in this project`);
      await actions.link(turn, issue.id, input.to, input.rel);
      return { linked: true as const };
    },
    'knowledge.write': async (turn, input) => knowledge.write({ kind: 'agent', id: turn.agent_id }, { scope: (await scopesOf(turn))[0]!, path: input.path, title: input.title, body: input.body, note: input.note, expectedRev: input.expectedRev }),
    'cost.status': async turn => {
      const agent = await db.selectFrom('agents').select('daily_cap_minor').where('id', '=', turn.agent_id).executeTakeFirstOrThrow();
      const spentTodayMinor = await costs.spentToday(turn.agent_id), today = day(now());
      const month = await costs.summary([turn.project_id], `${today.slice(0, 8)}01`, today);
      return { agent: { spentTodayMinor, dailyCapMinor: agent.daily_cap_minor, remainingMinor: agent.daily_cap_minor === null ? null : Math.max(0, agent.daily_cap_minor - spentTodayMinor) }, project: { monthMinor: month.totalMinor, budgetMinor: month.budgetMinor } };
    },
    'handoff.send': async (turn, input) => ({ handoffId: await integrations.send(turn.agent_id, turn.project_id, input) }),
  };

  // Reserves the call before it runs: the sequence number, the per-tool limit of its rate class and the turn's total are
  // all counted from tool_calls. A key seen before returns the stored result, or refuses when that outcome never landed.
  async function reserve(turn: Turn, name: ToolName, argsHash: string, key: string | null): Promise<{ seq: number } | { replay: unknown }> {
    return storage.transaction(async tx => {
      const prior = key ? await tx.selectFrom('tool_calls').select(['tool', 'args_hash', 'result']).where('turn_id', '=', turn.id).where('idempotency_key', '=', key).executeTakeFirst() : null;
      if (prior && (prior.tool !== name || prior.args_hash !== argsHash)) throw new ToolError('This idempotency key was used for a different call');
      if (prior) { if (prior.result === null) throw new ToolError('The first attempt of this call has no known outcome; do not retry it, report it instead'); return { replay: JSON.parse(prior.result) }; }
      const rows = await tx.selectFrom('tool_calls').select(['tool', 'seq']).where('turn_id', '=', turn.id).execute();
      if (rows.length >= MAX_TOOL_CALLS_PER_TURN) throw new ToolError('Tool call limit for this turn reached; stop calling tools');
      const limit = RATE_LIMITS[TOOLS[name].rateClass];
      if (rows.filter(row => row.tool === name).length >= limit) throw new ToolError(`${name} may be called ${limit === 1 ? 'once' : `${limit} times`} per turn`);
      const seq = rows.reduce((max, row) => Math.max(max, row.seq), 0) + 1;
      await tx.insertInto('tool_calls').values({ turn_id: turn.id, seq, tool: name, args_hash: argsHash, idempotency_key: key, result: null, created_at: now() }).execute();
      return { seq };
    });
  }

  async function callTool(turn: Turn, name: string, args: unknown, givenKey: unknown) {
    if (!isToolName(name) || !allowed(turn).includes(name)) throw new ToolError(`Tool ${name} is not available to this ${turn.kind} turn`);
    const spec = TOOLS[name];
    const parsed = spec.input.safeParse(args ?? {});
    if (!parsed.success) throw new ToolError(z.prettifyError(parsed.error));
    if (givenKey !== undefined && (typeof givenKey !== 'string' || givenKey.length === 0 || givenKey.length > 200)) throw new ToolError('idempotencyKey is a string of at most 200 characters');
    await confine(turn, parsed.data as Record<string, unknown>);
    const text = canonical(parsed.data);
    // Reads are not replayed: they are logged for the limits only.
    const reserved = await reserve(turn, name, sha256(text), spec.mutating ? (givenKey as string | undefined) ?? sha256(`${turn.id}\n${name}\n${text}`) : null);
    if ('replay' in reserved) return reserved.replay;
    let result: unknown;
    try {
      result = spec.output.parse(await (handlers[name] as (turn: Turn, input: unknown) => Promise<unknown>)(turn, parsed.data));
    } catch (error) {
      // A refusal changed nothing, so the same call may be made again later; it still counts against the limits.
      if (error instanceof HttpError || error instanceof ToolError) await db.updateTable('tool_calls').set({ idempotency_key: null, result: JSON.stringify({ refused: error.message }) }).where('turn_id', '=', turn.id).where('seq', '=', reserved.seq).execute();
      throw error;
    }
    const logged = await storage.transaction(async tx => {
      await tx.updateTable('tool_calls').set({ result: spec.mutating ? JSON.stringify(result) : '{}' }).where('turn_id', '=', turn.id).where('seq', '=', reserved.seq).execute();
      return events.append(tx, [{ type: 'tool.called', category: 'trace', actorKind: 'agent', agentId: turn.agent_id, projectId: turn.project_id, turnId: turn.id, payload: { tool: name, seq: reserved.seq, mutating: spec.mutating } }]);
    });
    events.published(logged);
    return result;
  }

  return {
    async handle(authorization: string | undefined, request: unknown): Promise<{ status: number; body: unknown }> {
      const turn = await authenticate(authorization);
      if (!turn) return { status: 401, body: rpcError(null, -32001, 'Turn token missing, invalid or expired') };
      const rpc = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number()]).optional(), method: z.string(), params: z.record(z.string(), z.unknown()).optional() }).safeParse(request);
      if (!rpc.success) return { status: 400, body: rpcError(null, -32600, 'Invalid request') };
      const { id, method, params } = rpc.data;
      if (id === undefined) return { status: 202, body: null };
      if (method === 'initialize') return { status: 200, body: { jsonrpc: '2.0', id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'platform', version: '1' } } } };
      if (method === 'tools/list') return { status: 200, body: { jsonrpc: '2.0', id, result: { tools: allowed(turn).map(name => ({ name, description: TOOLS[name].description, inputSchema: z.toJSONSchema(TOOLS[name].input, { io: 'input' }) })) } } };
      if (method !== 'tools/call') return { status: 200, body: rpcError(id, -32601, 'Method not found') };
      try {
        const result = await callTool(turn, String(params?.name ?? ''), params?.arguments, params?.idempotencyKey);
        return { status: 200, body: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } } };
      } catch (error) {
        // Protocol refusals (one block, one revision, dissent not addressed) are the agent's to read, not failures.
        if (error instanceof HttpError) return { status: 200, body: { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: error.message }] } } };
        if (!(error instanceof ToolError)) console.error(error);
        return { status: 200, body: { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: error instanceof ToolError ? error.message : 'Internal error' }] } } };
      }
    },
  };
}
