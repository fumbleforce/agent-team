import test from 'node:test';
import assert from 'node:assert/strict';
import { buildResumeDelta } from '../runtime/packet.ts';
import { createTurns } from '../runtime/turns.ts';
import { boot } from './testing.ts';

test('a card opens to what the task is and what happened on it; what a person writes there or says to the agent directly is direction for the work in hand', async () => {
  const { coordinator, db, call, owner, person } = await boot();
  try {
    const cookie = await owner(), outsider = await person('olga', 'member');
    await call('/api/projects', { cookie, body: { name: 'Shop' } });
    const project = (await call('/api/projects/shop', { cookie })).json, developer = project.roster.find((agent: { is_pm: boolean }) => !agent.is_pm);
    const raised = (await call('/api/projects/shop/issues', { cookie, body: { title: 'Things are picked up twice', body: 'Two agents did the same work.' } })).json;
    // It waits in the inbox as a task already; accepting it from its page gives it to someone.
    const taskId = raised.taskId as string;
    assert.equal((await call(`/api/tasks/${taskId}`, { cookie })).json.steps[1].state, 'now');
    assert.equal((await call(`/api/tasks/${taskId}/accept`, { cookie, body: { agentId: developer.id } })).status, 200);
    assert.equal((await call(`/api/tasks/${taskId}/accept`, { cookie, body: { agentId: developer.id } })).status, 409);

    const opened = (await call(`/api/tasks/${taskId}`, { cookie })).json;
    assert.deepEqual([opened.task.key, opened.task.brief, opened.task.assignee_agent_id, opened.issue.number, opened.canWrite], [`ISSUE-${raised.number}`, 'Two agents did the same work.', developer.id, raised.number, true]);
    // The strip says who has had it and where it is: raised, accepted, and the owner up next.
    assert.deepEqual(opened.steps.map((step: { label: string; state: string }) => [step.label, step.state]), [['Raised', 'done'], ['Accepted', 'done'], ['Picked up', 'now'], ['Changed', 'todo'], ['Review', 'todo'], ['Done', 'todo']]);
    assert.match(opened.steps[2].who, new RegExp(`${developer.name} · up next`));
    assert.equal((await call(`/api/tasks/${taskId}`, { cookie: outsider.cookie })).status, 403);

    // Written on the card, and said to the agent in private: both reach its next turn on the task, and a turn is there to read them.
    const since = Date.now() - 1;
    assert.equal((await call(`/api/tasks/${taskId}/say`, { cookie, body: { body: 'Start with the claim query, not the UI.' } })).status, 200);
    assert.equal((await call(`/api/agents/${developer.id}/dm`, { cookie, body: { body: 'Keep the change small; one commit.' } })).status, 200);
    assert.deepEqual((await call(`/api/tasks/${taskId}`, { cookie })).json.messages.map((message: { body: string }) => message.body), [`Accepted. ${developer.name} takes it.`, 'Start with the claim query, not the UI.']);
    const delta = await coordinator.context.storage.transaction(tx => buildResumeDelta(tx, { agentId: developer.id, projectId: project.project.id, taskId, since }));
    assert.match(delta, /Written on this task since your last turn\n- Start with the claim query/);
    assert.match(delta, /Said to you directly by the owner since your last turn[\s\S]*- Keep the change small; one commit\./);
    const items = await db.selectFrom('work_items').select(['kind', 'task_id']).where('agent_id', '=', developer.id).where('state', '=', 'queued').execute();
    assert.deepEqual(items.map(item => [item.kind, item.task_id]).sort(), [['reply', null], ['work', taskId]]);

    // Two more reports: one is the same as the task above and is merged into it, where its text is kept; one is declined. Both leave the board.
    const same = (await call('/api/projects/shop/issues', { cookie, body: { title: 'Double pick-up again', body: 'Saw it on the review lane too.' } })).json, no = (await call('/api/projects/shop/issues', { cookie, body: { title: 'Make it purple', body: 'Just because.' } })).json;
    assert.equal((await call(`/api/tasks/${same.taskId}/decline`, { cookie, body: { intoTaskId: 'nothing' } })).status, 400);
    assert.equal((await call(`/api/tasks/${same.taskId}/decline`, { cookie, body: { intoTaskId: taskId } })).status, 200);
    assert.equal((await call(`/api/tasks/${no.taskId}/decline`, { cookie, body: { reason: 'Not now.' } })).status, 200);
    assert.equal((await call(`/api/tasks/${taskId}/decline`, { cookie, body: {} })).status, 409);
    const after = (await call('/api/projects/shop', { cookie })).json.board;
    assert.deepEqual([after.inbox.length, (await db.selectFrom('tasks').select('state').where('id', 'in', [same.taskId, no.taskId]).execute()).map(row => row.state), (await db.selectFrom('issues').select('state').where('number', 'in', [same.number, no.number]).execute()).map(row => row.state)], [0, ['canceled', 'canceled'], ['closed', 'closed']]);
    assert.ok(((await call(`/api/tasks/${taskId}`, { cookie })).json.messages as { body: string }[]).some(message => /Also reported as ISSUE-\d+: Double pick-up again[\s\S]*review lane/.test(message.body)));
    assert.deepEqual(((await call(`/api/tasks/${no.taskId}`, { cookie })).json.messages as { kind: string; body: string }[]).map(message => [message.kind, message.body]), [['decision', 'Declined: Not now.']]);
  } finally { await coordinator.close(); }
});

