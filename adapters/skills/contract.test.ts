import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { readSkillCollection, skillSources, SkillSourceError } from './index.ts';

// Every source of skills answers the same way from recorded responses (fixtures/<source>.json, keyed by address).
const recorded = (name: string) => JSON.parse(readFileSync(path.join(import.meta.dirname, 'fixtures', `${name}.json`), 'utf8')) as Record<string, unknown>;
const ADDRESSES = { github: { folder: 'https://github.com/o/r/tree/main/pack/skills', one: 'https://github.com/o/r/blob/main/pack/skills/alpha/SKILL.md', foreign: 'https://example.com/o/r' } } as const;

function served(name: keyof typeof ADDRESSES) {
  const answers = recorded(name), asked: { url: string; auth: string | null }[] = [];
  const fake = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input), headers = (init?.headers ?? {}) as Record<string, string>;
    asked.push({ url, auth: headers.authorization ?? null });
    if (!Object.hasOwn(answers, url)) return new Response('not found: secret-token-value', { status: 404 });
    const answer = answers[url];
    return new Response(typeof answer === 'string' ? answer : JSON.stringify(answer), { status: 200 });
  }) as typeof fetch;
  return { fake, asked };
}

test('every source of skills is listed and recognizes only its own addresses', () => {
  assert.deepEqual(skillSources({ env: {} }).map(source => source.name), Object.keys(ADDRESSES));
  for (const source of skillSources({ env: {} })) assert.ok(source.title && source.matches(source.example), `${source.name} shows an example it reads`);
  for (const source of skillSources({ env: {} })) { assert.ok(source.matches(ADDRESSES[source.name as keyof typeof ADDRESSES].folder)); assert.ok(!source.matches(ADDRESSES[source.name as keyof typeof ADDRESSES].foreign)); }
});

for (const name of Object.keys(ADDRESSES) as (keyof typeof ADDRESSES)[]) {
  test(`${name}: a folder of skills comes back whole, with its license, commit and what was left out`, async () => {
    const { fake, asked } = served(name);
    const found = await readSkillCollection(ADDRESSES[name].folder, { env: { GH_TOKEN: 'secret-token-value' }, fetch: fake });
    assert.deepEqual(found.source, { repository: 'o/r', path: 'pack/skills', commit: 'a'.repeat(40), license: 'MIT', author: 'Ada Lovelace', url: ADDRESSES[name].folder });
    assert.deepEqual(found.skills.map(skill => [skill.slug, skill.description, skill.files.map(file => file.path)]), [
      ['alpha', 'Use when the first letter matters: says so, in quotes.', ['references/notes.md']],
      // A skill folder inside another is part of it, and a folded description is one line.
      ['beta', 'Use when the second letter matters.', ['playbooks/deep/SKILL.md']],
    ]);
    assert.equal(found.skills[0]!.body, '# Alpha\n\nRead [notes](references/notes.md).');
    assert.equal(found.skills[0]!.files[0]!.content, 'Notes for alpha.');
    // Too large, not text, or another tool's metadata: left out, and the large one and the one without a description are said.
    assert.deepEqual(found.skipped, ['alpha/huge.md: larger than 60 kB', 'no-description: its SKILL.md has no description or no text']);
    // Only the configured host is asked, always with the token, and nothing outside the folder.
    assert.ok(asked.every(call => call.url.startsWith('https://api.github.com/') || call.url.startsWith('https://raw.githubusercontent.com/')));
    assert.ok(asked.every(call => call.auth === 'Bearer secret-token-value'));
    assert.ok(!asked.some(call => call.url.includes('other/gamma')));
  });

  test(`${name}: one skill's own address brings that skill; a wrong address or a missing one says so without leaking`, async () => {
    const { fake } = served(name);
    assert.deepEqual((await readSkillCollection(ADDRESSES[name].one, { env: {}, fetch: fake })).skills.map(skill => skill.slug), ['alpha']);
    await assert.rejects(readSkillCollection(ADDRESSES[name].foreign, { env: {}, fetch: fake }), SkillSourceError);
    const missing = await readSkillCollection('https://github.com/o/gone/tree/main/skills', { env: { GH_TOKEN: 'secret-token-value' }, fetch: fake }).catch(error => error as Error);
    assert.ok(missing instanceof SkillSourceError && /Nothing is at that address/.test(missing.message) && !missing.message.includes('secret-token-value'));
    await assert.rejects(readSkillCollection('https://github.com/o/r/tree/main/docs', { env: {}, fetch: fake }), /no SKILL.md at or below/);
  });
}
