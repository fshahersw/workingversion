import assert from "node:assert/strict";
import { validateSaveByteSize } from "./ingest-state.ts";
import { test } from "node:test";

import {
  decideIngestTransition,
  isIngestStatus,
  isTerminalErrorKind,
  isTerminalIngestStatus,
  planSaveLane,
  selectIngestLane,
  SYNC_INGEST_MAX_PAGES,
  terminalErrorSummary,
  type IngestStatus,
} from "./ingest-state.ts";

test("save lane plan never produces a request the server would reject", () => {
  // A blank cover page must not force a bytes-only lane when bytes are missing.
  assert.equal(
    planSaveLane({ readablePages: 40, totalChars: 90_000, lowQuality: true, hasBytes: false }),
    "sync-degraded",
  );
  assert.equal(
    planSaveLane({ readablePages: 40, totalChars: 90_000, lowQuality: true, hasBytes: true }),
    "async",
  );
  assert.equal(
    planSaveLane({ readablePages: 40, totalChars: 90_000, lowQuality: false, hasBytes: false }),
    "sync",
  );
  // No text and no bytes: nothing can be indexed, so the document is left out.
  assert.equal(
    planSaveLane({ readablePages: 0, totalChars: 0, lowQuality: true, hasBytes: false }),
    "skip",
  );
  assert.equal(
    planSaveLane({ readablePages: 0, totalChars: 0, lowQuality: true, hasBytes: true }),
    "async",
  );
  // Over the synchronous limit behaves like "no text": async or skip.
  assert.equal(
    planSaveLane({
      readablePages: SYNC_INGEST_MAX_PAGES + 1,
      totalChars: 10,
      lowQuality: false,
      hasBytes: false,
    }),
    "skip",
  );
  // Every non-skip plan is accepted by the server-side lane check.
  assert.equal(selectIngestLane({ readablePages: 40, totalChars: 90_000 }).lane, "sync");
  assert.equal(
    selectIngestLane({ readablePages: 0, totalChars: 0, bytesKey: "k", sha256: "a".repeat(64) })
      .lane,
    "async",
  );
});

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
test("large searchable source can be preserved without inheriting the conversion size limit", () => {
  assert.doesNotThrow(() => validateSaveByteSize(64 * 1024 * 1024, "sync"));
  assert.throws(() => validateSaveByteSize(64 * 1024 * 1024, "async"), /background conversion/);
  assert.throws(() => validateSaveByteSize(201 * 1024 * 1024, "sync"), /200 MiB/);
  assert.throws(() => validateSaveByteSize(-1, "sync"));
});
