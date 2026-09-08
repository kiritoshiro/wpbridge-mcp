import test from "node:test";
import assert from "node:assert/strict";
import { mapWithConcurrencyUntil } from "../lib/concurrency.js";

test("bounded mapper never exceeds configured concurrency", async () => {
  let active = 0;
  let maxActive = 0;
  const result = await mapWithConcurrencyUntil(
    [1, 2, 3, 4, 5, 6],
    { concurrency: 2, deadlineAt: Date.now() + 1000 },
    async (value) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return value * 2;
    }
  );
  assert.equal(maxActive, 2);
  assert.equal(result.completed, 6);
  assert.deepEqual(result.results, [2, 4, 6, 8, 10, 12]);
});

test("bounded mapper stops launching new work after its deadline", async () => {
  const result = await mapWithConcurrencyUntil(
    [1, 2, 3, 4, 5],
    { concurrency: 1, deadlineAt: Date.now() + 18 },
    async (value) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return value;
    }
  );
  assert.equal(result.deadline_exceeded, true);
  assert.ok(result.completed >= 1 && result.completed < 5);
  assert.equal(result.skipped, 5 - result.completed);
});
