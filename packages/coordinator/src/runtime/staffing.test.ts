import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DelegationRules, packageRoot, withinBounds } from '@agent-team/protocol';
import { createStorage } from '@agent-team/storage';
import { createContext } from '../context.ts';
import { newTask } from '../repos/issueTasks.ts';
import { createOrg } from '../repos/org.ts';
import { createVersionedDocs } from '../repos/versionedDocs.ts';
import { createWorkspace } from '../repos/workspace.ts';
import { buildPacket } from './packet.ts';
import { createProposals } from './proposals.ts';
import { staffingSeat } from './staffing.ts';
import { createTurns } from './turns.ts';

const LIBRARY = { type: 'library' as const, id: '' };
const blueprint = (name: string) => JSON.parse(readFileSync(path.join(packageRoot(), 'blueprints', name), 'utf8')) as Record<string, any>;

// The default team (Maren the PM, Ada, Rune) with Toby hired from the library to staff it.
async function boot() {
  const storage = await createStorage({ kind: 'sqlite', path: ':memory:' });
  await storage.migrate();
  const context = createContext({ storage, machineToken: 'x'.repeat(24) });
  const docs = createVersionedDocs(context), library = blueprint('library-agents.json');
  await docs.seed('role', LIBRARY, blueprint('roles.json'));
  await docs.seed('library_agent', LIBRARY, library);
  await docs.seed('team_template', LIBRARY, blueprint('team-templates.json'));
  const projectId = await createWorkspace(context).registerProject({ slug: 'shop', name: 'Shop', kind: 'repo', manifest: {} });
  await createOrg(context).hire('user-1', projectId, { slug: 'toby', doc: library.toby }, { library: 'toby' });
  const db = storage.db, turns = createTurns(context);
  const agents = async () => Object.fromEntries((await db.selectFrom('agents').select(['id', 'name']).where('status', '!=', 'retired').execute()).map(agent => [agent.name, agent.id])) as Record<string, string>;
  const toby = { agent_id: (await agents()).Toby!, project_id: projectId };
  const limits = (staffing: { decides: boolean; maxSeats: number }) => docs.save('delegation_rules', { type: 'project', id: projectId }, 'default', { staffing }, { author: 'owner' });
  return { storage, db, docs, turns, proposals: createProposals(context, turns), agents, toby, projectId, limits };
}
const why = { title: 'Staffing', why: 'Three tasks have waited behind Ada for a day and nobody else may write code.', evidence: [{ label: 'Waiting behind Ada', value: '3 tasks' }] };

test('a hire inside the limits joins the team at once and is on record with its reason', async () => {
  const { storage, db, proposals, agents, toby, projectId } = await boot();
  assert.equal((await staffingSeat(db, projectId))?.name, 'Toby');
  const hired = await proposals.staff(toby, { ...why, change: { kind: 'hire_agent', library: 'gandalf' } });
  assert.equal(hired.state, 'applied');
  assert.equal((await agents()).Gandalf, hired.agentIds[0]);
  assert.deepEqual((await db.selectFrom('agent_roles').select('role_slug').where('agent_id', '=', hired.agentIds[0]!).execute()).map(row => row.role_slug), ['developer']);
  const [record] = await proposals.list([projectId]);
  assert.deepEqual([record!.state, record!.category, record!.proposerAgentId, record!.votes.length], ['auto_applied', 'hire', toby.agent_id, 0]);
  assert.equal(record!.whatChanges, 'Gandalf joins the team from the agent library.');
  const event = await db.selectFrom('events').select(['category', 'agent_id', 'payload']).where('type', '=', 'agent.hired').orderBy('seq', 'desc').executeTakeFirstOrThrow();
  assert.deepEqual([event.category, event.agent_id, JSON.parse(event.payload).by], ['audit', hired.agentIds[0], toby.agent_id]);

  // A seat made for the job wears roles from the library only, and never the PM flag.
  await assert.rejects(proposals.staff(toby, { ...why, change: { kind: 'create_agent', seat: { name: 'Vera', title: 'Release engineer', persona: '', roles: ['wizard'] } } }), /wizard is not in the role library/);
  const made = await proposals.staff(toby, { ...why, change: { kind: 'create_agent', seat: { name: 'Vera', title: 'Release engineer', persona: 'Ships on Thursdays.', roles: ['developer', 'reviewer'] } } });
  assert.equal((await db.selectFrom('agents').select(['title', 'is_pm']).where('id', '=', made.agentIds[0]!).executeTakeFirstOrThrow()).is_pm, false);
  await storage.close();
});

test('beyond the limits the same decision waits for the owner, who approves or declines it', async () => {
  const { storage, proposals, agents, toby, projectId, limits } = await boot();
  await limits({ decides: true, maxSeats: 4 });
  const waiting = await proposals.staff(toby, { ...why, change: { kind: 'hire_agent', library: 'gandalf' } });
  assert.deepEqual([waiting.state, waiting.note, waiting.agentIds], ['needs_owner', 'The team would grow to 5 seats; it may have 4', []]);
  assert.equal((await agents()).Gandalf, undefined);
  await proposals.decide('user-1', waiting.proposalId, 'approve', null);
  assert.ok((await agents()).Gandalf);

  await limits({ decides: false, maxSeats: 20 });
  const asked = await proposals.staff(toby, { ...why, change: { kind: 'set_status', agentId: (await agents()).Rune!, status: 'paused' } });
  assert.deepEqual([asked.state, asked.note], ['needs_owner', 'The owner decides who is on this team']);
  await proposals.decide('user-1', asked.proposalId, 'decline', 'Rune stays');
  assert.equal((await proposals.list([projectId])).find(item => item.id === asked.proposalId)!.state, 'declined');
  await storage.close();
});

