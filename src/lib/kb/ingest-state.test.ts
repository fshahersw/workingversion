import assert from "node:assert/strict";
import { test } from "node:test";

import {
  decideIngestTransition,
  isIngestStatus,
  isTerminalErrorKind,
  isTerminalIngestStatus,
  selectIngestLane,
  terminalErrorSummary,
  type IngestStatus,
} from "./ingest-state.ts";

const statuses: IngestStatus[] = ["queued", "converting", "embedding", "ready", "error"];

test("ingest transition matrix is forward-only and duplicate-safe", () => {
  const allowed = new Set([
    "queued:converting",
    "queued:embedding",
    "queued:error",
    "converting:embedding",
    "converting:error",
    "embedding:ready",
    "embedding:error",
  ]);
  for (const current of statuses) {
    for (const target of statuses) {
      const decision = decideIngestTransition(current, target);
      if (current === target) {
        assert.equal(decision, "noop", `${current} duplicate`);
      } else {
        assert.equal(
          decision,
          allowed.has(`${current}:${target}`) ? "apply" : "reject",
          `${current} -> ${target}`,
        );
      }
    }
  }
  assert.equal(isTerminalIngestStatus("ready"), true);
  assert.equal(isTerminalIngestStatus("error"), true);
  assert.equal(isTerminalIngestStatus("embedding"), false);
  assert.equal(isIngestStatus("converting"), true);
  assert.equal(isIngestStatus("complete"), false);
});

test("lane selection preserves ordinary sync files and requires owned bytes for async", () => {
  assert.deepEqual(selectIngestLane({ readablePages: 2, totalChars: 100 }), { lane: "sync" });
  assert.deepEqual(
    selectIngestLane({
      readablePages: 0,
      totalChars: 0,
      bytesKey: "uploads/principal/object",
      sha256: "a".repeat(64),
    }),
    { lane: "async" },
  );
  assert.deepEqual(selectIngestLane({ readablePages: 0, totalChars: 0 }), {
    lane: "reject",
    reason: "async-input-required",
  });
});

test("terminal summaries are generic, bounded, and contain no raw error input", () => {
  for (const kind of ["conversion", "processing", "limits", "configuration", "unknown"] as const) {
    assert.equal(isTerminalErrorKind(kind), true);
    const summary = terminalErrorSummary(kind);
    assert.ok(summary.length <= 80);
    assert.doesNotMatch(summary, /arn:|uploads\/|exception|stack/i);
  }
  assert.equal(isTerminalErrorKind("AccessDeniedException"), false);
});
