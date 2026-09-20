import test from 'node:test';
import assert from 'node:assert/strict';
import { startCoordinator } from '../server.ts';
import { postgresForTests } from '../../../../adapters/storage/testing.ts';
import { DEMO_LOGIN, seedDemo } from './seed.ts';

// Every screen's data endpoint answers for the seeded organization, and nothing is served without a session.
const SCREENS = [
  '/api/me', '/api/projects', '/api/agents', '/api/org', '/api/roles', '/api/proposals', '/api/costs', '/api/needs-you',
  '/api/projects/checkout-v2', '/api/projects/checkout-v2/knowledge', '/api/projects/checkout-v2/workload', '/api/projects/checkout-v2/checks',
  '/api/projects/checkout-v2/issues', '/api/projects/checkout-v2/product', '/api/projects/checkout-v2/integrations', '/api/projects/checkout-v2/search?q=idempotency',
  '/api/budgets', '/api/rules/routing_rules', '/api/rules/cost_rules', '/api/org/archived', '/api/org/structure',
  // The studio: a project that is not software renders on every screen too.
  ...['', '/knowledge', '/workload', '/checks', '/issues', '/product', '/integrations', '/settings', '/milestones', '/search?q=voice'].map(path => `/api/projects/nordlys-studio${path}`),
];

for (const kind of ['sqlite', 'postgres'] as const) test(`${kind}: the demo serves every screen to its owner and nothing to a stranger`, async () => {
  const local = kind === 'postgres' ? await postgresForTests() : null;
  const coordinator = await startCoordinator({ port: 0, storage: local?.config ?? { kind: 'sqlite', path: ':memory:' }, machineToken: 'x'.repeat(24), webRoot: null, trackers: null, demoLogin: DEMO_LOGIN });
  try {
    await seedDemo(coordinator.context);
    const entered = await fetch(`${coordinator.url}/demo/enter`, { redirect: 'manual' });
    const cookie = entered.headers.get('set-cookie')!.split(';')[0]!;
    for (const path of SCREENS) {
      assert.equal((await fetch(coordinator.url + path)).status, 401, `${path} without a session`);
      const response = await fetch(coordinator.url + path, { headers: { cookie } });
      assert.equal(response.status, 200, path);
      assert.equal(typeof await response.json(), 'object', path);
    }
    const agents = await (await fetch(`${coordinator.url}/api/agents`, { headers: { cookie } })).json() as { agents: { id: string }[] };
    assert.equal((await fetch(`${coordinator.url}/api/agents/${agents.agents[0]!.id}`, { headers: { cookie } })).status, 200);
    const hits = await (await fetch(`${coordinator.url}/api/projects/checkout-v2/search?q=idempotency`, { headers: { cookie } })).json() as { hits: { title: string }[] };
    assert.equal(hits.hits[0]?.title, 'Idempotency in checkout');

    // Nordlys Studio has its own team, a custom tab, checks rather than tests, and its own connections and handoffs.
    const read = async (path: string) => await (await fetch(coordinator.url + path, { headers: { cookie } })).json() as any;
    const studio = await read('/api/projects/nordlys-studio');
    assert.deepEqual([studio.project.kind, studio.roster.map((seat: { name: string }) => seat.name), studio.customTabs], ['documents', ['Ingrid', 'Sol', 'Tuva', 'Emil'], [{ label: 'Editorial calendar', url: 'https://calendar.nordlys.example/editorial' }]]);
    assert.deepEqual(Object.values(studio.board as Record<string, unknown[]>).map(column => column.length), [0, 2, 2, 1, 1]);
    const checks = await read('/api/projects/nordlys-studio/checks');
    assert.deepEqual([checks.suites, checks.branches.map((row: { branch: string }) => row.branch).sort(), checks.failing.length], [['Fact check', 'Links and images', 'Style guide'], ['Autumn issue', 'Winter issue, draft'], 2]);
    const integrations = await read('/api/projects/nordlys-studio/integrations');
    assert.deepEqual(integrations.connections.map((item: { name: string }) => item.name).sort(), ['Editorial channel', 'Manuscripts folder', 'Photo library']);
    assert.deepEqual(integrations.handoffs.map((item: any) => [item.direction, item.state, item.target?.key ?? null]).sort(), [['in', 'new', null], ['out', 'outbox', 'NS-11']]);
    assert.equal((await read('/api/projects/checkout-v2/integrations')).connections.length, 0);
    assert.equal((await read('/api/projects/nordlys-studio/search?q=voice')).hits[0]?.title, 'House voice');
    assert.deepEqual((await read('/api/budgets')).budgets.map((budget: { scope: string }) => budget.scope).sort(), ['org', 'project']);
    assert.equal((await read('/api/org')).projects.find((node: { slug: string }) => node.slug === 'nordlys-studio').roster.length, 4);
  } finally {
    await coordinator.close();
    await local?.stop();
  }
});
