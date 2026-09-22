import test from 'node:test';
import assert from 'node:assert/strict';
import { clamp } from './numbers.js';

test('clamp keeps a value inside its range', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(11, 0, 10), 10);
});
