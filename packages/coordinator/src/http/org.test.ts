import test from 'node:test';
import assert from 'node:assert/strict';
import { newId } from '@agent-team/protocol';
import { PROVIDERS } from '../../../../adapters/engine/providers.ts';
import { effectiveProjects } from '../repos/org.ts';
import { boot } from './testing.ts';

test('errors always carry code and message, with the wrong fields named', async () => {
  const { coordinator, call, owner, project } = await boot();
  try {
    const cookie = await owner();
    await project('shop');
    const invalid = await call('/api/projects/shop/milestones', { cookie, body: { label: '' } });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.error.code, 'invalid');
    assert.ok(invalid.json.error.message);
    assert.ok(invalid.json.error.fields.label);
    for (const response of [await call('/api/nothing-here', { cookie }), await call('/api/nothing-here', { cookie, body: {} }), await call('/api/me'), await call('/api/projects/none/settings', { cookie })]) {
      assert.equal(typeof response.json.error.code, 'string', response.text);
      assert.equal(typeof response.json.error.message, 'string');
    }
  } finally { await coordinator.close(); }
});

test('Idempotency-Key: the same key from the same person creates once and answers the same', async () => {
  const { coordinator, db, call, owner, person, project } = await boot();
  try {
    const cookie = await owner();
    const projectId = await project('shop');
    const other = await person('admin', 'admin');
    const create = (who: string, key: string, label: string) => call('/api/projects/shop/milestones', { cookie: who, headers: { 'idempotency-key': key }, body: { label } });
    const first = await create(cookie, 'key-0000-0001', 'Beta');
    const again = await create(cookie, 'key-0000-0001', 'Beta');
    assert.equal(first.status, 200);
    assert.deepEqual(again.json, first.json);
    assert.equal(again.headers.get('idempotent-replayed'), 'true');
    assert.equal((await db.selectFrom('milestones').select('id').where('project_id', '=', projectId).execute()).length, 1);
    // Another person's use of the same key is their own request; a different body under the same key is refused.
    assert.notEqual((await create(other.cookie, 'key-0000-0001', 'Beta')).json.id, first.json.id);
    assert.equal((await create(cookie, 'key-0000-0001', 'Gamma')).status, 422);
    // A refused request frees its key, so the corrected one goes through.
    assert.equal((await create(cookie, 'key-0000-0002', '')).status, 400);
    assert.equal((await call('/api/projects/shop/milestones', { cookie, headers: { 'idempotency-key': 'key-0000-0002' }, body: { label: '' } })).status, 400);
    const stored = await db.selectFrom('idempotency_keys').selectAll().where('key', '=', 'key-0000-0001').execute();
    assert.equal(stored.length, 2);
    assert.ok(stored.every(row => Number(row.expires_at) > Date.now()));
    // An expired key is forgotten.
    await db.updateTable('idempotency_keys').set({ expires_at: 1 }).execute();
    assert.notEqual((await create(cookie, 'key-0000-0001', 'Beta')).json.id, first.json.id);
  } finally { await coordinator.close(); }
});

test('If-Match on versioned documents answers 412 on a mismatch', async () => {
  const { coordinator, db, call, owner, project } = await boot();
  try {
    const cookie = await owner();
    await project('shop');
    const save = (path: string, doc: unknown, version?: string) => call(path, { cookie, headers: version === undefined ? {} : { 'if-match': version }, body: { doc } });
    assert.equal((await call('/api/projects/shop/settings', { cookie })).json.version, 0);
    assert.equal((await save('/api/projects/shop/settings', { description: 'One' }, '0')).json.version, 1);
    const stale = await save('/api/projects/shop/settings', { description: 'Two' }, '0');
    assert.equal(stale.status, 412);
    assert.equal(stale.json.error.code, 'precondition_failed');
    assert.equal((await save('/api/projects/shop/settings', { description: 'Two' }, '"1"')).json.version, 2);
    assert.equal((await save('/api/projects/shop/settings', { description: 'Two' }, 'abc')).status, 400);
    const read = await call('/api/projects/shop/settings', { cookie });
    assert.equal(read.json.settings.description, 'Two');
    assert.equal(read.json.history.length, 2);

    const role = (await call('/api/roles', { cookie })).json.roles[0];
    assert.equal((await save(`/api/roles/${role.slug}`, role.doc, String(role.version + 5))).status, 412);
    assert.equal((await save(`/api/roles/${role.slug}`, role.doc, String(role.version))).json.version, role.version + 1);
    const template = { name: 'Pair', seats: [{ name: 'Ada', roles: ['developer'] }] };
    assert.equal((await save('/api/templates/pair', template, '3')).status, 412);
    assert.equal((await save('/api/templates/pair', template, '0')).json.version, 1);
    const changed = await db.selectFrom('events').select('user_id').where('type', '=', 'settings.changed').execute();
    assert.ok(changed.length >= 4 && changed.every(event => event.user_id), 'every save names who made it');
  } finally { await coordinator.close(); }
});

