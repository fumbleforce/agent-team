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
    const taskId = (await call(`/api/projects/shop/issues/${raised.number}/accept`, { cookie, body: { agentId: developer.id } })).json.taskId as string;

    const opened = (await call(`/api/tasks/${taskId}`, { cookie })).json;
    assert.deepEqual([opened.task.key, opened.task.brief, opened.task.assignee_agent_id, opened.issue.number, opened.queued.map((item: { kind: string; state: string }) => [item.kind, item.state]), opened.canWrite], [`ISSUE-${raised.number}`, 'Two agents did the same work.', developer.id, raised.number, [['work', 'queued']], true]);
    assert.equal((await call(`/api/tasks/${taskId}`, { cookie: outsider.cookie })).status, 403);

    // Written on the card, and said to the agent in private: both reach its next turn on the task, and a turn is there to read them.
    const since = Date.now() - 1;
    assert.equal((await call(`/api/tasks/${taskId}/say`, { cookie, body: { body: 'Start with the claim query, not the UI.' } })).status, 200);
    assert.equal((await call(`/api/agents/${developer.id}/dm`, { cookie, body: { body: 'Keep the change small; one commit.' } })).status, 200);
    assert.deepEqual((await call(`/api/tasks/${taskId}`, { cookie })).json.messages.map((message: { body: string }) => message.body), ['Start with the claim query, not the UI.']);
    const delta = await coordinator.context.storage.transaction(tx => buildResumeDelta(tx, { agentId: developer.id, projectId: project.project.id, taskId, since }));
    assert.match(delta, /Written on this task since your last turn\n- Start with the claim query/);
    assert.match(delta, /Said to you directly by the owner since your last turn[\s\S]*- Keep the change small; one commit\./);
    const items = await db.selectFrom('work_items').select(['kind', 'task_id']).where('agent_id', '=', developer.id).where('state', '=', 'queued').execute();
    assert.deepEqual(items.map(item => [item.kind, item.task_id]).sort(), [['reply', null], ['work', taskId]]);
  } finally { await coordinator.close(); }
});
