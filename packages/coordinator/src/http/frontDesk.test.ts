import test from 'node:test';
import assert from 'node:assert/strict';
import { turnToken } from '../auth/secrets.ts';
import { boot, TOKEN } from './testing.ts';

test('a team with a front desk hears from it first: it starts on a quick model, knows what is going on, and passes work to the PM', async () => {
  const { coordinator, db, call, owner, machine } = await boot();
  try {
    const cookie = await owner();
    await call('/api/projects', { cookie, body: { name: 'Shop' } });
    const before = (await call('/api/projects/shop', { cookie })).json, pm = before.roster.find((agent: { is_pm: boolean }) => agent.is_pm);
    assert.equal((await call('/api/projects/shop/desk', { cookie })).json.desk, null);

    // Without a desk, what is written in the discussion is the PM's to sort out, as before.
    await call(`/api/threads/${before.discussionThreadId}/messages`, { cookie, body: { body: 'Hello there' } });
    assert.deepEqual((await db.selectFrom('work_items').select(['agent_id', 'kind']).where('state', '=', 'queued').execute()).map(item => [item.agent_id, item.kind]), [[pm.id, 'triage']]);
    await db.deleteFrom('work_items').execute();

    // Hired from the library onto a provider that names its quick middle model: the desk starts on it, with nothing typed.
    await call('/api/providers/setup', { cookie, body: { kind: 'claude-subscription', values: { models: 'sonnet\nopus' } } });
    const deskId = (await call('/api/projects/shop/team/hire', { cookie, body: { library: 'jarvis' } })).json.id as string;
    const seat = await db.selectFrom('agents').innerJoin('providers', 'providers.id', 'agents.provider_id').select(['agents.model', 'providers.name']).where('agents.id', '=', deskId).executeTakeFirstOrThrow();
    assert.deepEqual([seat.model, seat.name], ['sonnet', 'Claude subscription']);
    assert.equal((await call('/api/projects/shop/desk', { cookie })).json.desk.name, 'Jarvis');

    // Now the desk answers first, at the priority of a reply to a person; an issue still goes to the PM.
    await call(`/api/threads/${before.discussionThreadId}/messages`, { cookie, body: { body: 'What is everyone doing?' } });
    const raised = (await call('/api/projects/shop/issues', { cookie, body: { title: 'The header repeats the name', body: 'Twice.' } })).json;
    const queued = await db.selectFrom('work_items').select(['agent_id', 'kind', 'priority_class', 'thread_id']).where('state', '=', 'queued').orderBy('priority_class').execute();
    assert.deepEqual(queued.map(item => [item.agent_id, item.kind, item.priority_class]), [[deskId, 'reply', 1], [pm.id, 'triage', 3]]);
    assert.equal(queued[1]!.thread_id, raised.threadId);

    // Its turn is told to be brief and true, and is handed what is going on: nobody works because no worker served the project until this one.
    const turn = (await call('/worker/claim', { headers: machine, body: { workerId: 'atlas', free: { work: 1, bounded: 1 }, projects: [before.project.id] } })).json.turn;
    assert.deepEqual([turn.agentId, turn.kind, turn.model], [deskId, 'reply', 'sonnet']);
    assert.match(turn.packet.prompt, /^You are the front desk/);
    assert.match(turn.packet.prompt, /# What is going on\n\nWorkers running: atlas\./);
    assert.match(turn.packet.prompt, new RegExp(`- ${pm.name}, [^\\n]*\\(PM\\): waiting to start triage`));
    assert.match(turn.packet.prompt, /## Open issues\n- #\d+ The header repeats the name/);
    assert.match(turn.packet.prompt, /What is everyone doing\?/);

    // Asked for work, it does not do it: it passes it on where the team can read it, and the PM is up next. Nobody else may use the hand-over.
    const tool = async (token: string, name: string, args: unknown) => (await (await fetch(`${coordinator.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })).json() as { result: { isError?: boolean; content: { text: string }[] } }).result;
    const passed = await tool(turnToken(TOKEN, turn.turnId, turn.leaseToken), 'desk.handover', { threadId: before.discussionThreadId, wants: 'Fix the header that says the team name twice.' });
    assert.deepEqual([passed.isError ?? false, JSON.parse(passed.content[0]!.text).passedTo], [false, pm.name]);
    const note = await db.selectFrom('messages').select(['kind', 'body']).where('thread_id', '=', before.discussionThreadId).orderBy('seq', 'desc').executeTakeFirstOrThrow();
    assert.deepEqual([note.kind, note.body], ['handoff', `For ${pm.name}, from the owner: Fix the header that says the team name twice.`]);
    assert.ok((await db.selectFrom('work_items').select('id').where('agent_id', '=', pm.id).where('kind', '=', 'triage').where('thread_id', '=', before.discussionThreadId).where('state', '=', 'queued').execute()).length === 1);
  } finally { await coordinator.close(); }
});
