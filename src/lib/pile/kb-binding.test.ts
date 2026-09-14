// Unit tests for saved-workspace binding resolution, incl. PARTIAL binding
// (some documents ready, others still indexing/failed). Pure: no AWS, no deps.
//   node --experimental-strip-types --test src/lib/pile/kb-binding.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  completeSavedWorkspace,
  savedCoverage,
  selectedWorkspaceDocIds,
} from "./kb-binding.ts";

// Non-null PileSession shape (selectedWorkspaceDocIds requires non-null).
type LooseSession = Parameters<typeof selectedWorkspaceDocIds>[0];

function session(fileIds: string[], docIdByFileId: Record<string, string>): LooseSession {
  return {
    id: "s1",
    files: fileIds.map((id) => ({ id, name: `${id}.pdf`, pageCount: 3 })),
    savedWorkspace: {
      itemId: "ws1",
      kbWorkspaceId: "kb1",
      surface: "workingset",
      docIdByFileId,
    },
  } as unknown as LooseSession;
}

test("completeSavedWorkspace: all files ready -> binding (unchanged)", () => {
  const s = session(["a", "b"], { a: "docA", b: "docB" });
  assert.ok(completeSavedWorkspace(s));
});

test("completeSavedWorkspace: PARTIAL (one ready) -> binding", () => {
  const s = session(["a", "b"], { a: "docA" }); // b still indexing
  assert.ok(completeSavedWorkspace(s), "a set with one ready doc still binds");
});

test("completeSavedWorkspace: zero ready -> null (falls back to scan)", () => {
  const s = session(["a", "b"], {});
  assert.equal(completeSavedWorkspace(s), null);
});

test("completeSavedWorkspace: null / wrong surface / no files -> null", () => {
  assert.equal(completeSavedWorkspace(null), null);
  const wrong = session(["a"], { a: "docA" }) as { savedWorkspace: { surface: string } };
  wrong.savedWorkspace.surface = "review";
  assert.equal(completeSavedWorkspace(wrong as unknown as LooseSession), null);
});

test("completeSavedWorkspace: duplicate doc ids -> null", () => {
  const s = session(["a", "b"], { a: "dup", b: "dup" });
  assert.equal(completeSavedWorkspace(s), null);
});

test("savedCoverage: counts ready vs total", () => {
  assert.deepEqual(savedCoverage(session(["a", "b", "c"], { a: "d1", b: "d2" })), {
    ready: 2,
    total: 3,
  });
  assert.deepEqual(savedCoverage(session(["a"], { a: "d1" })), { ready: 1, total: 1 });
  assert.deepEqual(savedCoverage(session(["a", "b"], {})), { ready: 0, total: 2 });
});

test("selectedWorkspaceDocIds: all ready, no filter -> all doc ids", () => {
  const s = session(["a", "b"], { a: "docA", b: "docB" });
  assert.deepEqual(selectedWorkspaceDocIds(s), ["docA", "docB"]);
});

test("selectedWorkspaceDocIds: partial -> only the ready subset", () => {
  const s = session(["a", "b", "c"], { a: "docA", c: "docC" }); // b not ready
  assert.deepEqual(selectedWorkspaceDocIds(s), ["docA", "docC"]);
});

test("selectedWorkspaceDocIds: filter to a not-ready file -> excluded (null if none ready)", () => {
  const s = session(["a", "b"], { a: "docA" });
  assert.deepEqual(selectedWorkspaceDocIds(s, ["a"]), ["docA"]);
  assert.equal(selectedWorkspaceDocIds(s, ["b"]), null, "selecting only a not-ready file -> null");
});

test("selectedWorkspaceDocIds: unknown selected file id -> null", () => {
  const s = session(["a"], { a: "docA" });
  assert.equal(selectedWorkspaceDocIds(s, ["zzz"]), null);
});
