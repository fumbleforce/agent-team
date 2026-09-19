import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '@agent-team/storage';
import { createContext } from '../context.ts';
import { createWorkspace } from '../repos/workspace.ts';
import { createCosts, type Spend } from './costs.ts';

const DAY = Date.parse('2026-05-10T12:00:00Z');

async function boot() {
  const storage = await createStorage({ kind: 'sqlite', path: ':memory:' });
  await storage.migrate();
  let clock = DAY;
  const context = createContext({ storage, machineToken: 'x'.repeat(24), now: () => clock++ });
  await storage.db.insertInto('org').values({ id: 'org', name: 'Acme', accent: 'amber', currency: 'USD', settings: JSON.stringify({ oidc: { issuer: 'https://id.example' } }), created_at: DAY }).execute();
  const projectId = await createWorkspace(context).registerProject({ slug: 'shop', name: 'Shop', kind: 'repo', manifest: {} });
  const costs = createCosts(context);
  const spend = (change: Partial<Spend>) => storage.transaction(tx => costs.record(tx, { turnId: null, agentId: 'ada', projectId, providerId: 'main', billingKind: 'metered', tokensIn: 1000, tokensOut: 200, amountMinor: 200, ...change }));
  return { storage, costs, projectId, spend };
}

test('an entry is converted from dollars at the configured rate and keeps the rate it used', async () => {
  const { storage, costs, projectId, spend } = await boot();
  try {
    assert.deepEqual(await costs.display(), { currency: 'USD', rate: 1 });
    await spend({});
    await costs.setDisplay('u1', { currency: 'USD', rate: 1 });
    await costs.setDisplay('u1', { currency: 'EUR', rate: 0.9 });
    await spend({ amountMinor: 333 });
    // A later rate never rewrites the ledger.
    await costs.setDisplay('u1', { currency: 'EUR', rate: 0.5 });
    const entries = await storage.db.selectFrom('cost_entries').select(['usd_minor', 'amount_minor', 'currency', 'rate']).orderBy('at').execute();
    assert.deepEqual(entries.map(row => [row.usd_minor, row.amount_minor, row.currency, Number(row.rate)]), [[200, 200, 'USD', 1], [333, 300, 'EUR', 0.9]]);
    // Changing the currency restated the first day's dollars at 0.9; the second entry was added at 0.9; the rate change alone restated nothing.
    const summary = await costs.summary([projectId], '2026-05-01', '2026-05-31');
    assert.deepEqual([summary.currency, summary.rate, summary.totalMinor, summary.byAgent], ['EUR', 0.5, 480, [{ id: 'ada', amountMinor: 480, tokens: 2400 }]]);
    // The sign-in settings that share the organization's settings survive, and the change is in the audit trail.
    assert.deepEqual(JSON.parse((await storage.db.selectFrom('org').select('settings').executeTakeFirstOrThrow()).settings), { oidc: { issuer: 'https://id.example' }, costs: { usdRate: 0.5 } });
    const audit = await storage.db.selectFrom('events').select('payload').where('type', '=', 'settings.changed').execute();
    assert.deepEqual(audit.map(row => (JSON.parse(row.payload) as { kind: string }).kind), ['cost-currency', 'cost-currency', 'cost-currency']);
    assert.match(await costs.exportCsv([projectId], DAY - 1000, DAY + 1000), /amount_minor,currency,usd_minor,rate,turn_id\r\n.*,200,USD,200,1,\r\n.*,300,EUR,333,0\.9,\r\n$/s);
  } finally { await storage.close(); }
});

test('subscription and local turns cost nothing more, and their tokens still count', async () => {
  const { storage, costs, projectId, spend } = await boot();
  try {
    await spend({ billingKind: 'subscription', amountMinor: 450 });
    await spend({ billingKind: 'local', amountMinor: 120, tokensIn: 50, tokensOut: 50 });
    await spend({ billingKind: 'metered', amountMinor: 0, tokensIn: 0, tokensOut: 0 });
    const entries = await storage.db.selectFrom('cost_entries').select(['billing_kind', 'amount_minor', 'usd_minor', 'tokens_in', 'tokens_out']).orderBy('at').execute();
    assert.deepEqual(entries.map(row => [row.billing_kind, row.amount_minor, row.usd_minor, row.tokens_in + row.tokens_out]), [['subscription', 0, 0, 1200], ['local', 0, 0, 100]]);
    // A provider's window limit is counted from these entries' tokens.
    const used = await storage.db.selectFrom('cost_entries').select(eb => eb.fn.sum<number>('tokens_in').as('tokens')).where('provider_id', '=', 'main').executeTakeFirstOrThrow();
    assert.equal(Number(used.tokens), 1050);
    const summary = await costs.summary([projectId], '2026-05-01', '2026-05-31');
    assert.deepEqual([summary.totalMinor, summary.daily], [0, [{ id: '2026-05-10', amountMinor: 0, tokens: 1300 }]]);
    assert.equal(await costs.spentToday('ada'), 0);
  } finally { await storage.close(); }
});