test('a task that changes hands is logged as it stands: the strip names who holds it now, a stopped turn says why, and the agent page names the task', async () => {
  const { coordinator, call, owner } = await boot();
  try {
    const cookie = await owner();
    await call('/api/projects', { cookie, body: { name: 'Shop' } });
    const project = (await call('/api/projects/shop', { cookie })).json, teammates = project.roster.filter((agent: { is_pm: boolean }) => !agent.is_pm), developer = teammates[0], other = teammates[1];
    const raised = (await call('/api/projects/shop/issues', { cookie, body: { title: 'Reassigned, but the old owner kept it', body: 'The log still said the first picker.' } })).json;
    const taskId = raised.taskId as string;
    await call(`/api/tasks/${taskId}/accept`, { cookie, body: { agentId: developer.id } });
    // One turn that stops with an error, and one that reports what it did: both stay in the log with what happened.
    const turns = createTurns(coordinator.context), projectId = project.project.id;
    const claim = async () => (await turns.claim({ workerId: 'w1', free: { work: 1 }, projects: [projectId] }))!;
    const first = await claim();
    await turns.finish(first.turnId, 'w1', first.leaseToken, { state: 'failed', stopReason: 'crashed' });
    // The person carries it on, the owner reports properly, and then it is reassigned to someone else.
    await call(`/api/tasks/${taskId}/carry-on`, { cookie, body: {} });
    const second = await claim();
    await turns.finish(second.turnId, 'w1', second.leaseToken, { state: 'completed', summary: `ISSUE-${raised.number}: rewrote the claim query in issueTasks.ts; npm test passes.` });
    await call(`/api/tasks/${taskId}/assign`, { cookie, body: { agentId: other.id } });
    const page = (await call(`/api/tasks/${taskId}`, { cookie })).json;
    assert.equal(page.steps[2].label, 'Picked up');
    assert.equal(page.steps[2].agentId, other.id);
    assert.match(page.steps[2].who, new RegExp(`${other.name} · up next`));
    // The work log keeps what happened: the report, and why the earlier turn stopped.
    assert.equal(page.log[0].state, 'completed');
    assert.equal(page.log[0].stopReason, null);
    assert.equal(page.log[1].state, 'failed');
    assert.equal(page.log[1].stopReason, 'crashed');
    // Each of the agent's turns names the task it belongs to.
    const mine = (await call(`/api/agents/${developer.id}`, { cookie })).json;
    assert.deepEqual(mine.turns.map((turn: { task_key: string | null }) => turn.task_key), [page.task.key, page.task.key]);
  } finally { await coordinator.close(); }
});

test('an answer on a blocked task goes in its thread and starts its owner with it', async () => {
  const { coordinator, db, call, owner } = await boot();
  try {
    const cookie = await owner();
    await call('/api/projects', { cookie, body: { name: 'Shop' } });
    const project = (await call('/api/projects/shop', { cookie })).json, developer = project.roster.find((agent: { is_pm: boolean }) => !agent.is_pm);
    const taskId = (await call('/api/projects/shop/issues', { cookie, body: { title: 'Which key for the sandbox?', body: 'It needs a payment key.' } })).json.taskId as string;
    await call(`/api/tasks/${taskId}/accept`, { cookie, body: { agentId: developer.id } });
    await db.updateTable('tasks').set({ state: 'blocked', blocked_reason: 'Which key should the sandbox use?' }).where('id', '=', taskId).execute();
    await db.deleteFrom('work_items').where('task_id', '=', taskId).execute();
    assert.equal((await call(`/api/tasks/${taskId}/carry-on`, { cookie, body: { answer: 'Use the staging key.' } })).status, 200);
    const task = await db.selectFrom('tasks').select(['state', 'blocked_reason']).where('id', '=', taskId).executeTakeFirstOrThrow();
    assert.deepEqual([task.state, task.blocked_reason], ['in_progress', null]);
    const page = (await call(`/api/tasks/${taskId}`, { cookie })).json;
    assert.match(JSON.stringify(page), /Use the staging key\./, 'the answer is in the task\'s own thread');
    assert.ok(await db.selectFrom('work_items').select('id').where('task_id', '=', taskId).where('agent_id', '=', developer.id).where('kind', '=', 'work').where('state', '=', 'queued').executeTakeFirst());
  } finally { await coordinator.close(); }
});
