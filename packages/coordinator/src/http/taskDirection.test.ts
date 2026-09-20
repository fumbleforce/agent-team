import test from 'node:test';
import assert from 'node:assert/strict';
import { buildResumeDelta } from '../runtime/packet.ts';
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
