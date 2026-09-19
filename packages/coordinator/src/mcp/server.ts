import { z } from 'zod';
import { isToolName, TOOLS, type ToolInput, type ToolName, type TurnKind } from '@agent-team/protocol';
import { sameSecret, turnTokenFromHash } from '../auth/secrets.ts';
import type { Context } from '../context.ts';
import type { Workspace } from '../repos/workspace.ts';
import type { Deliberation } from '../runtime/deliberation.ts';
import type { Reviews } from '../runtime/reviews.ts';
import type { Knowledge, Scope } from '../knowledge/knowledge.ts';
import { createChecks } from '../checks/checks.ts';
import { createProposals } from '../runtime/proposals.ts';
import { HttpError } from '../context.ts';

interface Turn { id: string; agent_id: string; project_id: string; task_id: string | null; kind: string }
class ToolError extends Error {}
type Handlers = { [N in ToolName]: (turn: Turn, input: ToolInput<N>) => Promise<unknown> };

const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

// Tools-only MCP over plain JSON-RPC. Every call re-checks the lease, the turn kind and the project.
export function createMcp(context: Context, workspace: Workspace, deliberation: Deliberation, reviews: Reviews, knowledge: Knowledge) {
  const { storage, events, now } = context;
  const db = storage.db;
  const checks = createChecks(context);
  const proposals = createProposals(context);

  async function authenticate(header: string | undefined): Promise<Turn | null> {
    const match = /^Bearer (turn\.([0-9a-f-]{36})\.[\w-]+)$/.exec(header ?? '');
    if (!match) return null;
    const turn = await db.selectFrom('turns').selectAll().where('id', '=', match[2]!).executeTakeFirst();
    if (!turn || turn.state !== 'running' || Number(turn.lease_until) < now()) return null;
    return sameSecret(match[1]!, turnTokenFromHash(context.machineToken, turn.id, turn.lease_token_hash)) ? turn : null;
  }

  const allowed = (turn: Turn) => (Object.keys(TOOLS) as ToolName[]).filter(name => (TOOLS[name].turnKinds as readonly TurnKind[]).includes(turn.kind as TurnKind));

  // A turn sees the knowledge of its own project and of the project above it.
  async function scopesOf(turn: Turn): Promise<Scope[]> {
    const project = await db.selectFrom('projects').select(['id', 'parent_id']).where('id', '=', turn.project_id).executeTakeFirstOrThrow();
    return project.parent_id ? [{ type: 'subproject', id: project.id }, { type: 'project', id: project.parent_id }] : [{ type: 'project', id: project.id }];
  }

  async function threadInProject(turn: Turn, threadId: string) {
    const thread = await workspace.thread(threadId).catch(() => null);
    if (!thread || thread.project_id !== turn.project_id || thread.visibility !== 'team') throw new ToolError('Thread not found in this project');
    return thread;
  }

  const handlers: Handlers = {
    'thread.read': async (turn, input) => {
      const thread = await threadInProject(turn, input.threadId);
      return workspace.messages(thread.id, { ...(input.afterSeq !== undefined ? { after: input.afterSeq } : {}), limit: input.limit });
    },
    'discussion.post': async (turn, input) => {
      const thread = await threadInProject(turn, input.threadId);
      return { messageId: await workspace.postMessage({ kind: 'agent', id: turn.agent_id }, thread, { body: input.body, kind: input.kind }) };
    },
    'task.list': async (turn, input) => {
      let query = db.selectFrom('tasks').select(['id', 'key', 'title', 'state', 'assignee_agent_id']).where('project_id', '=', turn.project_id);
      if (input.mine) query = query.where('assignee_agent_id', '=', turn.agent_id);
      return query.orderBy('priority').limit(100).execute();
    },
    'task.update': async (turn, input) => {
      if (!turn.task_id) throw new ToolError('This turn has no task');
      const state = input.state === 'ready_for_review' ? 'in_review' : input.state === 'blocked' ? 'blocked' : 'in_progress';
      const published = await storage.transaction(async tx => {
        await tx.updateTable('tasks').set({ state, blocked_reason: input.state === 'blocked' ? (input.blockedReason ?? 'blocked') : null, updated_at: now() }).where('id', '=', turn.task_id!).execute();
        await tx.updateTable('turns').set({ summary: input.summary }).where('id', '=', turn.id).execute();
        return events.append(tx, [{ type: 'task.state_changed', actorKind: 'agent', agentId: turn.agent_id, projectId: turn.project_id, taskId: turn.task_id, turnId: turn.id, payload: { to: state, summary: input.summary } }]);
      });
      events.published(published);
      return { state };
    },
    'knowledge.search': async (turn, input) => knowledge.search(await scopesOf(turn), input.query),
    'knowledge.read': async (turn, input) => {
      const page = await db.selectFrom('kb_pages').select(['scope_type', 'scope_id']).where('id', '=', input.pageId).executeTakeFirst();
      if (!page || !(await scopesOf(turn)).some(scope => scope.type === page.scope_type && scope.id === page.scope_id)) throw new ToolError('Page not found in this project');
      return knowledge.read(input.pageId, { agentId: turn.agent_id, turnId: turn.id });
    },
    'knowledge.propose_memory': async (turn, input) => ({ memoryId: await knowledge.fileMemory({ scope: (await scopesOf(turn))[0]!, agentId: turn.agent_id, ...input }) }),
    'proposal.create': async (turn, input) => proposals.create(turn, input),
    'proposal.vote': async (turn, input) => proposals.vote(turn, input.proposalId, input.vote),
    'test.report': async (turn, input) => checks.record({ projectId: turn.project_id, suite: input.suite, kind: input.kind, branch: input.branch, sha: input.sha ?? null, source: 'agent', report: { passed: input.passed, failed: input.failed, skipped: input.skipped, total: input.passed + input.failed + input.skipped, durationMs: input.durationMs, failing: input.failing.map(item => ({ name: item.name, status: 'failed' as const, message: item.message ?? null })) } }),
    'task.review': async (turn, input) => reviews.record(turn, input),
    'deliberation.propose': async (turn, input) => { const { threadId, ...proposal } = input; await threadInProject(turn, threadId); return deliberation.propose(turn, threadId, proposal); },
    'deliberation.feedback': async (turn, input) => { await deliberation.feedback(turn, input.deliberationId, input.block); return { recorded: true }; },
    'deliberation.revise': async (turn, input) => { await deliberation.revise(turn, input.deliberationId, input.revision); return { recorded: true }; },
    'deliberation.conclude': async (turn, input) => { await deliberation.conclude(turn, input.deliberationId, input.conclusion); return { recorded: true }; },
  };

  async function callTool(turn: Turn, name: string, args: unknown) {
    if (!isToolName(name) || !allowed(turn).includes(name)) throw new ToolError(`Tool ${name} is not available in a ${turn.kind} turn`);
    const spec = TOOLS[name];
    const parsed = spec.input.safeParse(args ?? {});
    if (!parsed.success) throw new ToolError(z.prettifyError(parsed.error));
    // Counted from the log, so the limit survives a coordinator restart.
    const calls = await db.selectFrom('events').select(eb => eb.fn.countAll<number>().as('n')).where('turn_id', '=', turn.id).where('type', '=', 'tool.called').executeTakeFirstOrThrow();
    if (Number(calls.n) >= 200) throw new ToolError('Tool call limit for this turn reached; stop calling tools');
    const result = await (handlers[name] as (turn: Turn, input: unknown) => Promise<unknown>)(turn, parsed.data);
    const logged = await storage.transaction(tx => events.append(tx, [{ type: 'tool.called', category: 'trace', actorKind: 'agent', agentId: turn.agent_id, projectId: turn.project_id, turnId: turn.id, payload: { tool: name, mutating: spec.mutating } }]));
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
        const result = await callTool(turn, String(params?.name ?? ''), params?.arguments);
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
