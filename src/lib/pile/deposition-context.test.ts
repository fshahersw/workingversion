import assert from "node:assert/strict";
import { test } from "node:test";
import {
  batchEvidence,
  depositionContext,
  DEPOSITION_CONTEXT_CHARS,
} from "./deposition-context.ts";

test("late evidence survives context construction beyond the old 2400-character cutoff", () => {
  const text = "earlier testimony ".repeat(500) + "LATE_MATERIAL_ADMISSION";
  assert.ok(
    depositionContext([{ fileName: "findings.json", page: 1, text }]).includes(
      "LATE_MATERIAL_ADMISSION",
    ),
  );
});
test("oversized context fails explicitly instead of dropping evidence", () => {
  assert.throws(
    () =>
      depositionContext([{ fileName: "x", page: 1, text: "x".repeat(DEPOSITION_CONTEXT_CHARS) }]),
    /no evidence was sent or truncated/,
  );
});
test("batches preserve every part of long testimony, including boundary text", () => {
  const lines = Array.from({ length: 3000 }, (_, i) => `Testimony on line ${i}: admission ${i}.`);
  const batches = batchEvidence([{ fileName: "a.txt", page: 3, text: lines.join("\n") }]);
  assert.ok(batches.length > 1);
  for (const line of lines)
    assert.ok(
      batches.flat().some((p) => p.text.includes(line)),
      line,
    );
  for (const batch of batches) assert.doesNotThrow(() => depositionContext(batch));
});