test('lists that grow page by cursor: messages, issues, audit and events', async () => {
  const { coordinator, db, call, owner, project } = await boot();
  try {
    const cookie = await owner();
    const projectId = await project('shop');
    const thread = await db.selectFrom('threads').select('id').where('project_id', '=', projectId).executeTakeFirstOrThrow();
    for (const body of ['one', 'two', 'three']) await call(`/api/threads/${thread.id}/messages`, { cookie, body: { body } });
    const page1 = await call(`/api/threads/${thread.id}/messages?limit=2`, { cookie });
    assert.deepEqual(page1.json.messages.map((message: any) => message.body), ['one', 'two']);
    const page2 = await call(`/api/threads/${thread.id}/messages?limit=2&after=${page1.json.next}`, { cookie });
    assert.deepEqual(page2.json.messages.map((message: any) => message.body), ['three']);
    assert.equal(page2.json.next, null);
    assert.equal((await call(`/api/threads/${thread.id}/messages?limit=0`, { cookie })).status, 400);

    for (const title of ['A', 'B', 'C']) assert.equal((await call('/api/projects/shop/issues', { cookie, body: { title, body: 'It broke' } })).status, 200);
    const issues1 = await call('/api/projects/shop/issues?limit=2', { cookie });
    assert.deepEqual(issues1.json.issues.map((issue: any) => issue.title), ['C', 'B']);
    const issues2 = await call(`/api/projects/shop/issues?limit=2&after=${issues1.json.next}`, { cookie });
    assert.deepEqual(issues2.json.issues.map((issue: any) => issue.title), ['A']);
    assert.equal(issues2.json.next, null);

    const events1 = await call('/api/events?limit=2', { cookie });
    assert.equal(events1.json.events.length, 2);
    const events2 = await call(`/api/events?limit=200&after=${events1.json.next}`, { cookie });
    assert.ok(events2.json.events.length > 0 && events2.json.events[0].seq > events1.json.events[1].seq);
    assert.equal(events2.json.next, null);
    assert.ok([...events1.json.events, ...events2.json.events].every((event: any) => event.category === 'domain'));
  } finally { await coordinator.close(); }
});

test('audit is a filtered, paged view of the log with actor, action, target and time', async () => {
  const { coordinator, call, owner, person, project } = await boot();
  try {
    const cookie = await owner();
    await project('shop');
    const member = await person('member', 'member');
    await call('/api/invites', { cookie, body: { email: 'new@example.com', orgRole: 'viewer' } });
    await call(`/api/users/${member.id}`, { cookie, body: { orgRole: 'viewer' } });
    await call('/api/projects/shop/status', { cookie, body: { status: 'paused' } });

    const all = await call('/api/audit', { cookie });
    const actions = all.json.entries.map((entry: any) => entry.action);
    assert.deepEqual(actions.slice(0, 3), ['project.status_changed', 'member.role_changed', 'member.invited'], 'newest first');
    const invited = all.json.entries.find((entry: any) => entry.action === 'member.invited');
    assert.equal(invited.actor.name, 'Owner');
    assert.equal(invited.target, 'new@example.com');
    assert.ok(invited.at > 0);
    assert.equal(all.json.entries[0].project.name, 'shop');

    const first = await call('/api/audit?limit=2', { cookie });
    const second = await call(`/api/audit?limit=2&after=${first.json.next}`, { cookie });
    assert.equal(first.json.entries.length, 2);
    assert.ok(second.json.entries[0].seq < first.json.entries[1].seq);
    assert.deepEqual((await call('/api/audit?type=member.', { cookie })).json.entries.map((entry: any) => entry.action), ['member.role_changed', 'member.invited']);
    assert.equal((await call(`/api/audit?actor=${member.id}`, { cookie })).json.entries.length, 1, 'only the sign-in the member made');
    assert.equal((await call('/api/audit?from=2999-01-01', { cookie })).json.entries.length, 0);
    assert.equal((await call('/api/audit', { cookie: member.cookie })).status, 403);
  } finally { await coordinator.close(); }
});

