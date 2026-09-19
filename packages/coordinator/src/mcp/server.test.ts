import test from 'node:test';
import assert from 'node:assert/strict';
import { turnToken } from '../auth/secrets.ts';
import { seedDemo } from '../demo/seed.ts';
import { createTurns } from '../runtime/turns.ts';
import { startCoordinator } from '../server.ts';

const TOKEN = 'machine-token-for-tests-0123456789';

async function boot(kind: 'work' | 'feedback') {
  const coordinator = await startCoordinator({ port: 0, storage: { kind: 'sqlite', path: ':memory:' }, machineToken: TOKEN, webRoot: null });
  await seedDemo(coordinator.context);
  const db = coordinator.context.storage.db;
  const project = await db.selectFrom('projects').select('id').where('slug', '=', 'checkout-v2').executeTakeFirstOrThrow();
  const task = await db.selectFrom('tasks').select('id').where('key', '=', 'CK-31').executeTakeFirstOrThrow();
  const agent = await db.selectFrom('agents').select('id').where('name', '=', 'Bram').executeTakeFirstOrThrow();
  const thread = await db.selectFrom('threads').select('id').where('project_id', '=', project.id).executeTakeFirstOrThrow();
  const turns = createTurns(coordinator.context);
  await turns.enqueue({ agentId: agent.id, projectId: project.id, kind, taskId: task.id });
  const claimed = (await turns.claim({ workerId: 'w1', free: { work: 1, bounded: 1 }, projects: [project.id] }))!;
  let id = 0;
  const rpc = async (method: string, params?: unknown, token = turnToken(TOKEN, claimed.turnId, claimed.leaseToken)) => {
    const response = await fetch(`${coordinator.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    return { status: response.status, json: await response.json() as any };
  };
  return { coordinator, db, rpc, turns, claimed, threadId: thread.id, taskId: task.id };
}

test('a work turn lists its tools, posts to discussion and reports on its task; every call is logged', async () => {
  const { coordinator, db, rpc, threadId, taskId } = await boot('work');
  const list = await rpc('tools/list');
  assert.deepEqual(list.json.result.tools.map((tool: any) => tool.name).sort(), ['deliberation.propose', 'discussion.post', 'knowledge.propose_memory', 'knowledge.read', 'knowledge.search', 'proposal.create', 'proposal.vote', 'task.list', 'task.update', 'test.report', 'thread.read']);
  assert.equal(list.json.result.tools[0].inputSchema.type, 'object');
  const post = await rpc('tools/call', { name: 'discussion.post', arguments: { threadId, body: 'Taking CK-31.' , kind: 'claim' } });
  assert.equal(post.json.result.isError, undefined);
  const update = await rpc('tools/call', { name: 'task.update', arguments: { state: 'ready_for_review', summary: 'Animation polished; tests pass.' } });
  assert.match(update.json.result.content[0].text, /in_review/);
  assert.equal((await db.selectFrom('tasks').select('state').where('id', '=', taskId).executeTakeFirstOrThrow()).state, 'in_review');
  const found = await rpc('tools/call', { name: 'knowledge.search', arguments: { query: 'idempotency' } });
  const pageId = JSON.parse(found.json.result.content[0].text)[0].id;
  assert.match((await rpc('tools/call', { name: 'knowledge.read', arguments: { pageId } })).json.result.content[0].text, /Key|key/);
  assert.equal((await db.selectFrom('kb_reads').select('agent_id').execute()).length, 1);
  const logged = await db.selectFrom('events').select('type').where('type', '=', 'tool.called').execute();
  assert.equal(logged.length, 4);
  await coordinator.close();
});

test('tools are scoped by turn kind, project and lease', async () => {
  const { coordinator, db, rpc, turns, claimed } = await boot('feedback');
  const denied = await rpc('tools/call', { name: 'task.update', arguments: { state: 'checkpoint', summary: 'x' } });
  assert.equal(denied.json.result.isError, true);
  const foreign = await db.selectFrom('threads').select('id').executeTakeFirstOrThrow();
  await db.updateTable('threads').set({ visibility: 'private' }).where('id', '=', foreign.id).execute();
  assert.equal((await rpc('tools/call', { name: 'thread.read', arguments: { threadId: foreign.id } })).json.result.isError, true);
  assert.equal((await rpc('tools/list', undefined, 'turn.00000000-0000-7000-8000-000000000000.nope')).status, 401);
  await turns.finish(claimed.turnId, 'w1', claimed.leaseToken, { state: 'completed' });
  assert.equal((await rpc('tools/list')).status, 401);
  await coordinator.close();
});
