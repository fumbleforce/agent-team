import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { packageRoot, Role } from '@agent-team/protocol';
import { createStorage } from '@agent-team/storage';
import { createContext } from '../context.ts';
import { createOrg } from '../repos/org.ts';
import { createVersionedDocs } from '../repos/versionedDocs.ts';
import { createWorkspace } from '../repos/workspace.ts';
import { buildPacket } from './packet.ts';
import { createProposals } from './proposals.ts';
import { createScorecard } from './scorecard.ts';
import { createTrials } from './trials.ts';
import { createTurns } from './turns.ts';
import { wayOfWorking } from './wayOfWorking.ts';

const LIBRARY = { type: 'library' as const, id: '' };
const DAY = 24 * 3600_000;
const blueprint = (name: string) => JSON.parse(readFileSync(path.join(packageRoot(), 'blueprints', name), 'utf8')) as Record<string, any>;

// The default team with Toby hired to staff it, on a clock the test moves.
async function boot(options: { processDecides?: boolean } = {}) {
  const storage = await createStorage({ kind: 'sqlite', path: ':memory:' });
  await storage.migrate();
  let clock = Date.UTC(2026, 5, 1);
  const context = createContext({ storage, machineToken: 'x'.repeat(24), now: () => clock });
  const docs = createVersionedDocs(context), library = blueprint('library-agents.json');
  await docs.seed('role', LIBRARY, blueprint('roles.json'));
  await docs.seed('library_agent', LIBRARY, library);
  const projectId = await createWorkspace(context).registerProject({ slug: 'shop', name: 'Shop', kind: 'repo', manifest: {} });
  await createOrg(context).hire('user-1', projectId, { slug: 'toby', doc: library.toby }, { library: 'toby' });
  if (options.processDecides !== false) await docs.save('delegation_rules', { type: 'project', id: projectId }, 'default', { process: { decides: true, maxTrialDays: 30 } }, { author: 'owner' });
  const db = storage.db, turns = createTurns(context);
  const toby = { agent_id: (await db.selectFrom('agents').select('id').where('name', '=', 'Toby').executeTakeFirstOrThrow()).id, project_id: projectId };
  const ada = (await db.selectFrom('agents').select('id').where('name', '=', 'Ada').executeTakeFirstOrThrow()).id;
  await db.insertInto('workers').values({ id: 'w1', name: 'w1', lanes: '{}', isolation: 'isolated', providers: '[]', projects: '[]', last_seen_at: clock }).execute();
  // Finished tasks that took a given number of work turns each, all inside one window of time: the figures a trial is judged by.
  let made = 0;
  const finished = async (at: number, leadMs: number) => {
    const id = `t-${++made}`;
    await db.insertInto('tasks').values({ id, project_id: projectId, key: id.toUpperCase(), source: 'internal', title: id, brief: '', tag: null, priority: made, milestone_id: null, state: 'done', assignee_agent_id: ada, author_agent_id: null, branch: null, head_sha: null, pr_url: null, blocked_reason: null, created_at: at - leadMs, updated_at: at } as never).execute();
  };
  return { storage, db, docs, context, proposals: createProposals(context, turns), trials: createTrials(context), toby, ada, projectId, finished, tick: (ms: number) => { clock += ms; }, now: () => clock };
}
const why = { title: 'How we work', why: 'Documents wait a day for a second reviewer who finds nothing the first did not.', evidence: [{ label: 'Second reviews with no new finding', value: '9 of 10' }] };

test('the seat that staffs the team changes how it works, as a trial that is kept when its figure moved the way it said', async () => {
  const { storage, db, proposals, trials, toby, projectId, finished, tick, now } = await boot();
  try {
    // Before: tasks took three hours from created to done.
    for (let index = 0; index < 4; index++) await finished(now() - (index + 1) * 3600_000, 3 * 3600_000);
    const decided = await proposals.staff(toby, { ...why, change: { kind: 'change_process', knob: 'documentReviewers', value: 1, trial: { measure: 'P1', expect: 'down', days: 7 } } });
    assert.equal(decided.state, 'applied');
    assert.equal((await storage.transaction(tx => wayOfWorking(tx, projectId))).knobs.documentReviewers, 1, 'in force at once');
    const [record] = await proposals.list([projectId]);
    assert.deepEqual([record!.category, record!.state], ['process', 'auto_applied']);
    assert.match(record!.whatChanges, /documentReviewers becomes 1, as a trial of 7 days judged by P1 going down/);
    await assert.rejects(proposals.staff(toby, { ...why, change: { kind: 'change_process', knob: 'documentReviewers', value: 2, trial: { measure: 'P1', expect: 'down', days: 7 } } }), /already running/);

    // During: one hour. The trial is not judged before its time is up.
    tick(3 * DAY);
    for (let index = 0; index < 4; index++) await finished(now() - index * 3600_000, 3600_000);
    assert.equal(await trials.sweep(), 0);
    tick(4 * DAY + 1000);
    assert.equal(await trials.sweep(), 1);
    const trial = await db.selectFrom('trials').selectAll().executeTakeFirstOrThrow();
    assert.deepEqual([trial.state, trial.baseline, trial.result], ['kept', 3 * 3600_000, 3600_000]);
    assert.match(trial.verdict!, /P1 went from 3\.0 h to 1\.0 h, expected down: the change is kept/);
    assert.equal((await storage.transaction(tx => wayOfWorking(tx, projectId))).knobs.documentReviewers, 1);
    assert.match((await db.selectFrom('messages').select('body').where('payload', 'like', '%trial%').executeTakeFirstOrThrow()).body, /Trial of a change to knob documentReviewers: P1 went from/);

    const card = await createScorecard({ ...storageContext(storage, now) }).compute(projectId, { from: now() - 30 * DAY, to: now() });
    const byId = Object.fromEntries(card.figures.map(entry => [entry.id, entry]));
    assert.deepEqual([byId.I1!.value, byId.I2!.value, byId.I2!.met], [1, 1, true]);
  } finally { await storage.close(); }
});

