import test from 'node:test';
import assert from 'node:assert/strict';
import { ID_PATTERN, newId } from './ids.ts';
import { boardColumn } from './enums.ts';

test('ids are UUIDv7 and sort by creation time', () => {
  const a = newId(1000), b = newId(2000);
  assert.match(a, ID_PATTERN);
  assert.ok(a < b);
});

test('task states project onto board columns', () => {
  assert.equal(boardColumn('blocked'), 'in_progress');
  assert.equal(boardColumn('merging'), 'review');
  assert.equal(boardColumn('canceled'), null);
});
