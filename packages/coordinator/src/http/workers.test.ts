import test from 'node:test';
import assert from 'node:assert/strict';
import { workerIdFor } from '@agent-team/protocol';
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
