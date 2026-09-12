import { test } from "node:test";
import assert from "node:assert/strict";
import { mapConcurrent } from "../../writer/packages/agent-core/src/parallel.ts";
test("Office parallel reads are bounded and retain tool-call result order", async () => {
  let active = 0,
    peak = 0;
  const values = Array.from({ length: 20 }, (_, i) => i);
  const result = await mapConcurrent(
    values,
    async (i) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 20 - i));
      active--;
      return i * 2;
    },
    4,
  );
  assert.equal(peak, 4);
  assert.deepEqual(
    result,
    values.map((i) => i * 2),
  );
});
