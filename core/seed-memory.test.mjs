import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectSeedFiles, parseArgs, seedMemory } from './seed-memory.mjs';

function checkout(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'seed-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'rules'));
  mkdirSync(path.join(dir, 'docs'));
  writeFileSync(path.join(dir, 'NOTES.md'), '# Notes\nKeep it simple.');
  writeFileSync(path.join(dir, 'rules', 'style.mdc'), 'Double quotes.');
  writeFileSync(path.join(dir, 'rules', 'ignored.js'), 'not a rule');
  writeFileSync(path.join(dir, 'docs', 'charter.md'), '   ');
  writeFileSync(path.join(dir, '.agent-team.json'), JSON.stringify({ version: 2, name: 'Seeded', queueProjectId: 'seeded', instructions: ['NOTES.md', 'missing.md'], charter: 'docs/charter.md' }));
  return dir;
}

test('arguments require an absolute project path and accept includes', () => {
  assert.deepEqual(parseArgs(['--project', '/repo', '--include', 'rules', '--dry-run']), { project: '/repo', include: ['rules'], dryRun: true });
  for (const bad of [[], ['--project', 'relative'], ['--project', '/repo', '--bogus']]) assert.throws(() => parseArgs(bad), /Usage/);
});

test('instruction files, directories of rules and the charter are collected; blanks, other extensions and escapes are not', t => {
  const dir = checkout(t);
  const files = collectSeedFiles(dir, JSON.parse(readFileSync(path.join(dir, '.agent-team.json'), 'utf8')), ['rules']);
  assert.deepEqual(Object.keys(files).sort(), ['NOTES.md', 'rules/style.mdc']);
  assert.throws(() => collectSeedFiles(dir, { instructions: ['../outside.md'] }), /outside the checkout/);
});

test('seeding initializes the project memory and posts every file as the owner; dry runs post nothing', async t => {
  const dir = checkout(t);
  const calls = [];
  const logs = [];
  const fetchImpl = async (url, init) => { calls.push({ path: url.pathname, body: JSON.parse(init.body) }); return { ok: true, json: async () => url.pathname.endsWith('/init') ? { sha: 'a'.repeat(40) } : { sha: 'b'.repeat(40), ids: ['notes-md-8'] } }; };
  const dry = await seedMemory({ project: dir, dryRun: true, token: 'synthetic-token-long-enough-here', log: line => logs.push(line) });
  assert.deepEqual(dry, { projectId: 'seeded', files: ['NOTES.md'], sha: null });
  assert.equal(calls.length, 0);
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const result = await seedMemory({ project: dir, coordinator: 'http://127.0.0.1:4310', token: 'synthetic-token-long-enough-here', log: line => logs.push(line) });
    assert.equal(result.sha, 'b'.repeat(40));
  } finally { globalThis.fetch = original; }
  assert.deepEqual(calls.map(call => call.path), ['/projects/seeded/memory/init', '/projects/seeded/memory/seed']);
  assert.deepEqual(calls[1].body, { files: { 'NOTES.md': '# Notes\nKeep it simple.' }, author: { name: 'Owner' } });
  assert.ok(logs.at(-1).startsWith('Seeded 1 item for seeded'));
});
