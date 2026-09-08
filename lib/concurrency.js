export async function mapWithConcurrencyUntil(
  items,
  { concurrency = 1, deadlineAt = Number.POSITIVE_INFINITY } = {},
  worker
) {
  if (!Array.isArray(items)) throw new TypeError("items must be an array");
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new TypeError("concurrency must be a positive integer");
  }
  if (typeof worker !== "function") throw new TypeError("worker must be a function");

  const results = new Array(items.length);
  let nextIndex = 0;
  let completed = 0;

  async function runner() {
    while (true) {
      if (Date.now() >= deadlineAt) return;
      const index = nextIndex;
      if (index >= items.length) return;
      nextIndex += 1;
      const remainingMs = Math.max(1, deadlineAt - Date.now());
      results[index] = await worker(items[index], index, remainingMs);
      completed += 1;
    }
  }

  const runnerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: runnerCount }, () => runner()));
  return {
    results,
    completed,
    skipped: items.length - completed,
    deadline_exceeded: completed < items.length,
  };
}
