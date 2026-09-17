import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemory, parseItem, renderItem, validateItemInput, slug } from './memory.mjs';

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'memory-'));
  const memory = createMemory({ dataDir: dir, indexPath: ':memory:' });
  t.after(() => { memory.close(); rmSync(dir, { recursive: true, force: true }); });
  return memory;
}

test('items round-trip through frontmatter and are validated', () => {
  const item = { id: 'meteor-restart', type: 'gotcha', title: 'Restart after patches', body: 'Translation patches load on restart.', scope: ['app/private/locales'], confirmed: true, status: 'active', source: 'owner', hits: 2, created: '2026-01-01T00:00:00.000Z', updated: '2026-01-02T00:00:00.000Z' };
  const parsed = parseItem(renderItem(item), 'meteor-restart');
  assert.deepEqual(parsed, item);
  assert.match(slug('Restart after patches!'), /^restart-after-patches-[a-f0-9]{6}$/, 'slugs carry a short hash so distinct titles never collide');
  for (const bad of [{ title: 'x', body: '' }, { title: 'ok', body: 'ok', type: 'rumour' }, { title: 'ok', body: 'ok', scope: ['../etc'] }, { title: 'line\nbreak', body: 'ok' }]) assert.throws(() => validateItemInput(bad));
});

test('writes commit once, search and assemble rank by scope, history supports diff and revert', t => {
  const memory = fixture(t);
  const first = memory.write('proj', [
    { id: 'use-double-quotes', title: 'Use double quotes', body: 'Strings use double quotes everywhere.', type: 'convention', scope: ['app'], confirmed: true },
    { id: 'hustle-round-timing', title: 'Hustle round timing', body: 'Rounds close on the server clock, not the client.', type: 'gotcha', scope: ['app/imports/modules/game/hustle'] },
    { id: 'old-run', title: 'Old run', body: 'Ran FUM-1.', type: 'run', scope: ['FUM-1'] },
  ], { author: { name: 'Owner', email: 'owner@example.invalid' }, message: 'Seed three items' });
  assert.equal(first.ids.length, 3);
  assert.equal(memory.log('proj')[0].subject, 'Seed three items');
  assert.equal(memory.log('proj')[0].author, 'Owner');

  const hits = memory.search('proj', 'server clock');
  assert.deepEqual(hits.map(item => item.id), ['hustle-round-timing']);
  assert.deepEqual(memory.search('proj', 'quotes', { scope: ['app/imports/modules/game/hustle'] }).map(item => item.id), ['use-double-quotes'], 'a scope prefix matches parent scopes');

  const assembled = memory.assemble('proj', ['app/imports/modules/game/hustle/logic'], 4000);
  assert.deepEqual(assembled.itemIds, ['hustle-round-timing', 'use-double-quotes'], 'closest scope first, runs excluded from injection unless nothing else matches');
  assert.match(assembled.markdown, /^# Project memory/);
  assert.equal(assembled.sha, first.sha);
  const capped = memory.assemble('proj', ['app'], 40);
  assert.deepEqual(capped.itemIds, []);
  assert.equal(memory.assemble('proj', [], 0).markdown, '');

  memory.writeFile('proj', 'charter.md', '# Charter\n\nBusiness simulations for students.', { author: { name: 'Owner' } });
  assert.match(memory.assemble('proj', [], 4000).markdown, /## Charter/);
  memory.bump('proj', ['hustle-round-timing']);
  assert.equal(memory.items('proj').find(item => item.id === 'hustle-round-timing').hits, 1);
  const retired = memory.setStatus('proj', ['old-run'], 'retired', { author: { name: 'Jeff' } });
  assert.equal(memory.search('proj', 'FUM-1').length, 0);
  assert.equal(memory.search('proj', 'FUM-1', { includeInactive: true }).length, 1);

  assert.match(memory.diff('proj', retired.sha), /-status: active[\s\S]*\+status: retired/);
  const reverted = memory.revert('proj', first.sha, { author: { name: 'Owner' } });
  assert.equal(memory.items('proj').find(item => item.id === 'old-run').status, 'active');
  assert.ok(!memory.readFile('proj', 'charter.md').includes('Business simulations'), 'revert restores the whole project tree, including the default charter');
  assert.equal(memory.head(), reverted.sha);
  assert.deepEqual(memory.projects(), ['proj']);
  assert.throws(() => memory.read('../escape'), /project/i);
  assert.throws(() => memory.readFile('proj', '../../etc/passwd'), /Invalid memory file/);
});

test('seeding turns instruction files into confirmed conventions scoped to their directory', t => {
  const memory = fixture(t);
  const seeded = memory.seed('proj', { 'CLAUDE.md': '# Notes\nKeep assessments out of docs.', '.cursor/rules/code_style.mdc': 'Use function components.' });
  assert.equal(seeded.ids.length, 2);
  const items = memory.items('proj');
  assert.ok(items.every(item => item.type === 'convention' && item.confirmed));
  assert.deepEqual(items.find(item => item.source === 'seed:.cursor/rules/code_style.mdc').scope, ['.cursor/rules']);
  assert.deepEqual(items.find(item => item.source === 'seed:CLAUDE.md').scope, ['CLAUDE.md']);
});