test('a seat is never retired out from under the team: not the PM, not the last of a role, not by itself', async () => {
  const { storage, db, proposals, agents, toby } = await boot();
  const ids = await agents();
  await assert.rejects(proposals.staff(toby, { ...why, change: { kind: 'retire_agent', agentId: ids.Maren! } }), /PM/);
  await assert.rejects(proposals.staff(toby, { ...why, change: { kind: 'retire_agent', agentId: 'someone-else' } }), /not a seat of this team/);
  assert.equal((await proposals.staff(toby, { ...why, change: { kind: 'retire_agent', agentId: ids.Ada! } })).note, 'Ada is the only developer on the team');
  assert.equal((await proposals.staff(toby, { ...why, change: { kind: 'retire_agent', agentId: ids.Toby! } })).note, 'A seat does not decide about itself');
  assert.equal((await proposals.staff(toby, { ...why, change: { kind: 'change_seat', agentId: ids.Rune!, roles: ['developer'] } })).note, 'Rune is the only reviewer on the team');
  assert.equal((await proposals.staff(toby, { ...why, change: { kind: 'set_daily_cap', agentId: ids.Ada!, capMinor: 9000 } })).state, 'needs_owner');
  assert.equal((await db.selectFrom('agents').select('status').where('id', '=', ids.Ada!).executeTakeFirstOrThrow()).status, 'active');
  await storage.close();
});

test('a retired seat hands its unfinished tasks back and the PM is woken to place them', async () => {
  const { storage, db, proposals, agents, toby, projectId, turns } = await boot();
  const ids = await agents();
  await proposals.staff(toby, { ...why, change: { kind: 'hire_agent', library: 'gandalf' } });
  const { taskId, key } = await storage.transaction(tx => newTask(tx, { projectId, title: 'Checkout retries', brief: '', ownerId: ids.Ada!, authorAgentId: ids.Maren!, actor: { actorKind: 'agent', agentId: ids.Maren! }, now: Date.now() }));
  await turns.enqueue({ agentId: ids.Ada!, projectId, kind: 'work', taskId, dedupeKey: `work:${taskId}` });

  const gone = await proposals.staff(toby, { ...why, title: 'Retire Ada', change: { kind: 'retire_agent', agentId: ids.Ada! } });
  assert.equal(gone.state, 'applied');
  assert.deepEqual({ ...await db.selectFrom('tasks').select(['state', 'assignee_agent_id']).where('id', '=', taskId).executeTakeFirstOrThrow() }, { state: 'backlog', assignee_agent_id: null });
  assert.deepEqual((await db.selectFrom('work_items').select('state').where('task_id', '=', taskId).execute()).map(row => row.state), ['expired']);
  const note = await db.selectFrom('messages').select('body').where('kind', '=', 'system').where('payload', 'like', '%"staffing":true%').executeTakeFirstOrThrow();
  assert.match(note.body, new RegExp(`Ada has left the team.*${key}.*Maren`));
  assert.equal((await db.selectFrom('work_items').select('kind').where('agent_id', '=', ids.Maren!).where('state', '=', 'queued').execute()).some(item => item.kind === 'triage'), true);
  await storage.close();
});

test('a template adds its seats, keeping the PM the team has', async () => {
  const { storage, db, proposals, toby, limits } = await boot();
  await limits({ decides: true, maxSeats: 20 });
  const before = (await db.selectFrom('agents').select('id').execute()).length;
  const stamped = await proposals.staff(toby, { ...why, change: { kind: 'staff_from_template', template: 'research-desk' } });
  assert.equal(stamped.state, 'applied');
  assert.equal((await db.selectFrom('agents').select('id').execute()).length, before + stamped.agentIds.length);
  assert.equal((await db.selectFrom('agents').select('name').where('is_pm', '=', true).execute()).map(row => row.name).join(), 'Maren');
  await storage.close();
});

test('a vote never settles who is on the team, whatever the proposal calls itself', () => {
  const rules = DelegationRules.parse({});
  assert.equal(withinBounds(rules, 'limits', { kind: 'hire_agent', library: 'gandalf' }), false);
  assert.equal(withinBounds(rules, 'roles', { kind: 'change_seat', agentId: 'a', roles: ['developer'] }), false);
  assert.equal(withinBounds(rules, 'roles', { kind: 'add_role', agentId: 'a', role: 'reviewer' }), true);
});

test('the figures name every seat, the limits and who can be brought in; the seat is told it staffs the team', async () => {
  const { storage, proposals, toby, projectId } = await boot();
  const review = await proposals.review(toby, 14);
  assert.deepEqual(review.limits, { decides: true, maxSeats: 8, maxDailyCapMinor: 1500 });
  assert.deepEqual(review.seats.map(seat => seat.name), ['Maren', 'Ada', 'Rune', 'Toby']);
  assert.ok(review.library.some(item => item.slug === 'gandalf') && review.templates.some(item => item.slug === 'research-desk') && review.roles.some(item => item.slug === 'hr'));
  const thread = await storage.db.selectFrom('threads').select('id').where('project_id', '=', projectId).where('kind', '=', 'discussion').executeTakeFirstOrThrow();
  const packet = (agentId: string) => storage.transaction(tx => buildPacket(tx, { kind: 'reply', agentId, projectId, taskId: null, threadId: thread.id }));
  assert.match((await packet(toby.agent_id)).prompt, /You staff this team/);
  assert.doesNotMatch((await packet(review.seats[1]!.agentId)).prompt, /You staff this team/);
  await storage.close();
});
