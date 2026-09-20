import test from 'node:test';
import assert from 'node:assert/strict';
import { unscheduled } from '../runtime/answering.ts';
import { boot } from './testing.ts';

test('what a person writes in a thread carries a state from the moment it is accepted', async () => {
  const { coordinator, call, owner, machine } = await boot();
  try {
    const cookie = await owner();
    await call('/api/projects', { cookie, body: { name: 'Shop' } });
    const view = (await call('/api/projects/shop', { cookie })).json;
    const pm = view.roster.find((agent: { is_pm: boolean }) => agent.is_pm);
    const threadId = view.discussionThreadId as string;
    const read = async () => (await call(`/api/threads/${threadId}/messages`, { cookie })).json;

    // A thread nobody has written in yet waits for nothing.
    assert.equal((await read()).pending, null);

    // Accepted: the PM is queued for triage, and the answer to the POST already says so.
    const posted = await call(`/api/threads/${threadId}/messages`, { cookie, body: { body: 'The header repeats the team name.' } });
    assert.deepEqual(posted.json.pending, { agentId: pm.id, kind: 'triage', state: 'queued', deferReason: null, others: 0 });
    assert.deepEqual((await read()).pending, { agentId: pm.id, kind: 'triage', state: 'queued', deferReason: null, others: 0 });

    // Claimed: the same thread now says that seat is answering, and its seat is no longer idle.
    const claim = await call('/worker/claim', { headers: machine, body: { workerId: 'atlas', free: { work: 1, bounded: 1 }, projects: [view.project.id] } });
    assert.equal(claim.json.turn.kind, 'triage');
    assert.deepEqual((await read()).pending, { agentId: pm.id, kind: 'triage', state: 'running', deferReason: null, others: 0 });
    const busy = (await call('/api/projects/shop', { cookie })).json.roster.find((agent: { id: string }) => agent.id === pm.id);
    assert.equal(busy.activity, 'working');

    // Answered: the turn is over, nothing is pending on the thread, and the seat is idle again.
    const done = await call(`/worker/turns/${claim.json.turn.turnId}/finish`, { headers: machine, body: { workerId: 'atlas', leaseToken: claim.json.turn.leaseToken, outcome: { state: 'completed', summary: 'Sorted' } } });
    assert.equal(done.status, 200);
    assert.equal((await read()).pending, null);
    assert.equal((await call('/api/projects/shop', { cookie })).json.roster.find((agent: { id: string }) => agent.id === pm.id).activity, 'idle');
  } finally { await coordinator.close(); }
});

test('a seat with a turn queued reads queued, not idle', async () => {
  const { coordinator, call, owner } = await boot();
  try {
    const cookie = await owner();
    await call('/api/projects', { cookie, body: { name: 'Shop' } });
    const view = (await call('/api/projects/shop', { cookie })).json;
    const pm = view.roster.find((agent: { is_pm: boolean }) => agent.is_pm);
    // Before any work: every seat is idle, and the PM's own seat with it.
    assert.deepEqual([...new Set(view.roster.map((agent: { activity: string }) => agent.activity))], ['idle']);

    await call(`/api/threads/${view.discussionThreadId}/messages`, { cookie, body: { body: 'Please look at the header.' } });
    const seats = (await call('/api/projects/shop', { cookie })).json.roster as { id: string; activity: string; doing: string | null }[];
    assert.equal(seats.find(seat => seat.id === pm.id)!.activity, 'queued');
    // Nothing has run, so no seat reports what it is doing: the queue is the only truthful source here.
    assert.equal(seats.find(seat => seat.id === pm.id)!.doing, null);
    assert.deepEqual(seats.filter(seat => seat.id !== pm.id).map(seat => seat.activity), seats.slice(1).map(() => 'idle'));

    // The same seat answers for the single-agent view and for the list of every agent.
    assert.equal((await call(`/api/agents/${pm.id}`, { cookie })).json.agent.activity, 'queued');
    assert.equal(((await call('/api/agents', { cookie })).json.agents as { id: string; activity: string }[]).find(agent => agent.id === pm.id)!.activity, 'queued');
  } finally { await coordinator.close(); }
});

