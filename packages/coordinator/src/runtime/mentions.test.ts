import test from 'node:test';
import assert from 'node:assert/strict';
import type { MentionExpects, MentionTarget } from '@agent-team/protocol';
import { createStorage } from '@agent-team/storage';
import { createContext } from '../context.ts';
import { seedDemo } from '../demo/seed.ts';
import { admit, createMentions, mentionTokens } from './mentions.ts';
import { createTurns } from './turns.ts';

async function boot() {
  const storage = await createStorage({ kind: 'sqlite', path: ':memory:' });
  try {
    await storage.migrate();
    let clock = 1_000_000_000;
    const context = createContext({ storage, machineToken: 'x'.repeat(24), now: () => clock });
    await seedDemo(context);
    const db = storage.db;
    const project = await db.selectFrom('projects').select('id').where('slug', '=', 'checkout-v2').executeTakeFirstOrThrow();
    const thread = await db.selectFrom('threads').select('id').where('project_id', '=', project.id).where('kind', '=', 'discussion').executeTakeFirstOrThrow();
    const seats = await db.selectFrom('agents').select(['id', 'name', 'is_pm']).execute();
    const agents = Object.fromEntries(seats.map(agent => [agent.name, agent.id])) as Record<string, string>;
    const user = await db.selectFrom('users').select('id').executeTakeFirstOrThrow();
    await db.insertInto('agent_roles').values([{ agent_id: agents.Ada!, role_slug: 'developer' }, { agent_id: agents.Bram!, role_slug: 'developer' }]).execute();
    const turns = createTurns(context);
    const queued = async () => (await db.selectFrom('work_items').innerJoin('agents', 'agents.id', 'work_items.agent_id').select(['agents.name', 'work_items.kind']).where('work_items.state', '=', 'queued').where('work_items.thread_id', '=', thread.id).execute()).map(item => `${item.name}:${item.kind}`).sort();
    return { storage, db, mentions: createMentions(context, turns), turns, projectId: project.id, threadId: thread.id, agents, pm: seats.find(seat => seat.is_pm)!.name, userId: user.id, queued, tick: (ms: number) => { clock += ms; } };
  } catch (error) { await storage.close(); throw error; }
}

test('pure rules: depth and hourly wakes decide whether a mention wakes', () => {
  for (const [depth, wakesLastHour, expected] of [[1, 0, 'wake'], [2, 1, 'wake'], [3, 0, 'depth'], [1, 2, 'rate'], [3, 5, 'depth']] as const) assert.equal(admit({ depth, wakesLastHour }), expected, `${depth}/${wakesLastHour}`);
  assert.deepEqual(mentionTokens('@Ada can you check? cc @developer, (@ada) mail me at x@y.z'), ['ada', 'developer']);
});

test('who a mention wakes, by target', async () => {
  const cases: { name: string; from: string; target: MentionTarget; expects?: MentionExpects; states?: string[]; queued?: string[]; refused?: RegExp }[] = [
    { name: 'an agent by name', from: 'Bram', target: { type: 'agent', id: 'ada' }, states: ['woken'], queued: ['Ada:reply'] },
    { name: 'a role wakes its holders, never the author', from: 'Bram', target: { type: 'role', id: 'developer' }, states: ['woken'], queued: ['Ada:reply'] },
    { name: 'fyi is recorded and wakes nobody', from: 'Bram', target: { type: 'agent', id: 'Ada' }, expects: 'fyi', states: ['noted'], queued: [] },
    { name: 'a user is noted', from: 'Bram', target: { type: 'user', id: 'someone' }, states: ['noted'], queued: [] },
    { name: 'yourself is nobody', from: 'Ada', target: { type: 'agent', id: 'Ada' }, refused: /Nobody/ },
    { name: 'an unknown role is refused and leaves no message', from: 'Bram', target: { type: 'role', id: 'astronaut' }, refused: /Nobody/ },
  ];
  for (const item of cases) {
    const { storage, db, mentions, projectId, threadId, agents, queued } = await boot();
    try {
      const run = mentions.mention({ projectId, threadId, message: { body: 'A question.' }, author: { kind: 'agent', id: agents[item.from]! }, targets: [item.target], expects: item.expects ?? 'reply' });
      if (item.refused) {
        await assert.rejects(run, item.refused, item.name);
        assert.equal((await db.selectFrom('messages').select('id').where('kind', '=', 'question').where('body', '=', 'A question.').execute()).length, 0, item.name);
        continue;
      }
      assert.deepEqual((await run).mentions.map(mention => mention.state), item.states, item.name);
      assert.deepEqual(await queued(), item.queued, item.name);
      assert.deepEqual((await db.selectFrom('mentions').select(['state', 'depth']).execute()).map(row => ({ ...row })), item.states!.map(state => ({ state, depth: 1 })), item.name);
    } finally { await storage.close(); }
  }
});

