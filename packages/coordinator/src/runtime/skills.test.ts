import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { packageRoot, parseSkillMarkdown } from '@agent-team/protocol';
import { createStorage } from '@agent-team/storage';
import { createContext } from '../context.ts';
import { seedDemo } from '../demo/seed.ts';
import { createVersionedDocs } from '../repos/versionedDocs.ts';
import { turnToken } from '../auth/secrets.ts';
import { startCoordinator } from '../server.ts';
import { sendBackToMerge } from './conflicts.ts';
import { SKILL_SCOPE, shippedSkills, skillsPart } from './skills.ts';
import { createTurns } from './turns.ts';

const TOKEN = 'machine-token-for-tests-0123456789';
const blueprint = (name: string) => path.join(packageRoot(), 'blueprints', name);

test('the shipped skills are whole and licensed, every one is named by a role, and every role applies unslop', () => {
  const shipped = shippedSkills(blueprint('skills'));
  const roles = JSON.parse(readFileSync(blueprint('roles.json'), 'utf8')) as Record<string, { skills: string[] }>;
  assert.equal(Object.keys(shipped).length, 25);
  assert.ok(Object.values(shipped).every(skill => skill.source?.license === 'MIT' && /^[0-9a-f]{40}$/.test(skill.source.commit ?? '') && skill.description.length > 20));
  assert.deepEqual(Object.values(shipped).filter(skill => skill.always).map(skill => skill.slug), ['unslop']);
  for (const [slug, role] of Object.entries(roles)) {
    assert.ok(role.skills.includes('unslop'), `${slug} applies unslop`);
    for (const name of role.skills) assert.ok(shipped[name], `${slug} names ${name}, which is shipped`);
  }
  const named = new Set(Object.values(roles).flatMap(role => role.skills));
  assert.deepEqual(Object.keys(shipped).filter(slug => !named.has(slug)), [], 'no shipped skill is left without a role');
  // Files come with their skill; another tool's display metadata does not.
  assert.deepEqual(shipped.tdd!.files.map(file => file.path), ['mocking.md', 'tests.md']);
  assert.ok(Object.values(shipped).every(skill => skill.files.every(file => !file.path.startsWith('agents/'))));
  assert.deepEqual(shipped['resolving-merge-conflicts']!.source, { repository: 'mattpocock/skills', path: 'skills/engineering/resolving-merge-conflicts', commit: shipped['resolving-merge-conflicts']!.source!.commit, license: 'MIT', author: 'Matt Pocock' });
});

test('the front matter of a SKILL.md is read without a YAML library', () => {
  assert.deepEqual(parseSkillMarkdown('---\nname: tdd\ndescription: "Use when \\"red-green\\" is asked: always."\ndisable-model-invocation: true\n---\n\n# TDD\nBody.\n'), { meta: { name: 'tdd', description: 'Use when "red-green" is asked: always.', 'disable-model-invocation': 'true' }, body: '# TDD\nBody.' });
  assert.deepEqual(parseSkillMarkdown('---\r\nname: fold\r\ndescription: >-\r\n  one\r\n  two\r\n---\r\nText').meta, { name: 'fold', description: 'one two' });
  assert.deepEqual(parseSkillMarkdown("---\ndescription: 'it''s quoted'\n---\nx").meta, { description: "it's quoted" });
  assert.deepEqual(parseSkillMarkdown('No front matter at all.'), { meta: {}, body: 'No front matter at all.' });
});

