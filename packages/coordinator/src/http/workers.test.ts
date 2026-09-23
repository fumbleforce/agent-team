import test from 'node:test';
import assert from 'node:assert/strict';
import { workerIdFor } from '@agent-team/protocol';
import { resolveProjects } from '../../../worker/src/projects.ts';
import { boot, TOKEN } from './testing.ts';

test('two workers on one machine do not take each other\'s projects away, and a finished setup step stays finished', async () => {
  const { coordinator, db, call, owner } = await boot();
  try {
    const cookie = await owner();
    const machine = { authorization: `Bearer ${TOKEN}` };
    const ids: Record<string, string> = {};
    for (const slug of ['alpha', 'beta']) ids[slug] = (await call('/machine/projects', { headers: machine, body: { slug, name: slug, manifest: { scm: { kind: 'github' }, delivery: { repository: `acme/${slug}` } } } })).json.id;
    const poll = (workerId: string, projectId: string) => call('/worker/claim', { headers: machine, body: { workerId, free: { work: 1 }, projects: [projectId] } });
    const codeStep = async (slug: string) => ((await call(`/api/onboarding?project=${slug}`, { cookie })).json.steps as { key: string; done: boolean; detail: string }[]).find(step => step.key === 'code')!;

    // Named per project, as every way of starting a worker now does.
    assert.notEqual(workerIdFor('host', 'alpha'), workerIdFor('host', 'beta'));

    // The old situation: both report under the machine's name alone, turn and turn about. Neither project may lose its worker.
    for (let round = 0; round < 3; round++) {
      await poll('host', ids.alpha!);
      assert.equal((await codeStep('alpha')).done, true, `alpha after its own poll, round ${round}`);
      await poll('host', ids.beta!);
      assert.equal((await codeStep('alpha')).done, true, `alpha after beta polled, round ${round}`);
      assert.equal((await codeStep('beta')).done, true, `beta, round ${round}`);
    }

    // A worker that went away does not undo the step; the detail says so instead.
    await db.updateTable('workers').set({ last_seen_at: 1 }).execute();
    const away = await codeStep('alpha');
    assert.deepEqual([away.done, /no worker running right now/.test(away.detail)], [true, true]);
  } finally { await coordinator.close(); }
});

test('a worker configured with the name of a project, as `up` writes it, ends up serving that project and completes the step of the guide', async () => {
  const { coordinator, call, owner } = await boot();
  try {
    const cookie = await owner();
    const machine = { authorization: `Bearer ${TOKEN}` };
    const id = (await call('/machine/projects', { headers: machine, body: { slug: 'agent-team', name: 'Agent Team', manifest: { scm: { kind: 'github' }, delivery: { repository: 'acme/agent-team' } } } })).json.id as string;
    const codeStep = async () => ((await call('/api/onboarding?project=agent-team', { cookie })).json.steps as { key: string; done: boolean }[]).find(step => step.key === 'code')!;

    // Reporting the name itself is what the old configuration did: the coordinator does not know a project by that, and the step stays open.
    await call('/worker/claim', { headers: machine, body: { workerId: 'host.agent-team', free: { work: 1 }, projects: ['agent-team'] } });
    assert.equal((await codeStep()).done, false);

    // The worker now looks the name up first and reports the id.
    const { projects, unknown } = await resolveProjects({ 'agent-team': '/code/agent-team' }, { coordinatorUrl: coordinator.url, token: TOKEN });
    assert.deepEqual([projects, unknown], [{ [id]: '/code/agent-team' }, []]);
    await call('/worker/claim', { headers: machine, body: { workerId: 'host.agent-team', free: { work: 1 }, projects: Object.keys(projects) } });
    assert.equal((await codeStep()).done, true);
  } finally { await coordinator.close(); }
});

test('behind a proxy that ends TLS, a pairing link leads to the address the person reached, not the one inside', async () => {
  const { coordinator, call, owner } = await boot();
  try {
    const cookie = await owner();
    await call('/api/projects', { cookie, body: { name: 'Shop' } });
    const link = (await call('/api/projects/shop/worker/pair', { cookie, body: {}, headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'team.example.org' } })).json.link as string;
    assert.match(link, /^https:\/\/team\.example\.org\/pair\/[A-Za-z0-9-]+$/);
    assert.match((await call('/api/projects/shop/worker/pair', { cookie, body: {}, headers: { 'x-forwarded-host': 'bad host!' } })).json.link, /^http:\/\/127\.0\.0\.1:\d+\/pair\//, 'a host that is not one is not used');
  } finally { await coordinator.close(); }
});

test('a worker that speaks another version of the protocol is turned away with what to update; one that says none is taken to speak the first', async () => {
  const { coordinator, call, machine } = await boot();
  try {
    const claim = (protocol?: number) => call('/worker/claim', { headers: machine, body: { workerId: 'w1', free: { work: 1 }, projects: [], ...(protocol === undefined ? {} : { protocol }) } });
    const newer = await claim(99);
    assert.equal(newer.status, 426);
    assert.match(newer.json.error.message, /^Update the coordinator: this worker speaks version 99/);
    assert.equal((await claim()).status, 200);
    assert.equal((await claim(1)).status, 200);
  } finally { await coordinator.close(); }
});
