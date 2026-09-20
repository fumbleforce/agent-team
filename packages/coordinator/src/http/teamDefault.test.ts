import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './testing.ts';

test('a team has a default that agents without a model of their own run on, the page says what the worker itself would run, and effort is chosen from what the tool says it takes', async () => {
  const { coordinator, call, owner, machine } = await boot();
  try {
    const cookie = await owner();
    await call('/api/projects', { cookie, body: { name: 'Shop' } });
    const project = (await call('/api/projects/shop', { cookie })).json, pm = project.roster.find((agent: { is_pm: boolean }) => agent.is_pm);
    const ready = { engines: ['claude'], variables: [], models: { claude: [{ id: 'newest', name: 'newest' }, { id: 'middle', name: 'middle' }] }, efforts: { claude: ['quick', 'deep'] }, runs: { engine: 'claude', model: 'newest[1m]' } };
    await call('/worker/claim', { headers: machine, body: { workerId: 'atlas', free: {}, projects: [project.project.id], ready } });

    // Nothing chosen yet: the page can say what "the worker decides" means, instead of leaving it a mystery.
    const before = (await call('/api/projects/shop/team', { cookie })).json;
    assert.deepEqual([before.fallback, before.workerRuns], [{ providerId: null, model: null, effort: null }, [{ worker: 'atlas', engine: 'claude', model: 'newest[1m]', efforts: ['quick', 'deep'] }]]);

    // A provider whose effort levels are the ones the worker read from the tool.
    const providerId = (await call('/api/providers/setup', { cookie, body: { kind: 'claude-subscription', values: { models: 'newest\nmiddle' } } })).json.id as string;
    assert.deepEqual(((await call('/api/providers', { cookie })).json.providers as { id: string; efforts: string[] }[]).find(item => item.id === providerId)!.efforts, ['quick', 'deep']);

    // The team default: a model the provider offers, and an effort. It is what a turn of an agent without its own runs with.
    assert.match((await call('/api/projects/shop/team/default', { cookie, body: { providerId, model: 'huge' } })).json.error.fields.model, /does not offer huge/);
    assert.equal((await call('/api/projects/shop/team/default', { cookie, body: { providerId, model: 'middle', effort: 'quick' } })).status, 200);
    assert.deepEqual((await call('/api/projects/shop/team', { cookie })).json.fallback, { providerId, model: 'middle', effort: 'quick' });
    await call('/api/projects/shop/issues', { cookie, body: { title: 'Something', body: 'Anything.' } });
    const claim = () => call('/worker/claim', { headers: machine, body: { workerId: 'atlas', free: { work: 1, bounded: 1 }, projects: [project.project.id], ready } });
    const first = (await claim()).json.turn;
    assert.deepEqual([first.agentId, first.engine, first.model, first.effort], [pm.id, 'claude', 'middle', 'quick']);
    await call(`/worker/turns/${first.turnId}/finish`, { headers: machine, body: { workerId: 'atlas', leaseToken: first.leaseToken, outcome: { state: 'completed', stopReason: 'completed', summary: 'Done.' } } });

    // An agent's own choice wins over the team's, model and effort alike.
    assert.equal((await call(`/api/agents/${pm.id}/provider`, { cookie, body: { providerId, model: 'newest', effort: 'deep' } })).status, 200);
    await call('/api/projects/shop/issues', { cookie, body: { title: 'Another', body: 'Thing.' } });
    const second = (await claim()).json.turn;
    assert.deepEqual([second.model, second.effort], ['newest', 'deep']);
  } finally { await coordinator.close(); }
});
