import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { TurnKind } from '@agent-team/protocol';
import { seedDemo } from '../demo/seed.ts';
import { startCoordinator } from '../server.ts';
import { buildPacket, keepTo, PACKET_BUDGET } from './packet.ts';

// What each kind of turn is sent, word for word, on the demo team: a change to a rule, a skill or how a packet is put together
// shows here as a change a reviewer reads, with its size. `UPDATE_PACKETS=1 npm test` writes them again after a change you meant.
const FOLDER = path.join(import.meta.dirname, 'packets');
const steady = (text: string) => text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>').replace(/\b\d{13}\b/g, '<time>');

test('every kind of turn is sent what its snapshot says', async () => {
  const coordinator = await startCoordinator({ port: 0, storage: { kind: 'sqlite', path: ':memory:' }, machineToken: 'machine-token-for-tests-0123456789', webRoot: null, trackers: null });
  try {
    await seedDemo(coordinator.context);
    const db = coordinator.context.storage.db;
    const project = await db.selectFrom('projects').select('id').where('slug', '=', 'checkout-v2').executeTakeFirstOrThrow();
    const thread = await db.selectFrom('threads').select('id').where('project_id', '=', project.id).where('kind', '=', 'discussion').executeTakeFirstOrThrow();
    const agents = Object.fromEntries((await db.selectFrom('agents').select(['id', 'name']).execute()).map(row => [row.name, row.id])) as Record<string, string>;
    // The roles a team made from the default blueprint wears, so each packet carries the skills a real turn does.
    await db.deleteFrom('agent_roles').execute();
    await db.insertInto('agent_roles').values([['Maren', 'pm'], ['Ada', 'developer'], ['Bram', 'developer'], ['Cleo', 'reviewer']].map(([name, role]) => ({ agent_id: agents[name!]!, role_slug: role! }))).execute();
    const tasks = Object.fromEntries((await db.selectFrom('tasks').select(['id', 'key']).where('project_id', '=', project.id).execute()).map(row => [row.key, row.id])) as Record<string, string>;
    const turns: [TurnKind, string, { task?: string; thread?: boolean }][] = [
      ['work', 'Ada', { task: 'CK-27' }], ['review', 'Cleo', { task: 'CK-28' }], ['triage', 'Maren', { thread: true }], ['reply', 'Bram', { thread: true }],
      ['retro', 'Maren', { thread: true }], ['ideate', 'Maren', {}], ['feedback', 'Cleo', {}], ['revise', 'Bram', {}], ['conclude', 'Maren', {}], ['remember', 'Maren', { task: 'CK-28' }],
    ];
    mkdirSync(FOLDER, { recursive: true });
    for (const [kind, name, on] of turns) {
      const packet = await coordinator.context.storage.transaction(tx => buildPacket(tx, { kind, agentId: agents[name]!, projectId: project.id, taskId: on.task ? tasks[on.task]! : null, threadId: on.thread ? thread.id : null }));
      assert.ok(packet.system.length + packet.prompt.length <= PACKET_BUDGET[kind]! * 4, `the ${kind} packet is within its budget`);
      const text = steady(`${kind} turn for ${name}: ${packet.system.length} characters of standing instructions, ${packet.prompt.length} of prompt\n\n=== system\n${packet.system}\n\n=== prompt\n${packet.prompt}\n`);
      const file = path.join(FOLDER, `${kind}.txt`);
      if (process.env.UPDATE_PACKETS === '1') writeFileSync(file, text);
      assert.ok(existsSync(file), `no snapshot of the ${kind} packet yet: run UPDATE_PACKETS=1 npm test`);
      assert.equal(text, readFileSync(file, 'utf8'), `the ${kind} packet changed; if you meant it, run UPDATE_PACKETS=1 npm test and review the difference`);
    }
  } finally { await coordinator.close(); }
});

test('a packet keeps to the budget of its kind by shortening its longest context, never its rule', () => {
  const rule = 'R'.repeat(2000), system = 'S'.repeat(8000);
  const parts = keepTo('feedback', system, [rule, 'a'.repeat(500), 'b'.repeat(6000), 'c'.repeat(300)]);
  assert.equal(parts[0], rule);
  assert.equal(parts[3], 'c'.repeat(300));
  assert.ok(system.length + parts.join('\n\n').length <= PACKET_BUDGET.feedback! * 4);
  assert.match(parts[2]!, /^b+…$/);
  assert.deepEqual(keepTo('feedback', '', ['short']), ['short'], 'a packet within its budget is left as it is');
});