test('a teammate’s mention queues behind a person’s: class 3 against class 1', async () => {
  const { storage, db, mentions, projectId, threadId, agents, userId } = await boot();
  try {
    await mentions.mention({ projectId, threadId, message: { body: 'Ada, does the retry keep the key?' }, author: { kind: 'agent', id: agents.Bram! }, targets: [{ type: 'agent', id: 'ada' }], expects: 'reply' });
    await mentions.mention({ projectId, threadId, message: { body: 'Cleo, is staging green?' }, author: { kind: 'user', id: userId }, targets: [{ type: 'agent', id: 'cleo' }], expects: 'reply' });
    const queued = await db.selectFrom('work_items').innerJoin('agents', 'agents.id', 'work_items.agent_id').select(['agents.name', 'work_items.kind', 'work_items.lane', 'work_items.priority_class']).orderBy('work_items.priority_class').execute();
    assert.deepEqual(queued.map(item => ({ ...item })), [{ name: 'Cleo', kind: 'reply', lane: 'bounded', priority_class: 1 }, { name: 'Ada', kind: 'reply', lane: 'bounded', priority_class: 3 }]);
  } finally { await storage.close(); }
});

test('the whole team is every seat but the author', async () => {
  const { storage, mentions, projectId, threadId, agents } = await boot();
  try {
    const result = await mentions.mention({ projectId, threadId, message: { body: 'All hands.' }, author: { kind: 'agent', id: agents.Bram! }, targets: [{ type: 'team', id: 'team' }], expects: 'reply' });
    assert.ok(result.mentions.length >= 2 && result.mentions.every(item => item.state === 'woken' && item.agentId !== agents.Bram));
  } finally { await storage.close(); }
});

test('a third wake within the hour goes to the PM instead, and the hour passes', async () => {
  const { storage, db, mentions, projectId, threadId, agents, pm, queued, tick } = await boot();
  try {
    const ask = async () => (await mentions.mention({ projectId, threadId, message: { body: 'Again.' }, author: { kind: 'agent', id: agents.Bram! }, targets: [{ type: 'agent', id: 'Ada' }], expects: 'reply' })).mentions[0]!;
    assert.deepEqual([(await ask()).state, (await ask()).state], ['woken', 'woken']);
    const third = await ask();
    assert.deepEqual([third.state, third.reason], ['overflow', 'rate']);
    assert.deepEqual(await queued(), ['Ada:reply', 'Ada:reply', `${pm}:triage`]);
    // More overflow does not pile up triage items either.
    await ask();
    assert.deepEqual(await queued(), ['Ada:reply', 'Ada:reply', `${pm}:triage`]);
    assert.equal((await db.selectFrom('events').select('seq').where('type', '=', 'mention.overflowed').execute()).length, 2);
    tick(3600_001);
    assert.equal((await ask()).state, 'woken');
  } finally { await storage.close(); }
});

test('a chain stops at depth two, and a mention is answered once', async () => {
  const { storage, db, mentions, turns, projectId, threadId, agents, pm, queued } = await boot();
  try {
    const mention = (from: string, to: string, turnId: string | null) => mentions.mention({ projectId, threadId, message: { body: `${from} asks ${to}.` }, author: { kind: 'agent', id: agents[from]! }, targets: [{ type: 'agent', id: to }], expects: 'reply', turnId });
    const replyTurn = async () => (await turns.claim({ workerId: 'w1', free: { bounded: 1 }, projects: [projectId] }))!;
    await mention('Bram', 'Ada', null);
    const first = await replyTurn();
    assert.deepEqual([first.kind, first.agentId], ['reply', agents.Ada]);
    const second = (await mention('Ada', 'Cleo', first.turnId)).mentions[0]!;
    assert.equal(second.state, 'woken');
    const owed = (await mentions.owedBy(first.turnId))!;
    await mentions.answer(owed.id, (await db.selectFrom('messages').select('id').executeTakeFirstOrThrow()).id);
    await assert.rejects(mentions.answer(owed.id, 'again'), /one reply/);
    await turns.finish(first.turnId, 'w1', first.leaseToken, { state: 'completed' });
    const deeper = await replyTurn();
    assert.equal(deeper.agentId, agents.Cleo);
    const third = (await mention('Cleo', 'Finn', deeper.turnId)).mentions[0]!;
    assert.deepEqual([third.state, third.reason], ['overflow', 'depth']);
    assert.deepEqual((await db.selectFrom('mentions').select('depth').execute()).map(row => row.depth).sort(), [1, 2, 3]);
    assert.deepEqual(await queued(), [`${pm}:triage`]);
  } finally { await storage.close(); }
});

test('what a human types goes through the same limits', async () => {
  const { storage, db, mentions, projectId, threadId, userId, queued } = await boot();
  try {
    const say = async (body: string) => {
      const id = `m-${body.length}-${Math.random()}`;
      await db.insertInto('messages').values({ id, thread_id: threadId, author_kind: 'user', author_id: userId, kind: 'note', body, payload: '{}', created_at: 1 }).execute();
      return mentions.fromText({ projectId, threadId, message: { id }, author: { kind: 'user', id: userId }, body });
    };
    assert.deepEqual(await say('No names here, just an @unknown word.'), []);
    assert.deepEqual((await say('@Ada and @developer: is staging up?')).map(item => item.state).sort(), ['woken', 'woken']);
    assert.deepEqual(await queued(), ['Ada:reply', 'Bram:reply']);
    await say('@Ada once more');
    assert.deepEqual((await say('@Ada and again')).map(item => [item.state, item.reason]), [['overflow', 'rate']]);
  } finally { await storage.close(); }
});