test('members: roles, disabling, invitations and per-project grants', async () => {
  const { coordinator, call, owner, person, project } = await boot();
  try {
    const cookie = await owner();
    const projectId = await project('shop');
    const admin = await person('admin', 'admin'), member = await person('member', 'member');
    const ownerId = (await call('/api/me', { cookie })).json.user.id;
    // An admin manages members and viewers, never admins or the owner; nobody edits their own account.
    assert.equal((await call(`/api/users/${member.id}`, { cookie: admin.cookie, body: { orgRole: 'viewer' } })).status, 200);
    assert.equal((await call(`/api/users/${member.id}`, { cookie: admin.cookie, body: { orgRole: 'admin' } })).status, 403);
    assert.equal((await call(`/api/users/${ownerId}`, { cookie: admin.cookie, body: { status: 'disabled' } })).status, 403);
    assert.equal((await call(`/api/users/${ownerId}`, { cookie, body: { orgRole: 'member' } })).status, 409);

    assert.equal((await call('/api/projects/shop/members', { cookie, body: { userId: member.id, role: 'member' } })).status, 200);
    assert.equal((await call('/api/projects/shop', { cookie: member.cookie })).status, 200);
    const listed = await call('/api/users', { cookie });
    assert.deepEqual(listed.json.users.find((user: any) => user.id === member.id).projects, [{ projectId, slug: 'shop', name: 'shop', role: 'member' }]);
    assert.equal((await call('/api/projects/shop/members', { cookie })).json.members.length, 1);
    assert.equal((await call('/api/projects/shop/members', { cookie, body: { userId: member.id, role: null } })).status, 200);
    assert.equal((await call('/api/projects/shop', { cookie: member.cookie })).status, 403);

    // Disabling ends the person's sessions at once.
    assert.equal((await call(`/api/users/${member.id}`, { cookie, body: { status: 'disabled' } })).status, 200);
    assert.equal((await call('/api/me', { cookie: member.cookie })).status, 401);

    const invite = await call('/api/invites', { cookie, body: { email: 'new@example.com', orgRole: 'member' } });
    const pending = (await call('/api/users', { cookie })).json.invites;
    assert.equal(pending.length, 1);
    assert.equal((await call(`/api/invites/${pending[0].id}/revoke`, { cookie, method: 'POST' })).status, 200);
    assert.equal((await call(`/api/auth${invite.json.path.replace('/invite/', '/invites/')}`, { body: { name: 'New', password: 'another-long-password' } })).status, 403);
  } finally { await coordinator.close(); }
});

