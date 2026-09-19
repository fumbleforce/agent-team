import test from 'node:test';
import assert from 'node:assert/strict';
import { HarnessHealthView } from '@agent-team/protocol';
import { createStorage } from '@agent-team/storage';
import { createContext } from '../context.ts';
import { createWorkspace } from '../repos/workspace.ts';
import { boot } from '../http/testing.ts';
import { createChecks } from './checks.ts';
import { parseJUnit } from './junit.ts';

const report = (passed: number, failing: string[], quarantined: string[] = [], durationMs = 10) => ({
  passed, failed: failing.length, skipped: quarantined.length, total: passed + failing.length + quarantined.length, durationMs,
  failing: failing.map(name => ({ name, status: 'failed' as const, message: 'boom' })), quarantined: quarantined.map(name => ({ name, status: 'skipped' as const, message: 'quarantined: flaky' })),
});

test('a skipped case whose reason says quarantined or flaky is kept as quarantined; a plain skip is only counted', () => {
  const parsed = parseJUnit(`<testsuite tests="4">
    <testcase classname="cart.spec" name="totals" time="0.1"/>
    <testcase classname="cart.spec" name="coupon race"><skipped message="Quarantined: fails one run in ten"/></testcase>
    <testcase classname="cart.spec" name="slow network"><skipped>flaky on CI &amp; tracked in #118</skipped></testcase>
    <testcase classname="cart.spec" name="not on this platform"><skipped message="windows only"/></testcase>
  </testsuite>`);
  assert.deepEqual([parsed.total, parsed.passed, parsed.skipped], [4, 1, 3]);
  assert.deepEqual(parsed.quarantined?.map(item => [item.name, item.message]), [['cart.spec › coupon race', 'Quarantined: fails one run in ten'], ['cart.spec › slow network', 'flaky on CI & tracked in #118']]);
});

test('harness health is read from the base branch, and a change in cases or quarantine between runs is an event', async () => {
  const storage = await createStorage({ kind: 'sqlite', path: ':memory:' });
  try {
    await storage.migrate();
    let clock = 1000;
    const context = createContext({ storage, machineToken: 'x'.repeat(24), now: () => clock++ });
    const workspace = createWorkspace(context);
    const projectId = await workspace.registerProject({ slug: 'shop', name: 'Shop', kind: 'repo', manifest: { delivery: { baseBranch: 'trunk' } } });
    const checks = createChecks(context);
    const changed = async () => (await storage.db.selectFrom('events').select('payload').where('type', '=', 'check.harness_changed').orderBy('seq').execute()).map(row => JSON.parse(row.payload) as Record<string, unknown>);

    assert.deepEqual(await checks.health(projectId), { branch: 'trunk', totalCases: 0, quarantinedCases: [], suites: [], changes: [] });
    // The first run of a suite is where counting starts, not a change; a repeat with the same shape is not one either.
    await checks.record({ projectId, suite: 'unit', branch: 'trunk', source: 'upload', report: report(800, [], [], 4000) });
    await checks.record({ projectId, suite: 'unit', branch: 'trunk', source: 'upload', report: report(799, ['one broke'], [], 4100) });
    assert.deepEqual(await changed(), []);
    // Other branches never count, whatever they do.
    await checks.record({ projectId, suite: 'unit', branch: 'feature/x', source: 'agent', report: report(5, [], ['gone wild']) });
    assert.deepEqual(await changed(), []);
    // Twelve new cases, one of them quarantined.
    await checks.record({ projectId, suite: 'unit', branch: 'trunk', source: 'upload', report: report(811, [], ['coupon race'], 4300) });
    // Same total, but the quarantined set moved.
    await checks.record({ projectId, suite: 'unit', branch: 'trunk', source: 'upload', report: report(810, ['one broke'], ['slow network'], 4200) });
    await checks.record({ projectId, suite: 'e2e', kind: 'check', branch: 'trunk', source: 'upload', report: report(40, [], ['pay button'], 90_000) });
    assert.deepEqual((await changed()).map(item => [item.suite, item.totalBefore, item.totalAfter, item.quarantinedAdded, item.quarantinedRemoved]), [['unit', 800, 812, ['coupon race'], []], ['unit', 812, 812, ['slow network'], ['coupon race']]]);

    const health = HarnessHealthView.parse(await checks.health(projectId));
    assert.deepEqual([health.branch, health.totalCases, health.quarantinedCases], ['trunk', 853, [{ suite: 'e2e', name: 'pay button' }, { suite: 'unit', name: 'slow network' }]]);
    assert.deepEqual(health.suites.map(item => [item.suite, item.kind, item.total, item.failed, item.quarantined, item.durationMs]), [['e2e', 'check', 41, 0, 1, 90_000], ['unit', 'test', 812, 1, 1, 4200]]);
    assert.deepEqual(health.changes.map(item => [item.totalBefore, item.totalAfter]), [[812, 812], [800, 812]]);
    // A quarantined case is not a failing one.
    assert.deepEqual((await checks.matrix(projectId)).failing.map(item => item.name), ['one broke']);

    // A sub-project is judged on its parent's base branch.
    await storage.db.insertInto('projects').values({ id: 'sub', slug: 'shop-checkout', name: 'Checkout', kind: 'repo', parent_id: projectId, status: 'active', manifest: '{}', manifest_sha: null, team_id: null, sort: 1, created_at: 1 }).execute();
    assert.equal((await checks.health('sub')).branch, 'trunk');
  } finally { await storage.close(); }
});

test('the health route answers members of the project and nobody else', async () => {
  const { coordinator, call, owner, person, project } = await boot();
  try {
    const cookie = await owner(), shop = await project('shop'), outsider = await person('otto', 'member');
    const xml = (cases: string) => `<testsuite>${cases}</testsuite>`;
    const upload = (body: string) => fetch(`${coordinator.url}/api/projects/shop/checks/unit?branch=main`, { method: 'POST', headers: { cookie, 'content-type': 'application/xml' }, body });
    assert.equal((await upload(xml('<testcase name="a"/><testcase name="b"/>'))).status, 200);
    assert.equal((await upload(xml('<testcase name="a"/><testcase name="b"><skipped message="flaky"/></testcase><testcase name="c"/>'))).status, 200);
    const health = await call('/api/projects/shop/checks/health', { cookie });
    assert.equal(health.status, 200);
    const view = HarnessHealthView.parse(health.json);
    assert.deepEqual([view.totalCases, view.quarantinedCases, view.changes.map(item => [item.suite, item.totalBefore, item.totalAfter, item.quarantinedAdded])], [3, [{ suite: 'unit', name: 'b' }], [['unit', 2, 3, ['b']]]]);
    assert.equal((await call('/api/projects/shop/checks/health', { cookie: outsider.cookie })).status, 403);
    assert.ok(shop);
  } finally { await coordinator.close(); }
});