test('a change that did not help, or could not be shown to, is put back by itself, and only that change', async () => {
  const { storage, db, proposals, trials, toby, projectId, finished, tick, now } = await boot();
  try {
    for (let index = 0; index < 3; index++) await finished(now() - (index + 1) * 3600_000, 3600_000);
    const text = 'Your task is below. Read the brief twice, write down what done means in one sentence, and only then start. Finish by calling task.update.';
    await proposals.staff(toby, { ...why, change: { kind: 'change_instructions', turnKind: 'work', text, trial: { measure: 'P1', expect: 'down', days: 5 } } });
    // A second, unrelated trial on a figure nothing will measure.
    await proposals.staff(toby, { ...why, change: { kind: 'change_process', knob: 'stalledAfter', value: 4, trial: { measure: 'P5', expect: 'up', days: 5 } } });
    const ada = await db.selectFrom('agents').select('id').where('name', '=', 'Ada').executeTakeFirstOrThrow();
    const packet = () => storage.transaction(tx => buildPacket(tx, { kind: 'work', agentId: ada.id, projectId, taskId: null, threadId: null }));
    assert.ok((await packet()).prompt.startsWith('Your task is below. Read the brief twice'), 'a work turn is told the new text while the trial runs');

    tick(2 * DAY);
    for (let index = 0; index < 3; index++) await finished(now() - index * 3600_000, 5 * 3600_000);
    tick(3 * DAY + 1000);
    assert.equal(await trials.sweep(), 2);
    const judged = Object.fromEntries((await db.selectFrom('trials').select(['target', 'state', 'verdict']).execute()).map(row => [row.target, row]));
    assert.equal(judged['instructions:work']!.state, 'reverted');
    assert.match(judged['instructions:work']!.verdict!, /went from 1\.0 h to 5\.0 h, expected down: the change was put back/);
    assert.equal(judged['knob:stalledAfter']!.state, 'reverted');
    assert.match(judged['knob:stalledAfter']!.verdict!, /could not be measured/);
    const way = await storage.transaction(tx => wayOfWorking(tx, projectId));
    assert.deepEqual([way.instructions.work, way.knobs.stalledAfter], [undefined, 3]);
    assert.ok((await packet()).prompt.startsWith('Your task is below. The goal is what the brief is for'), 'the shipped instruction stands again');
  } finally { await storage.close(); }
});

test('what a role looks for can be changed the same way; how the team works is the owner\'s to decide until the owner says otherwise; what keeps the work safe is not on offer', async () => {
  const waiting = await boot({ processDecides: false });
  try {
    const asked = await waiting.proposals.staff(waiting.toby, { ...why, change: { kind: 'change_process', knob: 'documentReviewers', value: 1, trial: { measure: 'P1', expect: 'down', days: 7 } } });
    assert.equal(asked.state, 'needs_owner');
    assert.match(asked.note!, /The owner decides how this team works/);
    assert.equal((await waiting.storage.transaction(tx => wayOfWorking(tx, waiting.projectId))).knobs.documentReviewers, 2, 'nothing changed');
    assert.equal((await waiting.db.selectFrom('trials').select('id').execute()).length, 0);
  } finally { await waiting.storage.close(); }

  const { storage, db, proposals, toby } = await boot();
  try {
    const perspective = 'What breaks under load and on bad input. Proves every claim with a run, and says what could not be run. Reads the change against its brief.';
    assert.equal((await proposals.staff(toby, { ...why, change: { kind: 'change_role_text', role: 'reviewer', perspective, trial: { measure: 'T5', expect: 'up', days: 14 } } })).state, 'applied');
    const role = Role.parse(JSON.parse((await db.selectFrom('versioned_docs').select('doc').where('kind', '=', 'role').where('slug', '=', 'reviewer').executeTakeFirstOrThrow()).doc));
    assert.equal(role.perspective, perspective);
    assert.deepEqual(role.approvalKinds, ['reviewer'], 'only the text changed: what the role may approve and do is untouched');

    await assert.rejects(proposals.staff(toby, { ...why, change: { kind: 'change_process', knob: 'documentReviewers', value: 0, trial: { measure: 'P1', expect: 'down', days: 7 } } }), /outside what documentReviewers may be/);
    await assert.rejects(proposals.staff(toby, { ...why, change: { kind: 'change_process', knob: 'checkInEvery', value: 10, trial: { measure: 'Z9', expect: 'down', days: 7 } } }), /not a figure of the scorecard/);
    await assert.rejects(proposals.staff(toby, { ...why, change: { kind: 'change_process', knob: 'checkInEvery', value: 10, trial: { measure: 'P1', expect: 'down', days: 45 } } }), /30 days at most/);
    await assert.rejects(proposals.staff(toby, { ...why, change: { kind: 'change_role_text', role: 'wizard', perspective, trial: { measure: 'T5', expect: 'up', days: 14 } } }), /no role called wizard/);
  } finally { await storage.close(); }
});

function storageContext(storage: Awaited<ReturnType<typeof createStorage>>, now: () => number) {
  return createContext({ storage, machineToken: 'x'.repeat(24), now });
}