test('milestones, project links and status', async () => {
  const { coordinator, db, call, owner, project } = await boot();
  try {
    const cookie = await owner();
    const shop = await project('shop'), site = await project('site');
    const due = Date.UTC(2030, 0, 1);
    const created = await call('/api/projects/shop/milestones', { cookie, body: { label: 'Beta', dueAt: due } });
    await db.insertInto('tasks').values(['done', 'backlog'].map((state, index) => ({ id: newId(), project_id: shop, key: `T-${index}`, source: 'internal', title: 'x', brief: '', tag: null, priority: 0, milestone_id: created.json.id as string, state, assignee_agent_id: null, author_agent_id: null, branch: null, head_sha: null, pr_url: null, blocked_reason: null, created_at: 1, updated_at: 1 }))).execute();
    assert.deepEqual((await call('/api/projects/shop/milestones', { cookie })).json.milestones, [{ id: created.json.id, projectId: shop, label: 'Beta', dueAt: due, state: 'open', tasks: 2, done: 1 }]);
    assert.equal((await call(`/api/milestones/${created.json.id}`, { cookie, body: { state: 'done' } })).status, 200);
    assert.equal((await call('/api/projects/shop/milestones', { cookie })).json.milestones[0].state, 'done');
    assert.equal((await call(`/api/milestones/${created.json.id}/delete`, { cookie, method: 'POST' })).status, 200);
    assert.equal((await db.selectFrom('tasks').select('milestone_id').where('project_id', '=', shop).execute()).every(task => task.milestone_id === null), true);

    const link = await call('/api/org/links', { cookie, body: { fromProjectId: shop, toProjectId: site, note: 'needs the new checkout' } });
    assert.equal((await call('/api/org/links', { cookie, body: { fromProjectId: shop, toProjectId: site } })).status, 409);
    assert.equal((await call('/api/org/links', { cookie, body: { fromProjectId: shop, toProjectId: shop } })).status, 400);
    assert.deepEqual((await call('/api/org/structure', { cookie })).json.links, [{ id: link.json.id, fromProjectId: shop, toProjectId: site, kind: 'depends_on', note: 'needs the new checkout' }]);
    assert.equal((await call(`/api/org/links/${link.json.id}/delete`, { cookie, method: 'POST' })).status, 200);

    assert.equal((await call('/api/projects/shop/status', { cookie, body: { status: 'archived' } })).status, 200);
    assert.deepEqual((await call('/api/projects', { cookie })).json.projects.map((node: any) => node.slug), ['site']);
    // An archived project is found again on the Org page and restored from there.
    assert.deepEqual((await call('/api/org/archived', { cookie })).json.projects, [{ id: shop, slug: 'shop', name: 'shop', kind: 'repo', parentName: null }]);
    assert.equal((await call('/api/projects/shop/status', { cookie, body: { status: 'active' } })).status, 200);
    assert.deepEqual([(await call('/api/org/archived', { cookie })).json.projects, (await call('/api/projects', { cookie })).json.projects.map((node: any) => node.slug).sort()], [[], ['shop', 'site']]);
    assert.equal((await call('/api/projects/shop/status', { cookie, body: { status: 'archived' } })).status, 200);

    // Extra tabs are web addresses kept in the project's settings; the project view carries them to the tab bar.
    assert.equal((await call('/api/projects/site/settings', { cookie, body: { doc: { customTabs: [{ label: 'Calendar', url: 'javascript:alert(1)' }] } } })).status, 400);
    assert.equal((await call('/api/projects/site/settings', { cookie, body: { doc: { customTabs: [{ label: 'Calendar', url: 'https://calendar.example.com/site' }] } } })).status, 200);
    assert.deepEqual((await call('/api/projects/site', { cookie })).json.customTabs, [{ label: 'Calendar', url: 'https://calendar.example.com/site' }]);
    const events = await db.selectFrom('events').select(['type', 'user_id']).where('type', 'in', ['milestone.created', 'milestone.updated', 'milestone.deleted', 'project.linked', 'project.unlinked', 'project.status_changed']).execute();
    assert.equal(events.length, 8);
    assert.ok(events.every(event => event.user_id));
  } finally { await coordinator.close(); }
});