test('when nobody could be given what was raised, the thread says so instead of staying silent', async () => {
  const { coordinator, db, call, owner } = await boot();
  try {
    const cookie = await owner();
    await call('/api/projects', { cookie, body: { name: 'Shop' } });
    const view = (await call('/api/projects/shop', { cookie })).json;
    const pm = view.roster.find((agent: { is_pm: boolean }) => agent.is_pm);
    const threadId = view.discussionThreadId as string;
    const bodies = async () => ((await call(`/api/threads/${threadId}/messages`, { cookie })).json.messages as { authorKind: string; body: string }[]);

    // The only seat that sorts out what comes in is resting: raising something says that, and names the seat.
    await call(`/api/agents/${pm.id}`, { cookie, body: { status: 'paused' } });
    const posted = await call(`/api/threads/${threadId}/messages`, { cookie, body: { body: 'The header repeats the team name.' } });
    assert.equal(posted.json.pending, null);
    const said = (await bodies()).filter(message => message.authorKind === 'system');
    assert.equal(said.length, 1);
    assert.match(said[0]!.body, new RegExp(`Nobody was given this: ${pm.name} sorts out what comes in and is paused`));

    // Resumed, the next message is picked up, and nothing more is said about nobody taking it.
    await call(`/api/agents/${pm.id}`, { cookie, body: { status: 'active' } });
    const again = await call(`/api/threads/${threadId}/messages`, { cookie, body: { body: 'Still there.' } });
    assert.equal(again.json.pending.agentId, pm.id);
    assert.equal((await bodies()).filter(message => message.authorKind === 'system').length, 1);

    // A second message while that triage item still waits adds no second complaint: one item covers the thread.
    await call(`/api/threads/${threadId}/messages`, { cookie, body: { body: 'And one more thing.' } });
    assert.equal((await bodies()).filter(message => message.authorKind === 'system').length, 1);
    assert.equal((await db.selectFrom('work_items').select('id').where('thread_id', '=', threadId).execute()).length, 1);
  } finally { await coordinator.close(); }
});

test('an issue raised while nobody can take it says so in its own thread', async () => {
  const { coordinator, call, owner } = await boot();
  try {
    const cookie = await owner();
    await call('/api/projects', { cookie, body: { name: 'Shop' } });
    const pm = (await call('/api/projects/shop', { cookie })).json.roster.find((agent: { is_pm: boolean }) => agent.is_pm);
    await call(`/api/agents/${pm.id}`, { cookie, body: { status: 'paused' } });
    const raised = (await call('/api/projects/shop/issues', { cookie, body: { title: 'The header repeats the team name', body: 'It says the name twice.' } })).json;
    assert.equal(raised.pending, null);
    const messages = (await call(`/api/threads/${raised.threadId}/messages`, { cookie })).json.messages as { authorKind: string; body: string }[];
    assert.match(messages.at(-1)!.body, /Nobody was given this/);
  } finally { await coordinator.close(); }
});

test('naming a teammate with @ is the pick-up: the PM is not woken on top of them', async () => {
  const { coordinator, call, owner } = await boot();
  try {
    const cookie = await owner();
    await call('/api/projects', { cookie, body: { name: 'Shop' } });
    const view = (await call('/api/projects/shop', { cookie })).json;
    const other = view.roster.find((agent: { is_pm: boolean }) => !agent.is_pm);
    const posted = await call(`/api/threads/${view.discussionThreadId}/messages`, { cookie, body: { body: `@${other.name.toLowerCase()} could you look at the header?` } });
    assert.deepEqual(posted.json.pending, { agentId: other.id, kind: 'reply', state: 'queued', deferReason: null, others: 0 });
  } finally { await coordinator.close(); }
});

test('the words for nobody having been given something name what is missing', () => {
  assert.match(unscheduled({ hasTeam: false, pm: null }), /the project has no team yet/);
  assert.match(unscheduled({ hasTeam: true, pm: null }), /the team has no PM/);
  assert.match(unscheduled({ hasTeam: true, pm: { name: 'Maren', status: 'paused' } }), /Maren sorts out what comes in and is paused/);
  assert.match(unscheduled({ hasTeam: true, pm: { name: 'Maren', status: 'active' } }), /Maren is the PM but is not on this project/);
});
