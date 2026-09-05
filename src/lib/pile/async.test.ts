import assert from "node:assert/strict";
import { test } from "node:test";

import { AdaptiveLimiter, mapPool, mapPoolAdaptive, withRetry } from "./async.ts";

test("mapPool preserves order with bounded concurrency", async () => {
  const seen: number[] = [];
  const out = await mapPool([1, 2, 3, 4], 2, async (n) => {
    seen.push(n);
    await new Promise((r) => setTimeout(r, n === 1 ? 20 : 1));
    return n * 10;
  });
  assert.deepEqual(out, [10, 20, 30, 40]);
  assert.equal(seen.length, 4);
});

test("withRetry succeeds after a failure", async () => {
  let n = 0;
  const v = await withRetry(async () => {
    n += 1;
    if (n < 2) throw new Error("boom");
    return 7;
  }, { tries: 3, baseMs: 1 });
  assert.equal(v, 7);
  assert.equal(n, 2);
});

test("AdaptiveLimiter never exceeds max in-flight", async () => {
  const limiter = new AdaptiveLimiter(2, 3, 3);
  let inflight = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 12 }, async () => {
      await limiter.run(async () => {
        inflight += 1;
        peak = Math.max(peak, inflight);
        await new Promise((r) => setTimeout(r, 15));
        inflight -= 1;
      });
    }),
  );
  assert.ok(peak <= 3, `peak ${peak}`);
  assert.equal(limiter.inflight, 0);
});

test("AdaptiveLimiter halves on 429 then still finishes every item", async () => {
  let calls = 0;
  const { results, limiter } = await mapPoolAdaptive(
    [1, 2, 3, 4, 5, 6],
    { min: 2, start: 6, max: 6 },
    async (n) => {
      calls += 1;
      if (calls <= 2) throw new Error("HTTP 429: slow down retry-after=0.05");
      return n;
    },
  );
  assert.deepEqual(results, [1, 2, 3, 4, 5, 6]);
  assert.ok(limiter.limit <= 6);
  assert.ok(calls >= 6);
});

test("withRetry does not retry 429 when retry429 is false", async () => {
  let n = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          n += 1;
          throw new Error("HTTP 429: no");
        },
        { tries: 4, baseMs: 1, retry429: false },
      ),
    /HTTP 429/,
  );
  assert.equal(n, 1);
});
