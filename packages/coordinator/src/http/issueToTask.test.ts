import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './testing.ts';

test('a raised issue leads somewhere: the PM is told how to make it a task and who there is, the page says who is on it, and a person can make the call themselves', async () => {
  const { coordinator, db, call, owner, machine } = await boot();
  try {
    const cookie = await owner();
    await call('/api/projects', { cookie, body: { name: 'Shop' } });
    const project = (await call('/api/projects/shop', { cookie })).json, pm = project.roster.find((agent: { is_pm: boolean }) => agent.is_pm), developer = project.roster.find((agent: { is_pm: boolean }) => !agent.is_pm);
    const raised = (await call('/api/projects/shop/issues', { cookie, body: { title: 'The team header repeats the team name', body: 'It says the name twice.' } })).json;
    const listed = async () => ((await call('/api/projects/shop/issues', { cookie })).json.issues as { number: number; task: { id: string; key: string; state: string; assigneeAgentId: string | null }; pending: { agentId: string; kind: string; state: string; deferReason: string | null; others: number } | null }[]).find(issue => issue.number === raised.number)!;

    // What is raised is a task from the start: it waits in the board's inbox, and the page can say the PM is up next.
    assert.deepEqual([(await listed()).pending, (await listed()).task.state, raised.taskId], [{ agentId: pm.id, kind: 'triage', state: 'queued', deferReason: null, others: 0 }, 'inbox', (await listed()).task.id]);
    const inboxNow = (await call('/api/projects/shop', { cookie })).json.board.inbox as { key: string; raised: string }[];
    assert.deepEqual(inboxNow.map(card => [card.key, card.raised]), [[`ISSUE-${raised.number}`, 'raised']]);

    // The triage turn is told to settle it with one decision, that accepting makes a task, never to file a second issue, and who could own it.
    const turn = (await call('/worker/claim', { headers: machine, body: { workerId: 'atlas', free: { work: 1, bounded: 1 }, projects: [project.project.id] } })).json.turn;
    assert.equal(turn.kind, 'triage');
    assert.match(turn.packet.prompt, /calling triage\.decide once/);
    assert.match(turn.packet.prompt, /outcome is accept, with ownerAgentId/);
    assert.match(turn.packet.prompt, /Never file a second issue/);
    assert.ok(turn.packet.prompt.includes(`ownerAgentId ${developer.id}`), 'the team is listed with the ids an owner is named by');
    assert.match(turn.packet.system, /look it up with your tool search/);
    assert.equal((await listed()).pending?.state, 'running');

    // A person makes the call: a task on the board for the teammate they named, who is started on it. Only once, and only for the team.
    assert.equal((await call(`/api/projects/shop/issues/${raised.number}/accept`, { cookie, body: { agentId: 'nobody' } })).status, 400);
    const made = await call(`/api/projects/shop/issues/${raised.number}/accept`, { cookie, body: { agentId: developer.id } });
    assert.equal(made.status, 200);
    assert.deepEqual((await listed()).task, { id: raised.taskId, key: `ISSUE-${raised.number}`, state: 'assigned', assigneeAgentId: developer.id });
    assert.equal((await call(`/api/projects/shop/issues/${raised.number}/accept`, { cookie, body: { agentId: developer.id } })).status, 409);
    const board = (await call('/api/projects/shop', { cookie })).json.board;
    assert.deepEqual([board.inbox.length, board.backlog.map((card: { key: string }) => card.key)], [0, [`ISSUE-${raised.number}`]], 'it left the inbox for the backlog column');
    const work = await db.selectFrom('work_items').select(['kind', 'agent_id', 'state']).where('task_id', '=', made.json.taskId).execute();
    assert.deepEqual(work.map(item => [item.kind, item.agent_id, item.state]), [['work', developer.id, 'queued']]);
  } finally { await coordinator.close(); }
});
