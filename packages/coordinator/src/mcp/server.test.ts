import test from 'node:test';
import assert from 'node:assert/strict';
import type { TurnKind } from '@agent-team/protocol';
import { turnToken } from '../auth/secrets.ts';
import { seedDemo } from '../demo/seed.ts';
import { createTurns, type Claimed } from '../runtime/turns.ts';
import { startCoordinator } from '../server.ts';

const TOKEN = 'machine-token-for-tests-0123456789';

async function boot(kind: TurnKind, options: { agent?: string; roles?: string[] } = {}) {
  const coordinator = await startCoordinator({ port: 0, storage: { kind: 'sqlite', path: ':memory:' }, machineToken: TOKEN, webRoot: null });
  try {
    await seedDemo(coordinator.context);
    const db = coordinator.context.storage.db;
    const project = await db.selectFrom('projects').select('id').where('slug', '=', 'checkout-v2').executeTakeFirstOrThrow();
    const task = await db.selectFrom('tasks').select('id').where('key', '=', 'CK-31').executeTakeFirstOrThrow();
    const agents = Object.fromEntries((await db.selectFrom('agents').select(['id', 'name']).execute()).map(row => [row.name, row.id])) as Record<string, string>;
    const agentId = agents[options.agent ?? 'Bram']!;
    for (const role of options.roles ?? []) await db.insertInto('agent_roles').values({ agent_id: agentId, role_slug: role }).execute();
    const thread = await db.selectFrom('threads').select('id').where('project_id', '=', project.id).where('kind', '=', 'discussion').executeTakeFirstOrThrow();
    const turns = createTurns(coordinator.context);
    let id = 0;
    // One client per claimed turn: the token is the turn's.
    const client = (claimed: Claimed) => async (method: string, params?: unknown, token = turnToken(TOKEN, claimed.turnId, claimed.leaseToken)) => {
      const response = await fetch(`${coordinator.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
      return { status: response.status, json: await response.json() as any };
    };
    const claim = async () => (await turns.claim({ workerId: 'w1', free: { work: 1, bounded: 1 }, projects: [project.id] }))!;
    const onTask = kind === 'work' || kind === 'review' || kind === 'feedback';
    await turns.enqueue({ agentId, projectId: project.id, kind, taskId: onTask ? task.id : null, threadId: onTask ? null : thread.id });
    const claimed = await claim();
    const rpc = client(claimed);
    const call = async (name: string, args: unknown = {}, extra: Record<string, unknown> = {}) => { const result = (await rpc('tools/call', { name, arguments: args, ...extra })).json.result; return { error: result.isError === true, text: result.content[0].text as string, data: result.isError ? null : JSON.parse(result.content[0].text) }; };
    return { coordinator, db, rpc, call, client, claim, turns, claimed, agents, agentId, projectId: project.id, threadId: thread.id, taskId: task.id };
  } catch (error) { await coordinator.close(); throw error; }
}
const count = async (db: Awaited<ReturnType<typeof boot>>['db'], type: string) => (await db.selectFrom('events').select('seq').where('type', '=', type).execute()).length;

test('a work turn lists its tools, posts to discussion and reports on its task; every call is logged', async () => {
  const { coordinator, db, rpc, threadId, taskId } = await boot('work');
  try {
    const list = await rpc('tools/list');
    // Without a role nothing graded is granted, so the issue and handoff tools are not even listed.
    assert.deepEqual(list.json.result.tools.map((tool: any) => tool.name).sort(), ['agent.mention', 'cost.status', 'deliberation.propose', 'discussion.post', 'knowledge.propose_memory', 'knowledge.read', 'knowledge.search', 'knowledge.write', 'proposal.create', 'proposal.vote', 'task.claim', 'task.handoff', 'task.list', 'task.update', 'test.report', 'thread.read']);
    assert.equal(list.json.result.tools[0].inputSchema.type, 'object');
    const post = await rpc('tools/call', { name: 'discussion.post', arguments: { threadId, body: 'Taking CK-31.', kind: 'claim' } });
    assert.equal(post.json.result.isError, undefined);
    const update = await rpc('tools/call', { name: 'task.update', arguments: { state: 'ready_for_review', summary: 'Animation polished; tests pass.' } });
    assert.match(update.json.result.content[0].text, /in_review/);
    assert.equal((await db.selectFrom('tasks').select('state').where('id', '=', taskId).executeTakeFirstOrThrow()).state, 'in_review');
    const found = await rpc('tools/call', { name: 'knowledge.search', arguments: { query: 'idempotency' } });
    const pageId = JSON.parse(found.json.result.content[0].text)[0].id;
    assert.match((await rpc('tools/call', { name: 'knowledge.read', arguments: { pageId } })).json.result.content[0].text, /Key|key/);
    assert.equal((await db.selectFrom('kb_reads').select('agent_id').execute()).length, 1);
    assert.equal(await count(db, 'tool.called'), 4);
    assert.deepEqual((await db.selectFrom('tool_calls').select(['seq', 'tool']).orderBy('seq').execute()).map(row => `${row.seq}:${row.tool}`), ['1:discussion.post', '2:task.update', '3:knowledge.search', '4:knowledge.read']);
  } finally { await coordinator.close(); }
});

test('tools are scoped by turn kind, project and lease', async () => {
  const { coordinator, db, rpc, turns, claimed } = await boot('feedback');
  try {
    const denied = await rpc('tools/call', { name: 'task.update', arguments: { state: 'checkpoint', summary: 'x' } });
    assert.equal(denied.json.result.isError, true);
    const foreign = await db.selectFrom('threads').select('id').executeTakeFirstOrThrow();
    await db.updateTable('threads').set({ visibility: 'private' }).where('id', '=', foreign.id).execute();
    assert.equal((await rpc('tools/call', { name: 'thread.read', arguments: { threadId: foreign.id } })).json.result.isError, true);
    assert.equal((await rpc('tools/list', undefined, 'turn.00000000-0000-7000-8000-000000000000.nope')).status, 401);
    await turns.finish(claimed.turnId, 'w1', claimed.leaseToken, { state: 'completed' });
    assert.equal((await rpc('tools/list')).status, 401);
  } finally { await coordinator.close(); }
});

test('a mutation is replayed by key instead of run twice, and calls are limited per turn by rate class', async () => {
  const { coordinator, db, call, threadId } = await boot('work');
  try {
    const before = (await db.selectFrom('messages').select('id').where('thread_id', '=', threadId).execute()).length;
    const first = await call('discussion.post', { threadId, body: 'Same words.' });
    // The default key is the hash of turn, tool and canonical arguments: key order and defaults do not matter.
    const again = await call('discussion.post', { kind: 'note', body: 'Same words.', threadId });
    assert.equal(again.data.messageId, first.data.messageId);
    const keyed = await call('discussion.post', { threadId, body: 'Keyed.' }, { idempotencyKey: 'k1' });
    assert.equal((await call('discussion.post', { threadId, body: 'Keyed.' }, { idempotencyKey: 'k1' })).data.messageId, keyed.data.messageId);
    assert.match((await call('discussion.post', { threadId, body: 'Other words.' }, { idempotencyKey: 'k1' })).text, /different call/);
    assert.equal((await db.selectFrom('messages').select('id').where('thread_id', '=', threadId).execute()).length, before + 2);
    assert.equal(await count(db, 'tool.called'), 2);
    // A call whose first attempt never reported back is not run again.
    await db.updateTable('tool_calls').set({ result: null }).where('idempotency_key', '=', 'k1').execute();
    assert.match((await call('discussion.post', { threadId, body: 'Keyed.' }, { idempotencyKey: 'k1' })).text, /no known outcome/);
    // A refusal changes nothing and may be tried again, but it counts: the post class allows six calls a turn.
    assert.equal((await call('discussion.post', { threadId: 'nope', body: 'x' })).error, true);
    assert.equal((await call('discussion.post', { threadId: 'nope', body: 'x' })).error, true);
    for (const body of ['five', 'six']) assert.equal((await call('discussion.post', { threadId, body })).error, false);
    assert.match((await call('discussion.post', { threadId, body: 'seven' })).text, /6 times per turn/);
    assert.equal((await call('thread.read', { threadId })).error, false);
  } finally { await coordinator.close(); }
});

test('graded tools need the permission in the grants frozen at claim', async () => {
  const bare = await boot('work');
  try {
    assert.match((await bare.call('issue.create', { title: 'x', body: 'y' })).text, /not available/);
  } finally { await bare.coordinator.close(); }
  const { coordinator, db, rpc, call, agentId, taskId, projectId } = await boot('work', { agent: 'Maren', roles: ['pm'] });
  try {
    // Roles taken away after the claim: the running turn keeps what it was given.
    await db.deleteFrom('agent_roles').where('agent_id', '=', agentId).execute();
    assert.ok((await rpc('tools/list')).json.result.tools.some((tool: any) => tool.name === 'handoff.send'));
    const issue = await call('issue.create', { title: 'Pay button flickers', body: 'Seen on Safari 18 after a retry.' });
    const row = await db.selectFrom('issues').select(['source', 'author_user_id', 'number']).where('id', '=', issue.data.id).executeTakeFirstOrThrow();
    assert.deepEqual({ ...row }, { source: 'agent', author_user_id: null, number: issue.data.number });
    assert.equal((await call('issue.comment', { number: issue.data.number, body: 'Reproduced on staging.' })).error, false);
    assert.equal((await db.selectFrom('messages').select('id').where('thread_id', '=', issue.data.threadId).execute()).length, 2);
    assert.deepEqual((await call('issue.link', { number: issue.data.number, to: { type: 'task', id: taskId } })).data, { linked: true });
    assert.equal((await call('issue.link', { number: issue.data.number, to: { type: 'task', id: 'elsewhere' } })).error, true);
    assert.equal((await call('issue.comment', { number: 9999, body: 'x' })).error, true);
    assert.deepEqual((await db.selectFrom('links').select(['from_id', 'to_id', 'rel']).where('from_id', '=', issue.data.id).where('rel', '=', 'relates').execute()).map(link => ({ ...link })), [{ from_id: issue.data.id, to_id: taskId, rel: 'relates' }]);
    const sent = await call('handoff.send', { destination: 'design-agency', title: 'Icon set', summary: 'Need the retry icon in three sizes.', taskId });
    assert.deepEqual({ ...await db.selectFrom('handoffs').select(['direction', 'source', 'state', 'project_id']).where('id', '=', sent.data.handoffId).executeTakeFirstOrThrow() }, { direction: 'out', source: 'design-agency', state: 'outbox', project_id: projectId });
    for (const type of ['link.added', 'handoff.sent']) assert.equal(await count(db, type), 1, type);
  } finally { await coordinator.close(); }
});

test('a work turn claims a free task, hands its own over, writes knowledge, asks a teammate and reads its spend', async () => {
  const { coordinator, db, call, agents, agentId, taskId, threadId } = await boot('work');
  try {
    const template = { ...await db.selectFrom('tasks').selectAll().where('id', '=', taskId).executeTakeFirstOrThrow() };
    await db.insertInto('tasks').values({ ...template, id: 'free-task', key: 'CK-90', state: 'backlog', assignee_agent_id: null }).execute();
    await db.insertInto('tasks').values({ ...template, id: 'held-task', key: 'CK-91', state: 'backlog', assignee_agent_id: agents.Ada! }).execute();
    assert.deepEqual((await call('task.claim', { taskId: 'free-task' })).data, { taskId: 'free-task', key: 'CK-90', state: 'assigned' });
    assert.match((await call('task.claim', { taskId: 'held-task' })).text, /already taken/);
    assert.equal((await db.selectFrom('work_items').select('id').where('task_id', '=', 'free-task').where('agent_id', '=', agentId).where('kind', '=', 'work').execute()).length, 1);

    const page = await call('knowledge.write', { path: 'checkout/retry.md', title: 'Retry', body: 'Retry keeps the key.' });
    assert.equal(page.data.rev, 1);
    assert.match((await call('knowledge.write', { path: 'checkout/retry.md', title: 'Retry', body: 'Changed.', expectedRev: 7 })).text, /revision 1/);

    const status = await call('cost.status');
    assert.equal(typeof status.data.agent.spentTodayMinor, 'number');
    assert.equal(typeof status.data.project.monthMinor, 'number');

    const asked = await call('agent.mention', { threadId, target: { type: 'agent', id: 'Ada' }, body: 'Does the API keep the key across a retry?' });
    assert.deepEqual(asked.data.mentions.map((item: any) => [item.agentId, item.state]), [[agents.Ada, 'woken']]);
    assert.match((await call('agent.mention', { threadId, target: { type: 'role', id: 'nobody-has-this' }, body: 'Anyone?' })).text, /Nobody/);
    assert.equal((await db.selectFrom('messages').select('id').where('kind', '=', 'question').where('author_id', '=', agentId).execute()).length, 1);

    await db.updateTable('tasks').set({ assignee_agent_id: agentId }).where('id', '=', taskId).execute();
    assert.equal((await call('task.handoff', { toAgentId: 'not-a-seat', summary: 'x' })).error, true);
    assert.match((await call('task.handoff', { toAgentId: agents.Ada, summary: 'Animation done; timeout handling is left.' })).text, /once per turn/);
  } finally { await coordinator.close(); }
});

test('a task changes seat with its summary, and the receiver is woken', async () => {
  const { coordinator, db, call, agents, agentId, taskId } = await boot('work');
  try {
    await db.updateTable('tasks').set({ assignee_agent_id: agentId }).where('id', '=', taskId).execute();
    assert.deepEqual((await call('task.handoff', { toAgentId: agents.Ada, summary: 'Animation done; timeout handling is left.' })).data, { taskId, assigneeAgentId: agents.Ada });
    assert.equal((await db.selectFrom('tasks').select('assignee_agent_id').where('id', '=', taskId).executeTakeFirstOrThrow()).assignee_agent_id, agents.Ada);
    assert.equal((await db.selectFrom('work_items').select('id').where('task_id', '=', taskId).where('agent_id', '=', agents.Ada!).where('state', '=', 'queued').execute()).length, 1);
    assert.equal(await count(db, 'task.handed_off'), 1);
  } finally { await coordinator.close(); }
});

test('a reply turn answers its mention exactly once, in the thread it was asked in', async () => {
  const { coordinator, db, call, client, claim, threadId, agents } = await boot('work');
  try {
    await call('agent.mention', { threadId, target: { type: 'agent', id: agents.Ada }, body: 'Does the API keep the key across a retry?' });
    const reply = await claim();
    assert.deepEqual([reply.kind, reply.agentId], ['reply', agents.Ada]);
    const rpc = client(reply);
    const post = async (body: string) => (await rpc('tools/call', { name: 'discussion.post', arguments: { threadId, body } })).json.result;
    assert.equal((await post('Yes, for the lifetime of the view.')).isError, undefined);
    assert.match((await post('And another thing.')).content[0].text, /one reply/);
    assert.equal((await db.selectFrom('mentions').select('state').executeTakeFirstOrThrow()).state, 'answered');
  } finally { await coordinator.close(); }
});

test('a feedback turn stands aside once, and only in its own deliberation', async () => {
  const { coordinator, db, call, client, claim, threadId, projectId } = await boot('work');
  try {
    const opened = await call('deliberation.propose', { threadId, question: 'Disable the pay button on tap?', summary: 'Optimistic disable with a timeout.', urgency: 'normal', reviewers: ['Ada'] });
    const feedback = await claim();
    assert.equal(feedback.kind, 'feedback');
    const rpc = client(feedback);
    const stand = async (deliberationId: string) => (await rpc('tools/call', { name: 'deliberation.stand', arguments: { deliberationId, reason: 'Outside my area.' } })).json.result;
    const other = { ...await db.selectFrom('deliberations').selectAll().where('id', '=', opened.data.deliberationId).executeTakeFirstOrThrow(), id: 'other-deliberation', task_id: null };
    await db.insertInto('deliberations').values(other).execute();
    await db.insertInto('deliberation_participants').values({ deliberation_id: 'other-deliberation', agent_id: feedback.agentId, state: 'pending', stance: null, is_blocking: false, message_id: null }).execute();
    assert.match((await stand('other-deliberation')).content[0].text, /another deliberation/);
    await db.updateTable('deliberations').set({ project_id: (await db.selectFrom('projects').select('id').where('id', '!=', projectId).executeTakeFirstOrThrow()).id }).where('id', '=', 'other-deliberation').execute();
    assert.match((await stand('other-deliberation')).content[0].text, /not found in this project/);
    assert.equal((await stand(opened.data.deliberationId)).isError, undefined);
    assert.equal((await db.selectFrom('deliberation_participants').select('state').where('deliberation_id', '=', opened.data.deliberationId).where('agent_id', '=', feedback.agentId).executeTakeFirstOrThrow()).state, 'abstained');
    assert.equal(await count(db, 'deliberation.stood_aside'), 1);
  } finally { await coordinator.close(); }
});

test('triage records the decision on the issue; a retro turn submits its one note', async () => {
  const triage = await boot('triage', { agent: 'Maren', roles: ['pm'] });
  try {
    const { db, call, agents } = triage;
    const issue = await call('issue.create', { title: 'Flaky retry test', body: 'Fails one run in five.' });
    const decided = await call('triage.decide', { threadId: issue.data.threadId, outcome: 'accept', decision: 'Real; Ada owns it.', ownerAgentId: agents.Ada, priority: 'high' });
    assert.equal(decided.error, false);
    assert.deepEqual({ ...await db.selectFrom('issues').select(['owner_agent_id', 'priority', 'state']).where('id', '=', issue.data.id).executeTakeFirstOrThrow() }, { owner_agent_id: agents.Ada, priority: 'high', state: 'open' });
    assert.deepEqual({ ...await db.selectFrom('decisions').select(['kind', 'outcome', 'needs_human']).where('id', '=', decided.data.decisionId).executeTakeFirstOrThrow() }, { kind: 'triage', outcome: 'accept', needs_human: false });
    // Accepting made the work: one task for the owner, linked to the issue, with the owner woken to start on it.
    const task = await db.selectFrom('tasks').select(['id', 'key', 'title', 'brief', 'source', 'state', 'assignee_agent_id', 'author_agent_id']).where('id', '=', decided.data.taskId).executeTakeFirstOrThrow();
    assert.deepEqual({ ...task }, { id: decided.data.taskId, key: `ISSUE-${issue.data.number}`, title: 'Flaky retry test', brief: 'Fails one run in five.', source: 'internal', state: 'assigned', assignee_agent_id: agents.Ada, author_agent_id: agents.Maren });
    assert.deepEqual((await db.selectFrom('links').select(['from_type', 'from_id', 'to_type', 'to_id', 'rel']).where('from_id', '=', issue.data.id).execute()).map(link => ({ ...link })), [{ from_type: 'issue', from_id: issue.data.id, to_type: 'task', to_id: task.id, rel: 'fixes' }]);
    assert.deepEqual((await db.selectFrom('work_items').select(['agent_id', 'kind']).where('task_id', '=', task.id).execute()).map(item => ({ ...item })), [{ agent_id: agents.Ada, kind: 'work' }]);
    assert.equal((await db.selectFrom('events').select('type').where('task_id', '=', task.id).where('type', '=', 'task.assigned').execute()).length, 1);
    assert.match((await call('triage.decide', { threadId: issue.data.threadId, outcome: 'decline', decision: 'Changed my mind.' })).text, /once per turn/);
  } finally { await triage.coordinator.close(); }
  const retro = await boot('retro');
  try {
    const note = await retro.call('retro.submit', { wentWell: 'Reviews came back within the hour.', problems: [{ problem: 'Cap hit mid-afternoon', evidence: '6 deferred turns', suggestion: 'Raise the cap to 12' }] });
    const message = await retro.db.selectFrom('messages').select(['thread_id', 'kind', 'payload']).where('id', '=', note.data.messageId).executeTakeFirstOrThrow();
    assert.deepEqual([message.thread_id, message.kind, JSON.parse(message.payload).retro], [retro.threadId, 'note', true]);
    assert.equal(await count(retro.db, 'retro.submitted'), 1);
  } finally { await retro.coordinator.close(); }
});

test('the PM puts work on the board: a plain answer is not a decision, what is accepted in the discussion becomes a task, and task.create adds the rest', async () => {
  const pm = await boot('triage', { agent: 'Maren', roles: ['pm'] });
  try {
    const { db, call, agents, threadId, projectId } = pm;
    const listed = (await pm.rpc('tools/list')).json.result.tools.map((tool: { name: string }) => tool.name) as string[];
    assert.ok(listed.includes('task.create'));
    // Several pieces of work: each its own task, the owner started on it, nothing added twice.
    const made = await call('task.create', { title: 'Plain replies are not decisions', brief: 'Only a real outcome shows as a decision card.', ownerAgentId: agents.Ada });
    assert.deepEqual([made.error, made.data.key, made.data.state], [false, 'TASK-1', 'assigned']);
    assert.deepEqual((await db.selectFrom('work_items').select(['agent_id', 'kind']).where('task_id', '=', made.data.taskId).execute()).map(item => [item.agent_id, item.kind]), [[agents.Ada, 'work']]);
    assert.match((await call('task.create', { title: 'Plain replies are not decisions', brief: 'Again.' })).text, /TASK-1 already has that title/);
    const waiting = await call('task.create', { title: 'Edit a persona from the agent page', brief: 'With docs saying where.' });
    assert.deepEqual([waiting.data.key, waiting.data.state], ['TASK-2', 'backlog']);
    // Accepted in the discussion, where there is no issue: a task all the same.
    await db.insertInto('messages').values({ id: 'raised-by-owner', thread_id: threadId, author_kind: 'user', author_id: null, kind: 'note', body: 'The header says the team name twice.\nSee the Team tab.', payload: '{}', created_at: Date.now() }).execute();
    const accepted = await call('triage.decide', { threadId, outcome: 'accept', decision: 'Real; Bram takes it.', ownerAgentId: agents.Bram, title: 'Team header repeats the team name' });
    assert.equal(accepted.error, false);
    const task = await db.selectFrom('tasks').select(['key', 'title', 'state', 'assignee_agent_id', 'project_id']).where('id', '=', accepted.data.taskId).executeTakeFirstOrThrow();
    assert.deepEqual({ ...task }, { key: 'TASK-3', title: 'Team header repeats the team name', state: 'assigned', assignee_agent_id: agents.Bram, project_id: projectId });
  } finally { await pm.coordinator.close(); }

  const chat = await boot('triage', { agent: 'Maren', roles: ['pm'] });
  try {
    const answered = await chat.call('triage.decide', { threadId: chat.threadId, outcome: 'answer', decision: 'Quiet on my end.' });
    assert.deepEqual([answered.error, answered.data.decisionId], [false, null]);
    const message = await chat.db.selectFrom('messages').select(['kind', 'body']).where('id', '=', answered.data.messageId).executeTakeFirstOrThrow();
    assert.deepEqual([message.kind, message.body, (await chat.db.selectFrom('decisions').select('id').where('kind', '=', 'triage').where('summary', '=', 'Quiet on my end.').execute()).length], ['note', 'Quiet on my end.', 0]);
  } finally { await chat.coordinator.close(); }

  // Anyone else files an issue instead.
  const developer = await boot('reply', { agent: 'Bram' });
  try { assert.match((await developer.call('task.create', { title: 'Something', brief: 'Anything.' })).text, /Only the PM adds tasks/); } finally { await developer.coordinator.close(); }
});

test('an author who finds the base already does what the task asked closes it as not needed, with where it was done', async () => {
  const work = await boot('work');
  try {
    const { db, call, taskId } = work;
    await db.insertInto('merge_queue').values({ id: 'waiting', project_id: work.projectId, task_id: taskId, head_sha: 'a'.repeat(40), state: 'queued', reason: null, created_at: 1, finished_at: null }).execute();
    const closed = await call('task.update', { state: 'not_needed', summary: 'Already done on main by the task page rewrite (TaskPage.tsx).' });
    assert.deepEqual([closed.error, closed.data.state], [false, 'canceled']);
    assert.equal((await db.selectFrom('tasks').select('state').where('id', '=', taskId).executeTakeFirstOrThrow()).state, 'canceled');
    assert.equal((await db.selectFrom('merge_queue').select('state').where('id', '=', 'waiting').executeTakeFirstOrThrow()).state, 'blocked', 'nothing of it waits to be merged');
  } finally { await work.coordinator.close(); }
});

test('the PM gives a waiting task to a teammate who may do it; not to one who may not write, and not a task being worked on', async () => {
  const pm = await boot('triage', { agent: 'Maren', roles: ['pm'] });
  try {
    const { db, call, agents, taskId } = pm;
    await db.insertInto('agent_roles').values({ agent_id: agents.Ada!, role_slug: 'developer' }).onConflict(oc => oc.doNothing()).execute();
    // Someone whose only role reads and judges, and writes nothing.
    await db.deleteFrom('agent_roles').where('agent_id', '=', agents.Cleo!).execute();
    await db.insertInto('agent_roles').values({ agent_id: agents.Cleo!, role_slug: 'reviewer' }).execute();
    assert.match((await call('task.assign', { taskId, ownerAgentId: agents.Cleo, why: 'She is free.' })).text, /has no role that may change the code[\s\S]*proposal\.create/);
    const moved = await call('task.assign', { taskId, ownerAgentId: agents.Ada, why: 'Bram has three waiting; Ada is free.' });
    assert.deepEqual([moved.error, moved.data.assigneeAgentId], [false, agents.Ada]);
    assert.deepEqual((await db.selectFrom('work_items').select(['agent_id', 'kind']).where('task_id', '=', taskId).where('state', '=', 'queued').execute()).map(item => [item.agent_id, item.kind]), [[agents.Ada, 'work']]);
  } finally { await pm.coordinator.close(); }
  const other = await boot('reply', { agent: 'Bram' });
  try { assert.match((await other.call('task.assign', { taskId: other.taskId, ownerAgentId: other.agents.Ada, why: 'x' })).text, /Only the PM moves tasks/); } finally { await other.coordinator.close(); }
});

test('only the seat whose role staffs the team is offered the staffing tools, and it hires through them', async () => {
  const plain = await boot('reply');
  try {
    assert.equal(((await plain.rpc('tools/list')).json.result.tools as { name: string }[]).some(tool => tool.name.startsWith('staffing.')), false);
    assert.equal((await plain.call('staffing.decide', { title: 'Hire', why: 'x', change: { kind: 'hire_agent', library: 'gandalf' } })).error, true);
  } finally { await plain.coordinator.close(); }

  const { coordinator, db, rpc, call } = await boot('reply', { roles: ['hr'] });
  try {
    assert.deepEqual(((await rpc('tools/list')).json.result.tools as { name: string }[]).map(tool => tool.name).filter(name => name.startsWith('staffing.')), ['staffing.review', 'staffing.decide']);
    const review = await call('staffing.review');
    assert.ok(review.data.seats.length > 0 && review.data.library.some((item: { slug: string }) => item.slug === 'gandalf'));
    const hired = await call('staffing.decide', { title: 'A second developer', why: 'Two tasks wait behind the only developer.', change: { kind: 'hire_agent', library: 'gandalf', name: 'Gandalf' } });
    assert.equal(hired.data.state, 'applied');
    assert.equal((await db.selectFrom('agents').select('name').where('id', '=', hired.data.agentIds[0]).executeTakeFirstOrThrow()).name, 'Gandalf');
  } finally { await coordinator.close(); }
});
