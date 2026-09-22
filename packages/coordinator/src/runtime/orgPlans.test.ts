import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { effective, packageRoot, PermissionGrant, permits, TOOLS, type OrgPlan } from '@agent-team/protocol';
import { createStorage } from '@agent-team/storage';
import { createContext } from '../context.ts';
import { createVersionedDocs } from '../repos/versionedDocs.ts';
import { createWorkspace } from '../repos/workspace.ts';
import { createControls } from './controls.ts';
import { buildPacket } from './packet.ts';
import { createOrgPlans, ORG_RULE } from './orgPlans.ts';
import { createTurns } from './turns.ts';

const LIBRARY = { type: 'library' as const, id: '' };
const blueprint = (name: string) => JSON.parse(readFileSync(path.join(packageRoot(), 'blueprints', name), 'utf8')) as Record<string, unknown>;

async function boot() {
  const storage = await createStorage({ kind: 'sqlite', path: ':memory:' });
  await storage.migrate();
  const context = createContext({ storage, machineToken: 'x'.repeat(24) });
  const docs = createVersionedDocs(context);
  await docs.seed('role', LIBRARY, blueprint('roles.json'));
  await docs.seed('library_agent', LIBRARY, blueprint('library-agents.json'));
  await docs.seed('team_template', LIBRARY, blueprint('team-templates.json'));
  const workspace = createWorkspace(context);
  await workspace.registerProject({ slug: 'shop', name: 'Shop', kind: 'repo', manifest: {} });
  const turns = createTurns(context), plans = createOrgPlans(context, turns);
  const home = await plans.ensureHome();
  const threadId = await createControls(context, turns).directThread('user-1', home.agentId, home.projectId);
  const seat = { id: 'turn-1', agent_id: home.agentId, project_id: home.projectId };
  const propose = (plan: OrgPlan) => plans.propose(seat, { ...plan, threadId });
  return { storage, db: storage.db, context, workspace, plans, home, threadId, propose };
}

const SALES: OrgPlan = {
  title: 'A sales desk that works from HubSpot', why: 'The owner wants ten things every day that help sell.',
  steps: [
    { kind: 'create_team', ref: '$sales', name: 'Sales', template: 'sales-desk', charter: { area: 'finding and following up customers from HubSpot', outcomes: ['Ten useful things to act on every day'] } },
    { kind: 'connect_integration', team: '$sales', integration: 'hubspot', roles: ['sales'] },
    { kind: 'set_duty', team: '$sales', owner: 'Sam', title: 'Leads to follow up', brief: 'Leads in HubSpot worth a follow-up this week, with why now.', everyHours: 24, deliverable: { kind: 'record', target: 4 } },
    { kind: 'set_duty', team: '$sales', owner: 'Rita', title: 'Emails to send', brief: 'Follow-up emails ready to send to open deals.', everyHours: 24, deliverable: { kind: 'message', target: 3 } },
  ],
};

test('the organisation has a home of its own that nobody lists, whose seat is told it plans the organisation', async () => {
  const { storage, db, workspace, home } = await boot();
  try {
    const project = await db.selectFrom('projects').select(['kind', 'slug']).where('id', '=', home.projectId).executeTakeFirstOrThrow();
    assert.equal(project.kind, 'org');
    assert.deepEqual((await workspace.projectTree({ userId: 'user-1', orgRole: 'owner', projects: new Map() })).map(item => item.slug), ['shop']);
    const roles = await db.selectFrom('agent_roles').select('role_slug').where('agent_id', '=', home.agentId).execute();
    assert.deepEqual(roles.map(row => row.role_slug), ['chief-of-staff']);
    const packet = await storage.transaction(tx => buildPacket(tx, { kind: 'reply', agentId: home.agentId, projectId: home.projectId, taskId: null, threadId: null }));
    assert.ok(packet.prompt.startsWith(ORG_RULE));
  } finally { await storage.close(); }
});

