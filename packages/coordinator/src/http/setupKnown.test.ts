import test from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG } from '../../../../adapters/integration/catalog.ts';
import { boot } from './testing.ts';

interface Offered { kind: string; prefill: Record<string, string> }
const sample = (field: { placeholder?: string; pattern?: string }) => (field.placeholder && (!field.pattern || new RegExp(`^(?:${field.pattern})$`).test(field.placeholder)) ? field.placeholder : null);

// The rule, for the whole catalog at once: whatever one entry of a product was told, no other entry of that product asks for again.
test('a value known for one entry of a product is offered by every other entry of it, in both directions', async () => {
  const { coordinator, call, owner } = await boot();
  try {
    const cookie = await owner();
    const products = [...new Set(CATALOG.flatMap(entry => (entry.product ? [entry.product] : [])))];
    assert.ok(products.length > 0);
    let checkedPairs = 0;
    for (const product of products) {
      const entries = CATALOG.filter(entry => entry.product === product);
      for (const first of entries) {
        const slug = `p-${first.kind}`;
        assert.equal((await call('/api/projects', { cookie, body: { name: slug } })).status, 200);
        const values = Object.fromEntries(first.fields.flatMap(field => { const value = field.required ? sample(field) : null; return value ? [[field.key, value]] : []; }));
        assert.equal((await call(`/api/projects/${slug}/integrations/setup`, { cookie, body: { kind: first.kind, values } })).status, 200, first.kind);
        const offered = (await call(`/api/projects/${slug}/integrations/catalog`, { cookie })).json.entries as Offered[];
        for (const other of entries) {
          const shared = other.fields.filter(field => field.required && values[field.key]);
          for (const field of shared) { assert.equal(offered.find(item => item.kind === other.kind)!.prefill[field.key], values[field.key], `${other.kind} asks again for ${field.key}, known from ${first.kind}`); checkedPairs++; }
        }
        // Entries of other products are not offered someone else's values.
        for (const foreign of CATALOG.filter(entry => entry.product !== product)) assert.deepEqual(offered.find(item => item.kind === foreign.kind)!.prefill, {}, foreign.kind);
      }
    }
    assert.ok(checkedPairs >= 2);
  } finally { await coordinator.close(); }
});

test('a project registered from a checkout already knows its repository, for the code host and for its issues', async () => {
  const { coordinator, call, owner, machine } = await boot();
  try {
    const cookie = await owner();
    await call('/machine/projects', { headers: machine, body: { slug: 'from-up', name: 'From up', manifest: { scm: { kind: 'github' }, delivery: { repository: 'acme/shop', baseBranch: 'trunk' } } } });
    const offered = (await call('/api/projects/from-up/integrations/catalog', { cookie })).json.entries as Offered[];
    assert.deepEqual(offered.find(item => item.kind === 'github')!.prefill, { repository: 'acme/shop', baseBranch: 'trunk' });
    assert.deepEqual(offered.find(item => item.kind === 'github-issues')!.prefill, { repository: 'acme/shop' });
    assert.deepEqual(offered.find(item => item.kind === 'gitlab')!.prefill, {});
    // And it shows as connected, the same as if it had been set up in the app; registering again does not duplicate it.
    await call('/machine/projects', { headers: machine, body: { slug: 'from-up', name: 'From up', manifest: { scm: { kind: 'github' }, delivery: { repository: 'acme/shop', baseBranch: 'trunk' } } } });
    const shown = (await call('/api/projects/from-up/integrations', { cookie })).json.connections as { name: string; statusDetail: string }[];
    assert.deepEqual(shown.map(item => [item.name, item.statusDetail]), [['GitHub', 'Uses the sign-in on each worker']]);
  } finally { await coordinator.close(); }
});

test('what was connected in the app survives the checkout registering again without saying it, and a board keeps its hand-set settings', async () => {
  const { coordinator, db, call, owner, machine } = await boot();
  try {
    const cookie = await owner();
    await call('/machine/projects', { headers: machine, body: { slug: 'shop', name: 'Shop', manifest: { name: 'Shop' } } });
    assert.equal((await call('/api/projects/shop/integrations/setup', { cookie, body: { kind: 'github', values: { repository: 'acme/shop', baseBranch: 'trunk' } } })).status, 200);
    await db.updateTable('projects').set({ manifest: JSON.stringify({ ...JSON.parse((await db.selectFrom('projects').select('manifest').where('slug', '=', 'shop').executeTakeFirstOrThrow()).manifest), tracker: { kind: 'linear', projectId: '9d6c1c2e-0000-0000-0000-000000000000', readyLabel: 'agent:ready' } }) }).where('slug', '=', 'shop').execute();
    await call('/machine/projects', { headers: machine, body: { slug: 'shop', name: 'Shop', manifest: { name: 'Shop', delivery: { publishAuthorized: false } } } });
    const kept = JSON.parse((await db.selectFrom('projects').select('manifest').where('slug', '=', 'shop').executeTakeFirstOrThrow()).manifest);
    assert.deepEqual([kept.scm, kept.delivery, kept.tracker.kind], [{ kind: 'github' }, { repository: 'acme/shop', baseBranch: 'trunk', publishAuthorized: false }, 'linear']);

    // Connecting the same board again in the app changes what was entered and keeps the rest; an empty field blanks nothing.
    assert.equal((await call('/api/projects/shop/integrations/setup', { cookie, body: { kind: 'linear', values: { projectId: '5f1e7a2b-0000-0000-0000-000000000000', teamId: '' } } })).status, 200);
    const board = JSON.parse((await db.selectFrom('projects').select('manifest').where('slug', '=', 'shop').executeTakeFirstOrThrow()).manifest).tracker;
    assert.deepEqual(board, { kind: 'linear', projectId: '5f1e7a2b-0000-0000-0000-000000000000', readyLabel: 'agent:ready' });
  } finally { await coordinator.close(); }
});
