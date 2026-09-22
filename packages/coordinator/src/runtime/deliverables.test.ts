import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { packageRoot } from '@agent-team/protocol';
import { createStorage } from '@agent-team/storage';
import { createContext } from '../context.ts';
import { stampTemplate } from '../repos/org.ts';
import { createVersionedDocs } from '../repos/versionedDocs.ts';
import { createWorkspace } from '../repos/workspace.ts';
import { createDeliverables } from './deliverables.ts';
import { createDuties } from './duties.ts';
import { buildPacket } from './packet.ts';
import { createTurns } from './turns.ts';

const HOUR = 3600_000;
const LIBRARY = { type: 'library' as const, id: '' };
const blueprint = (name: string) => JSON.parse(readFileSync(path.join(packageRoot(), 'blueprints', name), 'utf8')) as Record<string, unknown>;

// A sales desk (Vic the PM, Sam and Rita in sales, Onion the editor) in a project with no repository.
async function boot() {
  const storage = await createStorage({ kind: 'sqlite', path: ':memory:' });
  await storage.migrate();
  let clock = Date.UTC(2026, 5, 1, 7);
  const context = createContext({ storage, machineToken: 'x'.repeat(24), now: () => clock });
  await createVersionedDocs(context).seed('role', LIBRARY, blueprint('roles.json'));
  const db = storage.db, workspace = createWorkspace(context);
  const projectId = await workspace.registerProject({ slug: 'sales', name: 'Sales', kind: 'team', manifest: {} });
  await storage.transaction(async tx => {
    const { teamId } = { teamId: (await tx.selectFrom('projects').select('team_id').where('id', '=', projectId).executeTakeFirstOrThrow()).team_id! };
    await tx.updateTable('agents').set({ status: 'retired', is_pm: false }).where('team_id', '=', teamId).execute();
    const template = (blueprint('team-templates.json')['sales-desk'] as { seats: { name: string; title: string; persona: string; roles: string[]; isPm: boolean }[] });
    await stampTemplate(tx, () => clock, projectId, { slug: 'sales-desk', version: 1, name: 'Sales', seats: template.seats }, 'append');
  });
  const agents = Object.fromEntries((await db.selectFrom('agents').select(['id', 'name']).where('status', '=', 'active').execute()).map(row => [row.name, row.id])) as Record<string, string>;
  const turns = createTurns(context);
  const turnOf = (agent: string, taskId: string) => ({ id: `turn-${agent}-${clock}`, agent_id: agents[agent]!, project_id: projectId, task_id: taskId });
  return { storage, db, context, projectId, agents, turnOf, duties: createDuties(context, turns), deliverables: createDeliverables(context, turns), tick: (ms: number) => { clock += ms; } };
}
const lead = (name: string) => ({ kind: 'record' as const, title: `${name} at Northwind`, body: `${name} opened the pricing page three times this week; their contract renews in May.`, fields: { name } });

