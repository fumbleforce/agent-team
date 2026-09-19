import test from 'node:test';
import assert from 'node:assert/strict';
import { effective, join, meet, NO_PERMISSIONS, outsideWriteScope, PermissionGrant } from './permissions.ts';

const grant = (input: Partial<PermissionGrant>) => PermissionGrant.parse(input);
const qa = grant({ codeWrite: { paths: ['tests'] }, shell: 'restricted', browser: 'allowed', issues: 'edit', spendDailyCapMinor: 1000 });
const dev = grant({ codeWrite: { paths: ['src', 'tests/unit'] }, shell: 'full', issues: 'comment', secrets: ['STRIPE_TEST'], spendDailyCapMinor: 500 });

test('roles stack: the union of what they allow', () => {
  const both = join([qa, dev]);
  assert.deepEqual(both.codeWrite, { paths: ['src', 'tests', 'tests/unit'] });
  assert.deepEqual([both.shell, both.browser, both.issues, both.spendDailyCapMinor, both.secrets], ['full', 'allowed', 'edit', 1000, ['STRIPE_TEST']]);
  assert.deepEqual(join([]), NO_PERMISSIONS);
});

test('a ceiling caps every key and never widens anything', () => {
  const ceiling = grant({ codeWrite: { paths: ['src/ui', 'tests'] }, shell: 'restricted', issues: 'comment', spendDailyCapMinor: 800 });
  const capped = meet(join([qa, dev]), ceiling);
  assert.deepEqual(capped.codeWrite, { paths: ['src/ui', 'tests', 'tests/unit'] });
  assert.deepEqual([capped.shell, capped.browser, capped.issues, capped.deploy, capped.spendDailyCapMinor, capped.secrets], ['restricted', 'none', 'comment', 'none', 800, []]);
  assert.deepEqual(meet(capped, NO_PERMISSIONS), { ...NO_PERMISSIONS });
  // Applying the committed ceiling again, as the worker does, changes nothing.
  assert.deepEqual(effective([qa, dev], ceiling, ceiling), capped);
});

test('the diff gate names every changed path outside the write scope', () => {
  assert.deepEqual(outsideWriteScope(qa, ['tests/e2e/pay.spec.ts', 'src/pay.ts', 'testsuite.md']), ['src/pay.ts', 'testsuite.md']);
  assert.deepEqual(outsideWriteScope(grant({ codeWrite: 'all' }), ['anything']), []);
  assert.deepEqual(outsideWriteScope(NO_PERMISSIONS, ['a']), ['a']);
});
