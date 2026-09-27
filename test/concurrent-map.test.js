'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mapConcurrent } = require('../src/concurrent-map');

test('runs at most five IPA tasks at once and preserves result order', async () => {
  let active = 0;
  let maximum = 0;
  const results = await mapConcurrent(Array.from({ length: 12 }, (_, i) => i), 5, async (value) => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 10 + (value % 3) * 5));
    active--;
    return value * 2;
  });
  assert.equal(maximum, 5);
  assert.deepEqual(results, Array.from({ length: 12 }, (_, i) => i * 2));
});
