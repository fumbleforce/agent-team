import test from 'node:test';
import assert from 'node:assert/strict';
import type { ScmApi } from '../sync/scm.ts';
import { createScmSync } from '../sync/scm.ts';
import { boot } from './testing.ts';

// A code host that keeps one settings file per branch and records the changes proposed to it.
function host(initial: string | null) {
  const files = new Map<string, string>(initial === null ? [] : [['main', initial]]), proposed: { branch: string; content: string; title: string }[] = [];
  const api: ScmApi = {
    reviewState: async () => ({ state: 'pending', approvals: 0, reviewers: [] }), changeState: async () => ({ open: true, merged: false, headSha: null, conflicting: null }),
    testReports: async () => [], environments: async () => [],
    readFile: async (_repository, _path, ref) => files.get(ref) ?? null,
    proposeFile: async (_repository, input) => { proposed.push({ branch: input.branch, content: input.content, title: input.title }); files.set(input.branch, input.content); return `https://code.example/acme/shop/pull/${proposed.length}`; },
    checkNames: async () => ['verify', 'e2e'],
  };
  // Merging the proposed change on the code host: its file becomes the base branch's.
  const merge = () => files.set('main', proposed.at(-1)!.content);
  return { api, proposed, merge };
}

test('merging is turned on from the app by a change the owner merges on the code host, and counts only once it is merged', async () => {
  const code = host(JSON.stringify({ name: 'Shop', delivery: { repository: 'acme/shop', baseBranch: 'main', requiredChecks: [], autoMergeAuthorized: false }, ideation: { enabled: false } }));
  const { coordinator, db, call, owner, machine } = await boot({ scm: async () => code.api });
  try {
    const cookie = await owner();
    await call('/machine/projects', { headers: machine, body: { slug: 'shop', name: 'Shop', manifest: { scm: { kind: 'github' }, delivery: { repository: 'acme/shop', baseBranch: 'main', autoMergeAuthorized: false, requiredChecks: [] } } } });
    const before = (await call('/api/projects/shop/merging', { cookie })).json;
    assert.deepEqual([before.autoMergeAuthorized, before.canPropose, before.checks], [false, true, ['e2e', 'verify']]);

    assert.equal((await call('/api/projects/shop/merging', { cookie, body: { autoMerge: true, requiredChecks: [] } })).json.error.fields.requiredChecks, 'Choose at least one check: the team merges only when they pass');
    const asked = (await call('/api/projects/shop/merging', { cookie, body: { autoMerge: true, requiredChecks: ['verify'] } })).json;
    assert.equal(asked.url, 'https://code.example/acme/shop/pull/1');
    const written = JSON.parse(code.proposed[0]!.content);
    assert.deepEqual(written.delivery, { repository: 'acme/shop', baseBranch: 'main', requiredChecks: ['verify'], autoMergeAuthorized: true, publishAuthorized: true });
    assert.deepEqual(written.ideation, { enabled: false }, 'the rest of the committed file is kept as it was');

    // Proposed is not merged: nothing is authorized yet, and the page says where the change waits.
    const sync = createScmSync(coordinator.context);
    const project = await db.selectFrom('projects').select('id').where('slug', '=', 'shop').executeTakeFirstOrThrow();
    await sync.syncProject(project.id, code.api);
    const waiting = (await call('/api/projects/shop/merging', { cookie })).json;
    assert.deepEqual([waiting.autoMergeAuthorized, waiting.proposal.url], [false, asked.url]);

    // Merged on the code host: the next poll reads it from the base branch, and the gate's settings follow.
    code.merge();
    await sync.syncProject(project.id, code.api);
    const stored = JSON.parse((await db.selectFrom('projects').select('manifest').where('id', '=', project.id).executeTakeFirstOrThrow()).manifest);
    assert.deepEqual([stored.delivery.autoMergeAuthorized, stored.delivery.requiredChecks, stored.delivery.publishAuthorized], [true, ['verify'], true]);
    assert.ok(await db.selectFrom('events').select('seq').where('type', '=', 'settings.changed').where('project_id', '=', project.id).executeTakeFirst());
  } finally { await coordinator.close(); }
});

test('what a checkout registered does not outrank the committed file, and a project without a code host that can write is told why', async () => {
  const code = host(JSON.stringify({ delivery: { autoMergeAuthorized: false, requiredChecks: ['verify'] } }));
  const { coordinator, db, call, owner, machine } = await boot({ scm: async kind => (kind === 'github' ? code.api : null) });
  try {
    const cookie = await owner();
    // A working copy that says more than what is committed.
    await call('/machine/projects', { headers: machine, body: { slug: 'shop', name: 'Shop', manifest: { scm: { kind: 'github' }, delivery: { repository: 'acme/shop', autoMergeAuthorized: true, requiredChecks: ['verify'] } } } });
    const project = await db.selectFrom('projects').select('id').where('slug', '=', 'shop').executeTakeFirstOrThrow();
    await createScmSync(coordinator.context).syncProject(project.id, code.api);
    assert.equal((await call('/api/projects/shop/merging', { cookie })).json.autoMergeAuthorized, false);

    await call('/machine/projects', { headers: machine, body: { slug: 'site', name: 'Site', manifest: { scm: { kind: 'gitlab' }, delivery: { repository: 'acme/site' } } } });
    assert.equal((await call('/api/projects/site/merging', { cookie, body: { autoMerge: true, requiredChecks: ['verify'] } })).status, 409);
  } finally { await coordinator.close(); }
});

test('where a project\'s work runs is chosen in the app, and only where the deployment starts machines', async () => {
  const { coordinator, db, call, owner, machine } = await boot();
  try {
    const cookie = await owner();
    await call('/machine/projects', { headers: machine, body: { slug: 'shop', name: 'Shop', manifest: {} } });
    assert.deepEqual((await call('/api/projects/shop/runs-on', { cookie })).json, { launcher: null, canLaunch: false, choices: [] });
    assert.equal((await call('/api/projects/shop/runs-on', { cookie, body: { launcher: 'sprite' } })).status, 409);
    coordinator.context.launching = true;
    assert.equal((await call('/api/projects/shop/runs-on', { cookie, body: { launcher: 'sprite' } })).status, 200);
    assert.equal(JSON.parse((await db.selectFrom('projects').select('manifest').where('slug', '=', 'shop').executeTakeFirstOrThrow()).manifest).worker.launcher, 'sprite');
    await call('/machine/projects', { headers: machine, body: { slug: 'shop', name: 'Shop', manifest: {} } });
    assert.equal((await call('/api/projects/shop/runs-on', { cookie })).json.launcher, 'sprite', 'registering again from a checkout keeps it');
  } finally { await coordinator.close(); }
});
