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
];

for (const kind of ['sqlite', 'postgres'] as const) test(`${kind}: the demo serves every screen to its owner and nothing to a stranger`, async () => {
  const local = kind === 'postgres' ? await postgresForTests() : null;
  const coordinator = await startCoordinator({ port: 0, storage: local?.config ?? { kind: 'sqlite', path: ':memory:' }, machineToken: 'x'.repeat(24), webRoot: null, trackers: null, demoLogin: DEMO_LOGIN });
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
  await coordinator.close();
  await local?.stop();
});
