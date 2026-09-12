import assert from "node:assert/strict";
import { test } from "node:test";
import { retainedWrites } from "./pending-writes.ts";

test("failed save keeps every computed cell for retry without recomputing", async () => {
  const pending = [{ id: "one", result: "computed answer" }];
  let attempts = 0;
  const acknowledged: string[] = [];
  const queue = retainedWrites(
    pending,
    async (batch) => {
      if (++attempts === 1) throw new Error("storage unavailable");
      return batch;
    },
    (saved) => acknowledged.push(...saved.map((s) => s.id)),
  );
  await assert.rejects(queue.flush(), /storage unavailable/);
  assert.equal(pending.length, 1);
  assert.equal(acknowledged.length, 0);
  await queue.flush();
  assert.equal(pending.length, 0);
  assert.deepEqual(acknowledged, ["one"]);
});
test("parallel flushes serialize and retain writes appended in flight", async () => {
  const pending = [1];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: number[][] = [];
  const queue = retainedWrites(
    pending,
    async (batch) => {
      calls.push([...batch]);
      await gate;
      return batch;
    },
    () => {},
  );
  const first = queue.flush();
  queue.add(2);
  const second = queue.flush();
  release();
  await Promise.all([first, second]);
  assert.deepEqual(calls, [[1], [2]]);
  assert.deepEqual(pending, []);
});
