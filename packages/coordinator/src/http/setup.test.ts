import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './testing.ts';

test('a project is created in the app and its task board is set up through the guided flow', async () => {
  const { coordinator, db, call, owner, person } = await boot();
  try {
    const cookie = await owner();
    const viewer = await person('vera', 'viewer');
    assert.equal((await call('/api/projects', { cookie: viewer.cookie, body: { name: 'Nope' } })).status, 403);
    const created = await call('/api/projects', { cookie, body: { name: 'Web shop' } });
    assert.deepEqual([created.status, created.json.slug], [200, 'web-shop']);
    assert.equal((await call('/api/projects', { cookie, body: { name: 'Web shop' } })).status, 409);
    assert.equal((await db.selectFrom('agents').select('id').execute()).length > 0, true, 'the default team came with it');

    // The catalog speaks the products' own language and never carries a secret or a test function.
    const catalog = (await call('/api/integrations/catalog', { cookie })).json.entries as { kind: string; title: string; steps: string[]; fields: { label: string }[]; test?: unknown }[];
    assert.deepEqual(catalog.map(entry => entry.title).slice(0, 4), ['GitHub', 'GitLab', 'GitHub Issues', 'Linear']);
    assert.ok(catalog.every(entry => entry.steps.length > 0 && entry.test === undefined));

    // What was typed is checked in the person's words, field by field.
    const bad = await call('/api/projects/web-shop/integrations/setup', { cookie, body: { kind: 'github-issues', values: { repository: 'not a repository' } } });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error.fields.repository, /Repository does not look right; it should look like owner\/name/);
    assert.match((await call('/api/projects/web-shop/integrations/setup', { cookie, body: { kind: 'linear', values: {} } })).json.error.fields.projectId, /is needed/);

    // Without a credential the check asks for it, and connecting still works.
    delete process.env.GITHUB_ISSUES_TOKEN; delete process.env.GH_TOKEN; process.env.AGENT_TEAM_NO_CLI_LOGIN = '1';
    const checked = await call('/api/projects/web-shop/integrations/test', { cookie, body: { kind: 'github-issues', values: { repository: 'acme/shop' } } });
    assert.deepEqual([checked.json.ok, /Paste the GitHub token first/.test(checked.json.message)], [false, true]);
    assert.equal((await call('/api/projects/web-shop/integrations/setup', { cookie, body: { kind: 'github-issues', values: { repository: 'acme/shop' } } })).status, 200);
    const manifest = async () => JSON.parse((await db.selectFrom('projects').select('manifest').where('slug', '=', 'web-shop').executeTakeFirstOrThrow()).manifest);
    assert.deepEqual((await manifest()).tracker, { kind: 'github', repository: 'acme/shop' });

    // The same product connected once is not asked about twice: the repository entered for the code host is offered for its issues.
    await call('/api/projects/web-shop/integrations/setup', { cookie, body: { kind: 'github', values: { repository: 'acme/shop' } } });
    const offered = ((await call('/api/projects/web-shop/integrations/catalog', { cookie })).json.entries as { kind: string; prefill: Record<string, string>; findCredential?: unknown }[]).find(entry => entry.kind === 'github-issues')!;
    assert.deepEqual([offered.prefill, offered.findCredential], [{ repository: 'acme/shop' }, undefined]);

    // A project has one task board: choosing another replaces it, and removing it clears the manifest too.
    await call('/api/projects/web-shop/integrations/setup', { cookie, body: { kind: 'linear', values: { projectId: '9d6c1c2e-0000-4000-8000-000000000000' } } });
    const connections = (await call('/api/projects/web-shop/integrations', { cookie })).json.connections as { id: string; name: string; statusDetail: string }[];
    assert.deepEqual(connections.map(item => [item.name, item.statusDetail]), [['GitHub', 'Uses the sign-in on each worker'], ['Linear', 'Needs a Linear API key']], 'one code host and one task board');
    assert.equal((await manifest()).tracker.kind, 'linear');
    await call(`/api/projects/web-shop/integrations/${connections.find(item => item.name === 'Linear')!.id}/remove`, { cookie, body: {} });
    assert.equal((await manifest()).tracker, undefined);
  } finally { await coordinator.close(); }
});
