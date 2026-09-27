'use strict';

async function mapConcurrent(items, limit, task) {
  const results = new Array(items.length);
  const count = Math.min(items.length, Math.max(1, Math.floor(Number(limit) || 1)));
  let next = 0;
  await Promise.all(Array.from({ length: count }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index], index);
    }
  }));
  return results;
}

module.exports = { mapConcurrent };