test('a seat on loan widens where the agent may work, until the loan ends or the project pauses', async () => {
  const { coordinator, db, call, owner, project } = await boot();
  try {
    const cookie = await owner();
    const shop = await project('shop'), site = await project('site');
    const sub = newId();
    await db.insertInto('projects').values({ id: sub, slug: 'site-docs', name: 'Docs', kind: 'repo', parent_id: site, status: 'active', manifest: '{}', manifest_sha: null, team_id: null, sort: 0, created_at: 1 }).execute();
    const agent = (await call('/api/projects/shop', { cookie })).json.roster[0];
    assert.deepEqual(await effectiveProjects(db, agent.id), [shop]);

    const loan = await call(`/api/agents/${agent.id}/loans`, { cookie, body: { toProjectId: site, note: 'two weeks' } });
    assert.equal(loan.status, 200);
    assert.equal((await call(`/api/agents/${agent.id}/loans`, { cookie, body: { toProjectId: site } })).status, 409);
    assert.equal((await call(`/api/agents/${agent.id}/loans`, { cookie, body: { toProjectId: shop } })).status, 400);
    assert.deepEqual((await effectiveProjects(db, agent.id)).sort(), [shop, site, sub].sort());
    // The helper takes a transaction too, which is how a claim would call it.
    assert.equal((await coordinator.context.storage.transaction(tx => effectiveProjects(tx, agent.id))).length, 3);

    const borrowed = await call('/api/projects/site/loans', { cookie });
    assert.equal(borrowed.json.borrowed[0].agent.name, agent.name);
    assert.equal(borrowed.json.borrowed[0].from.name, 'shop');
    assert.equal((await call('/api/projects/shop/loans', { cookie })).json.lent[0].to.slug, 'site');
    assert.equal((await call('/api/org/structure', { cookie })).json.loans.length, 1);

    await call('/api/projects/site/status', { cookie, body: { status: 'paused' } });
    assert.deepEqual(await effectiveProjects(db, agent.id), [shop]);
    await call('/api/projects/site/status', { cookie, body: { status: 'active' } });
    assert.equal((await call(`/api/loans/${loan.json.id}/end`, { cookie, method: 'POST' })).status, 200);
    assert.deepEqual(await effectiveProjects(db, agent.id), [shop]);
    assert.equal((await call('/api/org/structure', { cookie })).json.loans.length, 0);
    assert.deepEqual(await effectiveProjects(db, 'no-such-agent'), []);
  } finally { await coordinator.close(); }
});

test('team templates: save the team, export, import, create a team from one; hire from the library', async () => {
  const { coordinator, db, call, owner, project } = await boot();
  try {
    const cookie = await owner();
    await project('shop');
    const site = await project('site');
    const roster = (await call('/api/projects/shop', { cookie })).json.roster;
    const saved = await call('/api/projects/shop/team/save-template', { cookie, body: { slug: 'shop-team', name: 'Shop team' } });
    assert.deepEqual(saved.json, { slug: 'shop-team', version: 1 });
    const exported = await call('/api/templates/shop-team/export', { cookie });
    assert.match(exported.headers.get('content-disposition') ?? '', /shop-team\.team-template\.json/);
    assert.equal(exported.json.doc.seats.length, roster.length);
    assert.equal(exported.json.doc.seats.filter((seat: any) => seat.isPm).length, 1);
    assert.ok(exported.json.doc.seats[0].roles.length > 0);

    // Import is a save of the exported document under a slug.
    assert.equal((await call('/api/templates/imported', { cookie, body: { doc: exported.json.doc, note: 'imported' } })).json.version, 1);
    assert.equal((await call('/api/templates/imported', { cookie, body: { doc: { name: 'Broken', seats: [] } } })).status, 400);
    assert.deepEqual((await call('/api/templates', { cookie })).json.items.map((item: any) => item.slug), ['imported', 'shop-team']);

    // A project that has a team refuses a second one but can take the seats on top.
    assert.equal((await call('/api/projects/site/team/from-template', { cookie, body: { template: 'imported' } })).status, 409);
    await db.updateTable('projects').set({ team_id: null }).where('id', '=', site).execute();
    const made = await call('/api/projects/site/team/from-template', { cookie, body: { template: 'imported' } });
    assert.equal(made.json.agentIds.length, roster.length);
    const team = await db.selectFrom('teams').selectAll().where('id', '=', made.json.teamId).executeTakeFirstOrThrow();
    assert.deepEqual([team.template_slug, team.template_version], ['imported', 1]);
    const appended = await call('/api/projects/site/team/from-template', { cookie, body: { template: 'imported', mode: 'append' } });
    assert.equal(appended.status, 200);
    const seats = (await call('/api/projects/site', { cookie })).json.roster;
    assert.equal(seats.length, roster.length * 2);
    assert.equal(seats.filter((seat: any) => seat.is_pm).length, 1, 'a team keeps one PM');

    assert.equal((await call('/api/library/agents/designer', { cookie, body: { doc: { name: 'Iris', title: 'Designer', persona: 'Sees the whole flow.', roles: ['developer'], summary: 'Product design' } } })).json.version, 1);
    const hired = await call('/api/projects/shop/team/hire', { cookie, body: { library: 'designer', name: 'Iris II' } });
    assert.equal(hired.status, 200);
    const after = (await call('/api/projects/shop', { cookie })).json.roster;
    assert.equal(after.at(-1).name, 'Iris II');
    assert.equal(after.at(-1).is_pm, false);
    assert.deepEqual((await db.selectFrom('agent_roles').select('role_slug').where('agent_id', '=', hired.json.id).execute()).map(row => row.role_slug), ['developer']);
    assert.equal((await call('/api/projects/shop/team/hire', { cookie, body: { library: 'nobody' } })).status, 404);
    const events = await db.selectFrom('events').select(['type', 'user_id']).where('type', 'in', ['agent.hired', 'team.created_from_template']).execute();
    assert.equal(events.length, 3);
    assert.ok(events.every(event => event.user_id));
  } finally { await coordinator.close(); }
});