test('a duty that asks for records opens a round, counts what the editor approves, and sends back what falls short', async () => {
  const { storage, db, projectId, agents, turnOf, duties, deliverables, tick } = await boot();
  try {
    await duties.set(projectId, { title: 'Leads to follow up', brief: 'Leads worth a call this week, with why now.', ownerAgentId: agents.Sam!, everyHours: 24, result: 'document', deliverable: { kind: 'record', target: 3 } });
    assert.equal(await duties.sweep(), 1);
    const task = await db.selectFrom('tasks').select(['id', 'state', 'result_kind', 'brief', 'assignee_agent_id']).where('tag', '=', 'duty').executeTakeFirstOrThrow();
    assert.deepEqual([task.result_kind, task.assignee_agent_id], ['deliverables', agents.Sam]);
    assert.match(task.brief, /This round asks for 3 records/);
    const sam = turnOf('Sam', task.id);
    const work = await storage.transaction(tx => buildPacket(tx, { kind: 'work', agentId: agents.Sam!, projectId, taskId: task.id, threadId: null }));
    assert.match(work.prompt, /deliverable\.submit/);
    assert.match(work.prompt, /It asks for 3 records\. Approved so far: 0/);

    await assert.rejects(deliverables.submit(sam, { ...lead('Ana'), fields: {} }), /A record needs name in fields/);
    await assert.rejects(deliverables.submit(sam, { kind: 'message', title: 'Hello there', body: 'Hi', fields: { to: 'a@b.c', subject: 'Hi' } }), /This round asks for records, not messages to send/);
    await assert.rejects(deliverables.submit(turnOf('Rita', task.id), lead('Ana')), /Only the owner/);
    for (const name of ['Ana', 'Ben', 'Cy']) await deliverables.submit(sam, lead(name));
    await assert.rejects(deliverables.submit(sam, lead('Ana')), /already handed in/);

    assert.equal((await deliverables.handIn(sam)).state, 'in_review');
    const review = await db.selectFrom('work_items').select(['agent_id', 'kind']).where('task_id', '=', task.id).where('kind', '=', 'review').executeTakeFirstOrThrow();
    assert.equal(review.agent_id, agents.Onion, 'the editor judges them');
    const onion = turnOf('Onion', task.id);
    const judging = await storage.transaction(tx => buildPacket(tx, { kind: 'review', agentId: agents.Onion!, projectId, taskId: task.id, threadId: null }));
    assert.match(judging.prompt, /Deliverables to judge \(3; the round asks for 3\)/);
    const items = await db.selectFrom('deliverables').select(['id', 'title']).where('task_id', '=', task.id).orderBy('title').execute();
    await assert.rejects(deliverables.review(onion, [{ deliverableId: items[0]!.id, verdict: 'pass', note: 'Good reason to call.' }]), /Judge every deliverable in one call/);
    await assert.rejects(deliverables.review(sam, items.map(item => ({ deliverableId: item.id, verdict: 'pass' as const, note: 'ok' }))), /does not review their own work/);
    const judged = await deliverables.review(onion, items.map((item, index) => ({ deliverableId: item.id, verdict: index === 2 ? 'changes' as const : 'pass' as const, note: index === 2 ? 'No reason to call now.' : 'Good reason to call.' })));
    assert.deepEqual(judged, { approved: 2, rejected: 1, target: 3, state: 'in_progress' });
    assert.ok(await db.selectFrom('work_items').select('id').where('task_id', '=', task.id).where('kind', '=', 'work').where('agent_id', '=', agents.Sam!).where('state', '=', 'queued').executeTakeFirst(), 'its owner is started again');
    const again = await storage.transaction(tx => buildPacket(tx, { kind: 'work', agentId: agents.Sam!, projectId, taskId: task.id, threadId: null }));
    assert.match(again.prompt, /Sent back\n- Cy at Northwind: No reason to call now\./);

    await deliverables.submit(sam, lead('Dee'));
    await deliverables.handIn(sam);
    const last = await db.selectFrom('deliverables').select('id').where('task_id', '=', task.id).where('state', '=', 'submitted').execute();
    assert.equal((await deliverables.review(turnOf('Onion', task.id), last.map(item => ({ deliverableId: item.id, verdict: 'pass' as const, note: 'Worth a call.' })))).state, 'done');
    const [round] = await deliverables.progress([projectId]);
    assert.deepEqual([round!.title, round!.approved, round!.target, round!.task?.state], ['Leads to follow up', 3, 3, 'done']);
    tick(24 * HOUR + 1000);
    assert.equal(await duties.sweep(), 1, 'the next round comes');
    assert.equal((await deliverables.progress([projectId]))[0]!.approved, 0);
  } finally { await storage.close(); }
});

