import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTurns, startCoordinator } from '@agent-team/coordinator';
import { fake } from '../../../adapters/engine/fake.ts';
import { createWorker } from './worker.ts';

const TOKEN = 'machine-token-for-tests-0123456789';

// A team made in the app without a repository (marketing, sales) has no checkout on any machine. A worker that keeps desks serves it anyway,
// in a scratch folder of its own; one that does not, never claims its work.
test('a project without a repository, made after the worker started, is served by a desks worker in a scratch folder', async () => {
  const coordinator = await startCoordinator({ port: 0, storage: { kind: 'sqlite', path: ':memory:' }, machineToken: TOKEN, webRoot: null, trackers: null });
  try {
    const db = coordinator.context.storage.db, machine = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
    const register = async (body: unknown) => ((await (await fetch(`${coordinator.url}/machine/projects`, { method: 'POST', headers: machine, body: JSON.stringify(body) })).json()) as { id: string }).id;
    const shop = await register({ slug: 'shop', name: 'Shop', manifest: { scm: { kind: 'github' }, delivery: { repository: 'acme/shop', baseBranch: 'main' } } });
    const checkout = mkdtempSync(path.join(os.tmpdir(), 'agent-team-desk-checkout-'));
    const stateDir = mkdtempSync(path.join(os.tmpdir(), 'agent-team-desk-')), plainState = mkdtempSync(path.join(os.tmpdir(), 'agent-team-desk-'));
    const env = { ...process.env, FAKE_SCENARIO: 'shell:desk-note.txt' };
    const desks = createWorker({ coordinatorUrl: coordinator.url, token: TOKEN, workerId: 'desks', stateDir, lanes: { work: 1, bounded: 1, deliver: 1 }, projects: { [shop]: checkout }, desks: true, desksRefreshMs: 0, engine: fake, env, timeoutMs: 5000 });
    const plain = createWorker({ coordinatorUrl: coordinator.url, token: TOKEN, workerId: 'plain', stateDir: plainState, lanes: { work: 1, bounded: 1, deliver: 1 }, projects: { [shop]: checkout }, engine: fake, env, timeoutMs: 5000 });
    assert.equal(await desks.tick(), false, 'nothing to do yet');

    const marketing = await register({ slug: 'marketing', name: 'Marketing' });
    const listed = (await (await fetch(`${coordinator.url}/machine/desks`, { headers: machine })).json()) as { projects: string[] };
    assert.deepEqual(listed.projects, [marketing], 'a project with a repository is no desk');
    const seat = await db.selectFrom('agents').innerJoin('projects', 'projects.team_id', 'agents.team_id').select('agents.id').where('projects.id', '=', marketing).executeTakeFirstOrThrow();
    const thread = await db.selectFrom('threads').select('id').where('project_id', '=', marketing).where('kind', '=', 'discussion').executeTakeFirstOrThrow();
    assert.ok(await createTurns(coordinator.context).enqueue({ agentId: seat.id, projectId: marketing, kind: 'reply', threadId: thread.id }));

    assert.equal(await plain.tick(), false, 'a worker without desks never claims it');
    assert.equal(await desks.tick(), true);
    await desks.idle();
    const turn = await db.selectFrom('turns').select(['state', 'worker_id', 'project_id']).executeTakeFirstOrThrow();
    assert.deepEqual({ ...turn }, { state: 'completed', worker_id: 'desks', project_id: marketing });
    // The turn ran in the desk's own folder under the worker's state, not in the process's directory or another project's checkout.
    assert.equal(readFileSync(path.join(stateDir, 'desks', marketing, 'desk-note.txt'), 'utf8'), 'from the shell\n');
    assert.equal(existsSync(path.join(checkout, 'desk-note.txt')), false);
    assert.equal(existsSync(path.join(process.cwd(), 'desk-note.txt')), false);
    // What the worker serves is what the app and the launcher read: the desk counts as served.
    const seen = await db.selectFrom('workers').select('projects').where('id', '=', 'desks').executeTakeFirstOrThrow();
    assert.deepEqual((JSON.parse(seen.projects) as string[]).sort(), [marketing, shop].sort());
  } finally { await coordinator.close(); }
});