test('a seat has the skills of its roles: the always-applied ones in full, the rest one line each, read in full with skill.read', async () => {
  const coordinator = await startCoordinator({ port: 0, storage: { kind: 'sqlite', path: ':memory:' }, machineToken: TOKEN, webRoot: null, trackers: null });
  try {
    await seedDemo(coordinator.context);
    const db = coordinator.context.storage.db, turns = createTurns(coordinator.context);
    const project = await db.selectFrom('projects').select('id').where('slug', '=', 'checkout-v2').executeTakeFirstOrThrow();
    const thread = await db.selectFrom('threads').select('id').where('project_id', '=', project.id).where('kind', '=', 'discussion').executeTakeFirstOrThrow();
    const agents = Object.fromEntries((await db.selectFrom('agents').select(['id', 'name']).execute()).map(row => [row.name, row.id])) as Record<string, string>;
    await db.deleteFrom('agent_roles').execute();
    await db.insertInto('agent_roles').values([{ agent_id: agents.Bram!, role_slug: 'developer' }, { agent_id: agents.Ada!, role_slug: 'front-desk' }]).execute();
    const replyOf = async (agentId: string) => {
      await turns.enqueue({ agentId, projectId: project.id, kind: 'reply', threadId: thread.id, dedupeKey: `reply:${agentId}` });
      return (await turns.claim({ workerId: 'w1', free: { work: 1, bounded: 1 }, projects: [project.id] }))!;
    };

    const developer = await replyOf(agents.Bram!), system = developer.packet.system;
    assert.match(system, /# Always apply: unslop\nApply this to everything a person reads: chat replies, reports and task summaries, documents, pull request descriptions and commit messages\.\n\n# Unslop\n\nEdit text to remove AI patterns\./);
    assert.match(system, /# Your skills\nA skill is a written method for one kind of work\./);
    assert.match(system, /\n- tdd: Test-driven development\. Use when/);
    assert.match(system, /\n- resolving-merge-conflicts: Use when you need to resolve an in-progress git merge\/rebase conflict\./);
    assert.ok(system.indexOf('# Your skills') < system.indexOf('# Your notebook'), 'skills come before the notebook, which changes more often');
    assert.doesNotMatch(system, /Test-Driven Development\n\nTDD is the red/, 'a skill that is not always applied is not in the prompt in full');

    const desk = await replyOf(agents.Ada!);
    assert.match(desk.packet.system, /# Always apply: unslop/);
    assert.doesNotMatch(desk.packet.system, /# Your skills/, 'a seat whose only skill is always applied has no list to read from');

    // A turn whose words no person reads (a review, feedback to a colleague) carries the short form, which points at the rest.
    const brief = (await coordinator.context.storage.transaction(tx => skillsPart(tx, agents.Bram!, { brief: true })))!;
    assert.match(brief, /# Always apply: unslop\n.*\n\nWrite plain, specific sentences .* read the full list of patterns with skill\.read unslop\./s);
    assert.doesNotMatch(brief, /Superficial -ing phrases/, 'the full list stays out');
    assert.ok(brief.length < system.length - 3000);

    let id = 0;
    const call = async (name: string, args: unknown) => {
      const response = await fetch(`${coordinator.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${turnToken(TOKEN, developer.turnId, developer.leaseToken)}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }) });
      const result = ((await response.json()) as { result: { isError?: boolean; content: { text: string }[] } }).result;
      return { error: result.isError === true, text: result.content[0]!.text };
    };
    const tdd = JSON.parse((await call('skill.read', { name: 'tdd' })).text) as { body: string; files: string[] };
    assert.match(tdd.body, /^# Test-Driven Development/);
    assert.deepEqual(tdd.files, ['mocking.md', 'tests.md']);
    assert.match(JSON.parse((await call('skill.read', { name: 'tdd', file: './tests.md' })).text).content, /\S/);
    // Skills name each other; any skill of the library can be read.
    assert.equal((await call('skill.read', { name: 'blast-radius' })).error, false);
    const wrong = await call('skill.read', { name: 'nope' }), missing = await call('skill.read', { name: 'tdd', file: 'none.md' });
    assert.ok(wrong.error && /There is no skill nope\. Yours are: unslop, technical-writing, resolving-merge-conflicts/.test(wrong.text));
    assert.ok(missing.error && /tdd has no file none\.md; its files are: mocking\.md, tests\.md/.test(missing.text));
  } finally { await coordinator.close(); }
});

test('a shipped document nobody changed follows the shipped library; one an owner changed is never overwritten', async () => {
  const storage = await createStorage({ kind: 'sqlite', path: ':memory:' });
  await storage.migrate();
  try {
    const docs = createVersionedDocs(createContext({ storage, machineToken: 'x'.repeat(24) }));
    const skill = (body: string) => ({ slug: 'house', description: 'Use when writing for this house.', body });
    await docs.seed('skill', SKILL_SCOPE, { house: skill('one') });
    await docs.seed('skill', SKILL_SCOPE, { house: skill('one') });
    assert.equal((await docs.get('skill', SKILL_SCOPE, 'house')).version, 1, 'the same text is not a new version');
    await docs.seed('skill', SKILL_SCOPE, { house: skill('two') });
    assert.deepEqual([(await docs.get('skill', SKILL_SCOPE, 'house')).doc.body, (await docs.history('skill', SKILL_SCOPE, 'house'))[0]!.note], ['two', 'updated from the shipped library']);
    await docs.save('skill', SKILL_SCOPE, 'house', skill('mine'), { author: 'Owner' });
    await docs.seed('skill', SKILL_SCOPE, { house: skill('three') });
    assert.deepEqual([(await docs.get('skill', SKILL_SCOPE, 'house')).doc.body, (await docs.get('skill', SKILL_SCOPE, 'house')).version], ['mine', 3]);
  } finally { await storage.close(); }
});

test('a change sent back to merge the base names the merge-conflict skill when the library has it', async () => {
  const storage = await createStorage({ kind: 'sqlite', path: ':memory:' });
  await storage.migrate();
  try {
    const context = createContext({ storage, machineToken: 'x'.repeat(24) });
    await seedDemo(context);
    const db = storage.db, task = await db.selectFrom('tasks').select(['id']).where('key', '=', 'CK-31').executeTakeFirstOrThrow();
    const owner = await db.selectFrom('agents').select('id').where('name', '=', 'Bram').executeTakeFirstOrThrow();
    await db.updateTable('tasks').set({ assignee_agent_id: owner.id, head_sha: 'e'.repeat(40), state: 'in_review' }).where('id', '=', task.id).execute();
    const told = async () => (await db.selectFrom('messages').innerJoin('threads', 'threads.id', 'messages.thread_id').select('messages.body').where('threads.subject_id', '=', task.id).where('messages.kind', '=', 'system').orderBy('messages.seq', 'desc').executeTakeFirstOrThrow()).body;
    await createVersionedDocs(context).seed('skill', SKILL_SCOPE, { 'resolving-merge-conflicts': shippedSkills(blueprint('skills'))['resolving-merge-conflicts'] });
    await storage.transaction(tx => sendBackToMerge(tx, task.id, { now: 1, approved: false, actor: { actorKind: 'system' }, drafts: [] }));
    assert.match(await told(), /The resolving-merge-conflicts skill has the method; read it with skill\.read first\.$/);
  } finally { await storage.close(); }
});
