import test from 'node:test';
import assert from 'node:assert/strict';
import { CostsSummaryView } from '@agent-team/protocol';
import { boot } from '../http/testing.ts';

test('the display currency and its rate are read by members, set by admins, and named by the summary', async () => {
  const { coordinator, call, owner, person, project } = await boot();
  try {
    const cookie = await owner(), shop = await project('shop'), member = await person('mia', 'member', { [shop]: 'member' }), admin = await person('ann', 'admin');
    assert.deepEqual((await call('/api/costs/currency', { cookie: member.cookie })).json, { currency: 'EUR', rate: 1, canEdit: false });
    assert.equal((await call('/api/costs/currency', { cookie: member.cookie, body: { currency: 'NOK', rate: 10.5 } })).status, 403);
    for (const bad of [{ currency: 'kroner', rate: 10 }, { currency: 'NOK', rate: 0 }, { currency: 'NOK', rate: -2 }, { currency: 'NOK' }]) assert.equal((await call('/api/costs/currency', { cookie, body: bad })).status, 400);
    assert.deepEqual((await call('/api/costs/currency', { method: 'PUT', cookie: admin.cookie, body: { currency: 'NOK', rate: 10.5 } })).json, { currency: 'NOK', rate: 10.5 });
    assert.deepEqual((await call('/api/costs/currency', { cookie })).json, { currency: 'NOK', rate: 10.5, canEdit: true });
    assert.equal((await call('/api/me', { cookie })).json.org.currency, 'NOK');
    const summary = CostsSummaryView.parse((await call('/api/costs', { cookie: member.cookie })).json);
    assert.deepEqual([summary.currency, summary.rate, summary.totalMinor], ['NOK', 10.5, 0]);
  } finally { await coordinator.close(); }
});