// Every route this module adds, with the least standing that may use it. The subjects are the columns of the matrix in docs/SPEC.md section 8.
const LEVELS = { signed: ['outsider', 'viewer', 'member', 'projectAdmin', 'orgAdmin', 'owner'], read: ['viewer', 'member', 'projectAdmin', 'orgAdmin', 'owner'], projectAdmin: ['projectAdmin', 'orgAdmin', 'owner'], orgAdmin: ['orgAdmin', 'owner'], owner: ['owner'] } as const;
const SUBJECTS = ['outsider', 'viewer', 'member', 'projectAdmin', 'orgAdmin', 'owner'] as const;

test('RBAC matrix over the organization routes', async () => {
  const { coordinator, call, owner, person, project } = await boot();
  try {
    const ownerCookie = await owner();
    const shop = await project('shop'), site = await project('site');
    const cookies: Record<(typeof SUBJECTS)[number], string> = {
      outsider: (await person('outsider', 'member')).cookie, viewer: (await person('viewer', 'viewer', { [shop]: 'viewer' })).cookie, member: (await person('member', 'member', { [shop]: 'member' })).cookie,
      projectAdmin: (await person('padmin', 'member', { [shop]: 'admin', [site]: 'admin' })).cookie, orgAdmin: (await person('oadmin', 'admin')).cookie, owner: ownerCookie,
    };
    const target = await person('target', 'member');
    const agent = (await call('/api/projects/shop', { cookie: ownerCookie })).json.roster[0];
    const milestone = (await call('/api/projects/shop/milestones', { cookie: ownerCookie, body: { label: 'M' } })).json.id;
    const link = (await call('/api/org/links', { cookie: ownerCookie, body: { fromProjectId: shop, toProjectId: site } })).json.id;
    const loan = (await call(`/api/agents/${agent.id}/loans`, { cookie: ownerCookie, body: { toProjectId: site } })).json.id;
    const machineToken = (await call('/api/machine-tokens', { cookie: ownerCookie, body: { name: 't' } })).json.id;
    await call('/api/templates/t', { cookie: ownerCookie, body: { doc: { name: 'T', seats: [{ name: 'Ada' }] } } });
    await call('/api/library/agents/a', { cookie: ownerCookie, body: { doc: { name: 'Ada' } } });
    await call('/api/invites', { cookie: ownerCookie, body: { email: 'pending@example.com', orgRole: 'viewer' } });
    const invite = (await call('/api/users', { cookie: ownerCookie })).json.invites[0].id;

    const ROUTES: [method: 'GET' | 'POST', path: string, level: keyof typeof LEVELS, body?: unknown][] = [
      ['GET', '/api/users', 'orgAdmin'], ['POST', `/api/users/${target.id}`, 'orgAdmin', {}], ['POST', `/api/invites/${invite}/revoke`, 'orgAdmin'],
      ['GET', '/api/projects/shop/members', 'projectAdmin'], ['POST', '/api/projects/shop/members', 'projectAdmin', { userId: target.id, role: 'viewer' }],
      ['GET', '/api/settings/auth', 'orgAdmin'], ['POST', '/api/settings/auth', 'owner', { oidc: null }],
      ['GET', '/api/machine-tokens', 'orgAdmin'], ['POST', '/api/machine-tokens', 'orgAdmin', { name: 'x' }], ['POST', `/api/machine-tokens/${machineToken}/revoke`, 'orgAdmin'],
      ['GET', '/api/audit', 'orgAdmin'], ['GET', '/api/events', 'signed'], ['GET', '/api/org/structure', 'signed'], ['GET', '/api/org/archived', 'orgAdmin'],
      ['GET', '/api/projects/shop/settings', 'read'], ['POST', '/api/projects/shop/settings', 'projectAdmin', { doc: {} }],
      ['POST', '/api/projects/shop/status', 'projectAdmin', { status: 'active' }], ['POST', '/api/projects/shop/status', 'orgAdmin', { status: 'archived' }], ['POST', '/api/projects/shop/status', 'orgAdmin', { status: 'active' }],
      ['GET', '/api/projects/shop/milestones', 'read'], ['POST', '/api/projects/shop/milestones', 'projectAdmin', { label: 'N' }], ['POST', `/api/milestones/${milestone}`, 'projectAdmin', { label: 'O' }], ['POST', `/api/milestones/${milestone}/delete`, 'projectAdmin'],
      ['POST', '/api/org/links', 'projectAdmin', { fromProjectId: shop, toProjectId: site, kind: 'blocks' }], ['POST', `/api/org/links/${link}/delete`, 'projectAdmin'],
      ['GET', '/api/projects/shop/loans', 'read'], ['POST', `/api/agents/${agent.id}/loans`, 'projectAdmin', { toProjectId: site }], ['POST', `/api/loans/${loan}/end`, 'projectAdmin'],
      ['GET', '/api/templates', 'signed'], ['GET', '/api/templates/t', 'signed'], ['GET', '/api/templates/t/export', 'signed'], ['POST', '/api/templates/t', 'orgAdmin', { doc: { name: 'T', seats: [{ name: 'Ada' }] } }],
      ['GET', '/api/library/agents', 'signed'], ['GET', '/api/library/agents/a', 'signed'], ['POST', '/api/library/agents/a', 'orgAdmin', { doc: { name: 'Ada' } }],
      ['POST', '/api/projects/shop/team/save-template', 'projectAdmin', { slug: 'fresh', name: 'Fresh' }], ['POST', '/api/projects/shop/team/from-template', 'projectAdmin', { template: 't', mode: 'append' }], ['POST', '/api/projects/shop/team/hire', 'projectAdmin', { library: 'a' }],
      // Team editing by hand, and the organization's model providers.
      ['GET', '/api/projects/shop/team', 'read'], ['POST', '/api/projects/shop/team/agents', 'projectAdmin', { name: 'Noor' }], ['POST', `/api/agents/${agent.id}`, 'projectAdmin', { title: 'Lead' }], ['POST', `/api/agents/${agent.id}/pm`, 'projectAdmin'],
      ['POST', '/api/projects/shop/team/order', 'projectAdmin', { agentIds: [agent.id] }],
      ['GET', '/api/providers', 'signed'], ['GET', '/api/providers/catalog', 'signed'], ['POST', '/api/providers', 'orgAdmin', { name: 'P', kind: 'local', engine: 'fake', models: ['m'] }],
      ['POST', '/api/providers/setup', 'orgAdmin', { kind: PROVIDERS[0]!.kind, values: { models: 'm' } }], ['POST', '/api/providers/none/remove', 'orgAdmin'],
    ];
    for (const [method, path, level, body] of ROUTES) {
      assert.equal((await call(path, { method, ...(body !== undefined ? { body } : {}) })).status, 401, `${method} ${path} without a session`);
      // Refusals first, so a route that consumes its target still has it when someone allowed arrives.
      for (const subject of SUBJECTS) {
        const allowed = (LEVELS[level] as readonly string[]).includes(subject);
        const status = (await call(path, { method, cookie: cookies[subject], ...(body !== undefined ? { body } : {}) })).status;
        if (allowed) assert.ok(status !== 401 && status !== 403 && status < 500, `${subject} may ${method} ${path}, got ${status}`);
        else assert.equal(status, 403, `${subject} may not ${method} ${path}`);
      }
    }
  } finally { await coordinator.close(); }
});