test('a plan is tried in full before the owner sees it, changes nothing until applied, and applied does every step at once', async () => {
  const { storage, db, plans, home, threadId, propose } = await boot();
  try {
    await assert.rejects(propose({ ...SALES, steps: [{ ...SALES.steps[0]!, template: 'nope' } as OrgPlan['steps'][number]] }), /Step 1 cannot be done: There is no team template called nope/);
    await assert.rejects(propose({ ...SALES, steps: [SALES.steps[2]!] }), /\$sales is not made by an earlier step/);
    const proposed = await propose(SALES);
    assert.equal(proposed.steps, 4);
    assert.equal(await db.selectFrom('projects').select('id').where('name', '=', 'Sales').executeTakeFirst(), undefined, 'a trial run leaves nothing behind');
    const plan = await plans.get(proposed.planId);
    assert.equal(plan.state, 'waiting');
    assert.deepEqual(plan.steps, [
      'Start a team called Sales from the Sales desk template: Vic, Sam, Rita, Onion. It owns finding and following up customers from HubSpot.',
      'Connect HubSpot to Sales, for Rita and Sam. You paste its token afterwards.',
      'Sam on Sales: Leads to follow up, every day, 4 records.',
      'Rita on Sales: Emails to send, every day, 3 messages to send.',
    ]);
    const posted = await db.selectFrom('messages').select(['kind', 'payload', 'author_id']).where('thread_id', '=', threadId).executeTakeFirstOrThrow();
    assert.deepEqual([posted.kind, JSON.parse(posted.payload).orgPlan, posted.author_id], ['proposal', proposed.planId, home.agentId]);

    await plans.apply('user-1', proposed.planId);
    const sales = await db.selectFrom('projects').select(['id', 'kind', 'manifest', 'team_id']).where('name', '=', 'Sales').executeTakeFirstOrThrow();
    assert.equal(sales.kind, 'team');
    assert.equal(JSON.parse(sales.manifest).charter.area, 'finding and following up customers from HubSpot');
    const seats = await db.selectFrom('agents').select(['name', 'is_pm']).where('team_id', '=', sales.team_id!).orderBy('sort').execute();
    assert.deepEqual(seats.map(seat => [seat.name, seat.is_pm]), [['Vic', true], ['Sam', false], ['Rita', false], ['Onion', false]]);
    const connection = await db.selectFrom('connections').select(['kind', 'status', 'config']).where('project_id', '=', sales.id).executeTakeFirstOrThrow();
    assert.deepEqual([connection.kind, connection.status, JSON.parse(connection.config).roles], ['hubspot', 'warning', 'sales']);
    const duties = await db.selectFrom('duties').select(['title', 'deliverable_kind', 'target', 'result_kind']).where('project_id', '=', sales.id).orderBy('title').execute();
    assert.deepEqual(duties.map(duty => [duty.title, duty.deliverable_kind, duty.target, duty.result_kind]), [['Emails to send', 'message', 3, 'deliverables'], ['Leads to follow up', 'record', 4, 'deliverables']]);
    // The new team's PM hears what it owns and is started on it.
    const handed = await db.selectFrom('messages').innerJoin('threads', 'threads.id', 'messages.thread_id').select('messages.body').where('threads.project_id', '=', sales.id).executeTakeFirstOrThrow();
    assert.match(handed.body, /Sales now owns finding and following up customers from HubSpot/);
    assert.ok(await db.selectFrom('work_items').select('id').where('project_id', '=', sales.id).where('kind', '=', 'triage').executeTakeFirst());
    assert.equal((await plans.get(proposed.planId)).state, 'applied');
    await assert.rejects(plans.apply('user-1', proposed.planId), /already applied/);
    assert.ok(await db.selectFrom('events').select('seq').where('type', '=', 'org.plan_applied').where('category', '=', 'audit').executeTakeFirst());
  } finally { await storage.close(); }
});

test('more developers for a team, a new plan replacing the one still waiting, and a dismissed plan changing nothing', async () => {
  const { storage, db, plans, propose } = await boot();
  try {
    const first = await propose({ title: 'Two more developers', why: 'The shop is short of hands.', steps: [{ kind: 'hire', team: 'shop', library: 'gandalf', count: 2 }] });
    const second = await propose({ title: 'Three more developers', why: 'The shop is short of hands.', steps: [{ kind: 'hire', team: 'shop', library: 'gandalf', count: 3 }] });
    assert.equal((await plans.get(first.planId)).state, 'replaced');
    assert.deepEqual((await plans.get(second.planId)).steps, ['3 × Gandalf (Developer) join Shop.']);
    await plans.apply('user-1', second.planId);
    const shop = await db.selectFrom('projects').select('team_id').where('slug', '=', 'shop').executeTakeFirstOrThrow();
    assert.equal((await db.selectFrom('agents').select('id').where('team_id', '=', shop.team_id!).where('name', '=', 'Gandalf').execute()).length, 3);

    const third = await propose({ title: 'A research team', why: 'Maybe later.', steps: [{ kind: 'create_team', ref: '$research', name: 'Research', template: 'research-desk', charter: { area: 'what customers say about the product', outcomes: [] } }] });
    await plans.dismiss('user-1', third.planId);
    assert.equal(await db.selectFrom('projects').select('id').where('name', '=', 'Research').executeTakeFirst(), undefined);
    await assert.rejects(plans.apply('user-1', third.planId), /already dismissed/);
  } finally { await storage.close(); }
});

test('only a role that may plan the organisation gets its tools', () => {
  const roles = blueprint('roles.json') as Record<string, { permissions: unknown }>;
  const grants = (slug: string) => effective([PermissionGrant.parse(roles[slug]!.permissions)]);
  assert.equal(permits(grants('chief-of-staff'), TOOLS['org.plan'].permission), true);
  for (const slug of ['hr', 'pm', 'front-desk', 'sales']) assert.equal(permits(grants(slug), TOOLS['org.plan'].permission), false, slug);
});

test('a seat is made only with roles of the role library, and a team with nobody to start is said, not turned into a failure', async () => {
  const { storage, db, plans, threadId, propose } = await boot();
  try {
    await assert.rejects(propose({ title: 'Outreach', why: 'Cold outreach.', steps: [{ kind: 'create_team', ref: '$out', name: 'Outreach', charter: { area: 'first messages to new accounts', outcomes: [] }, seats: [{ name: 'Sid', title: 'Lead', persona: '', roles: ['pm'], isPm: true }, { name: 'Pia', title: 'Caller', persona: '', roles: ['sdr'], isPm: false }] }] }), /Step 1 cannot be done: sdr is not in the role library/);

    const shop = await db.selectFrom('projects').select('team_id').where('slug', '=', 'shop').executeTakeFirstOrThrow();
    await db.updateTable('agents').set({ status: 'paused' }).where('team_id', '=', shop.team_id!).where('is_pm', '=', true).execute();
    const plan = await propose({ title: 'The shop owns checkout', why: 'Nobody owns it.', steps: [{ kind: 'set_charter', team: 'shop', charter: { area: 'the checkout', outcomes: [] } }] });
    await plans.apply('user-1', plan.planId);
    assert.equal((await plans.get(plan.planId)).state, 'applied');
    const said = await db.selectFrom('messages').select('body').where('thread_id', '=', threadId).where('author_kind', '=', 'system').orderBy('seq', 'desc').executeTakeFirstOrThrow();
    assert.equal(said.body, 'Applied: The shop owns checkout. Shop has no PM at work, so nobody was started on it yet.');
  } finally { await storage.close(); }
});