test('an approved message waits as a handoff for a person to send, an approved card goes on the board, and a round ends short when the next comes', async () => {
  const { storage, db, projectId, agents, turnOf, duties, deliverables, tick } = await boot();
  try {
    await duties.set(projectId, { title: 'Emails to send', brief: 'Follow-ups to open deals.', ownerAgentId: agents.Rita!, everyHours: 24, result: 'document', deliverable: { kind: 'message', target: 1 } });
    await duties.sweep();
    const task = await db.selectFrom('tasks').select('id').where('tag', '=', 'duty').executeTakeFirstOrThrow();
    const rita = turnOf('Rita', task.id);
    await assert.rejects(deliverables.submit(rita, { kind: 'message', title: 'Renewal', body: 'Hi Ana', fields: { to: 'ana@northwind.test' } }), /needs subject/);
    await deliverables.submit(rita, { kind: 'message', title: 'Renewal', body: 'Hi Ana, shall we look at May together?', link: 'https://app.hubspot.com/contacts/1/record/0-1/51', fields: { to: 'ana@northwind.test', subject: 'Your renewal in May' } });
    await deliverables.handIn(rita);
    const [item] = await db.selectFrom('deliverables').select('id').where('task_id', '=', task.id).execute();
    await deliverables.review(turnOf('Onion', task.id), [{ deliverableId: item!.id, verdict: 'pass', note: 'Clear ask, right tone.' }]);
    const handoff = await db.selectFrom('handoffs').select(['direction', 'state', 'title', 'summary', 'context']).where('project_id', '=', projectId).executeTakeFirstOrThrow();
    assert.deepEqual([handoff.direction, handoff.state, handoff.title], ['out', 'outbox', 'Your renewal in May']);
    assert.equal(JSON.parse(handoff.context).to, 'ana@northwind.test');

    // Cards become tasks in the backlog once approved; one the owner sends back does not.
    await duties.set(projectId, { title: 'Ideas for the site', brief: 'Cards the web team could build.', ownerAgentId: agents.Sam!, everyHours: 24, result: 'document', deliverable: { kind: 'card', target: 2 } });
    await duties.sweep();
    const cards = await db.selectFrom('tasks').select('id').where('title', 'like', 'Ideas for the site%').executeTakeFirstOrThrow();
    const sam = turnOf('Sam', cards.id);
    const one = await deliverables.submit(sam, { kind: 'card', title: 'Pricing page FAQ', body: 'Answer the three questions leads ask most.', fields: {} });
    await deliverables.submit(sam, { kind: 'card', title: 'Case study page', body: 'One customer story per industry.', fields: {} });
    await deliverables.decide('user-1', projectId, one.deliverableId, 'pass', null);
    assert.equal((await db.selectFrom('tasks').select('state').where('title', '=', 'Pricing page FAQ').executeTakeFirstOrThrow()).state, 'backlog');

    // The round is not finished when the next one comes: it closes short and what was never judged does not count.
    tick(24 * HOUR + 1000);
    await duties.sweep();
    assert.equal((await db.selectFrom('tasks').select('state').where('id', '=', cards.id).executeTakeFirstOrThrow()).state, 'canceled');
    assert.equal((await db.selectFrom('deliverables').select('state').where('title', '=', 'Case study page').executeTakeFirstOrThrow()).state, 'rejected');
    assert.equal(await db.selectFrom('tasks').select('id').where('title', '=', 'Case study page').executeTakeFirst(), undefined);
  } finally { await storage.close(); }
});

test('a duty that asks for changes opens no task: its PM is told the target and changes merged since the round began count', async () => {
  const { storage, db, projectId, agents, duties, deliverables } = await boot();
  try {
    await duties.set(projectId, { title: 'Ship every day', brief: 'Small changes that customers notice.', ownerAgentId: agents.Vic!, everyHours: 24, result: 'change', deliverable: { kind: 'change', target: 2 } });
    await duties.sweep();
    assert.equal(await db.selectFrom('tasks').select('id').where('tag', '=', 'duty').executeTakeFirst(), undefined);
    const note = await db.selectFrom('messages').select('body').where('kind', '=', 'system').orderBy('seq', 'desc').executeTakeFirstOrThrow();
    assert.match(note.body, /Ship every day: this round asks for 2 changes merged\./);
    assert.equal((await db.selectFrom('work_items').select('agent_id').where('kind', '=', 'triage').executeTakeFirstOrThrow()).agent_id, agents.Vic);
    await storage.transaction(async tx => {
      const { newTask } = await import('../repos/issueTasks.ts');
      const made = await newTask(tx, { projectId, title: 'Faster checkout', brief: 'x', ownerId: agents.Sam!, authorAgentId: null, actor: { actorKind: 'system' }, now: Date.UTC(2026, 5, 1, 9) });
      await tx.updateTable('tasks').set({ state: 'done', updated_at: Date.UTC(2026, 5, 1, 9) }).where('id', '=', made.taskId).execute();
    });
    assert.equal((await deliverables.progress([projectId]))[0]!.approved, 1);
  } finally { await storage.close(); }
});
