import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { packageRoot } from '@agent-team/protocol';
import { boot } from './testing.ts';

// The recorded answers the skill-source contract test uses: a folder of two skills and one without a description.
const answers = JSON.parse(readFileSync(path.join(packageRoot(), 'adapters', 'skills', 'fixtures', 'github.json'), 'utf8')) as Record<string, unknown>;
const FOLDER = 'https://github.com/o/r/tree/main/pack/skills';

test('skills are read by everyone, written and reverted by admins, and each says which roles use it', async () => {
  const { coordinator, call, owner, person } = await boot({ env: {} });
  try {
    const cookie = await owner(), member = await person('mia', 'member');
    const listed = (await call('/api/skills', { cookie: member.cookie })).json;
    assert.equal(listed.canEdit, false);
    assert.equal(listed.skills.length, 25);
    const unslop = listed.skills.find((skill: { slug: string }) => skill.slug === 'unslop');
    assert.deepEqual([unslop.always, unslop.usedBy.length, unslop.source.license, unslop.author], [true, 13, 'MIT', 'toolkit']);
    const tdd = (await call('/api/skills/tdd', { cookie: member.cookie })).json;
    assert.deepEqual([tdd.doc.files.map((file: { path: string }) => file.path), tdd.usedBy, tdd.history.map((row: { note: string }) => row.note)], [['mocking.md', 'tests.md'], ['developer', 'reviewer'], ['seeded']]);

    // A member reads but does not write.
    assert.equal((await call('/api/skills/house-style', { cookie: member.cookie, body: { doc: { description: 'Use when writing.', body: 'Say it plainly.' }, expectedVersion: 0 } })).status, 403);
    // An admin writes a new one, edits a shipped one, and puts it back.
    assert.equal((await call('/api/skills/house-style', { cookie, body: { doc: { description: 'Use when writing for this house.', body: 'Say it plainly.' }, expectedVersion: 0 } })).json.version, 1);
    assert.match((await call('/api/skills/Bad Name', { cookie, body: { doc: { description: 'x', body: 'y' } } })).text, /lower-case/);
    assert.equal((await call('/api/skills/house-style', { cookie, body: { doc: { description: 'x', body: '' } } })).status, 400);
    const original = tdd.doc.body as string;
    assert.equal((await call('/api/skills/tdd', { cookie, body: { doc: { ...tdd.doc, body: 'Ours now.' }, note: 'Shorter', expectedVersion: 1 } })).json.version, 2);
    assert.equal((await call('/api/skills/tdd', { cookie, body: { doc: { ...tdd.doc, body: 'Lost race.' }, expectedVersion: 1 } })).status, 409, 'an edit made on an older version is refused');
    assert.equal((await call('/api/skills/tdd/revert', { cookie, body: { version: 1 } })).json.version, 3);
    const after = (await call('/api/skills/tdd', { cookie })).json;
    assert.deepEqual([after.doc.body === original, after.author, after.history.map((row: { note: string }) => row.note)], [true, 'Owner', ['Reverted to version 1', 'Shorter', 'seeded']]);
  } finally { await coordinator.close(); }
});

test('a folder of skills is imported in two steps: a look at what is new, changed or the same, then the ones chosen', async () => {
  const served = { ...answers };
  const fake = (async (input: string | URL) => { const url = String(input); return Object.hasOwn(served, url) ? new Response(typeof served[url] === 'string' ? served[url] as string : JSON.stringify(served[url]), { status: 200 }) : new Response('{}', { status: 404 }); }) as typeof fetch;
  const { coordinator, call, owner, person } = await boot({ env: {}, fetch: fake });
  try {
    const cookie = await owner(), member = await person('mia', 'member');
    assert.equal((await call('/api/skills/import/preview', { cookie: member.cookie, body: { url: FOLDER } })).status, 403);
    assert.match((await call('/api/skills/import/preview', { cookie, body: { url: 'https://example.com/skills' } })).json.error.message, /GitHub address/);

    const look = (await call('/api/skills/import/preview', { cookie, body: { url: FOLDER } })).json;
    assert.deepEqual([look.source.repository, look.source.license, look.source.author], ['o/r', 'MIT', 'Ada Lovelace']);
    assert.deepEqual(look.skills.map((skill: { slug: string; state: string }) => [skill.slug, skill.state]), [['alpha', 'new'], ['beta', 'new']]);
    assert.deepEqual(look.skipped, ['alpha/huge.md: larger than 60 kB', 'no-description: its SKILL.md has no description or no text']);

    assert.deepEqual((await call('/api/skills/import', { cookie, body: { url: FOLDER, slugs: ['alpha'] } })).json.imported, ['alpha']);
    const alpha = (await call('/api/skills/alpha', { cookie })).json;
    assert.deepEqual([alpha.doc.source.repository, alpha.doc.source.path, alpha.doc.source.commit, alpha.doc.always, alpha.history[0].note], ['o/r', 'pack/skills/alpha', 'a'.repeat(40), false, `Imported from o/r at ${'a'.repeat(7)}`]);
    assert.equal((await call('/api/skills/import', { cookie, body: { url: FOLDER, slugs: ['gamma'] } })).status, 409);

    // Made always-applied here; the source changes; the look says so, and a new import keeps this organization's choice.
    await call('/api/skills/alpha', { cookie, body: { doc: { ...alpha.doc, always: true } } });
    assert.deepEqual((await call('/api/skills/import/preview', { cookie, body: { url: FOLDER } })).json.skills.map((skill: { state: string }) => skill.state), ['same', 'new']);
    served[`https://raw.githubusercontent.com/o/r/${'a'.repeat(40)}/pack/skills/alpha/SKILL.md`] = '---\ndescription: Use when the first letter matters.\n---\nA newer alpha.';
    assert.deepEqual((await call('/api/skills/import/preview', { cookie, body: { url: FOLDER } })).json.skills.map((skill: { state: string }) => skill.state), ['changed', 'new']);
    await call('/api/skills/import', { cookie, body: { url: FOLDER, slugs: ['alpha', 'beta'] } });
    const again = (await call('/api/skills/alpha', { cookie })).json;
    assert.deepEqual([again.doc.body, again.doc.always, again.version], ['A newer alpha.', true, 3]);
  } finally { await coordinator.close(); }
});
