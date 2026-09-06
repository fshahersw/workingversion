import assert from "node:assert/strict";
import { test } from "node:test";

import {
  completeSavedWorkspace,
  selectedWorkspaceDocIds,
  withoutSavedWorkspace,
} from "./kb-binding.ts";
import type { PileSession } from "./types.ts";

function session(): PileSession {
  return {
    id: "local-1",
    createdAt: 1,
    expiresAt: 2,
    matterLabel: null,
    instructions: null,
    files: [
      { id: "local-a", name: "same.pdf", pageCount: 2, emptyPages: 0, ocrPages: 0 },
      { id: "local-b", name: "same.pdf", pageCount: 3, emptyPages: 0, ocrPages: 0 },
    ],
    pageCount: 5,
    structure: null,
    savedWorkspace: {
      itemId: "workspace-1",
      kbWorkspaceId: "11111111-1111-4111-8111-111111111111",
      surface: "workingset",
      docIdByFileId: {
        "local-a": "doc-a",
        "local-b": "doc-b",
      },
    },
  };
}

test("a complete binding maps duplicate filenames by file id", () => {
  const value = session();
  assert.ok(completeSavedWorkspace(value));
  assert.deepEqual(selectedWorkspaceDocIds(value), ["doc-a", "doc-b"]);
  assert.deepEqual(selectedWorkspaceDocIds(value, ["local-b"]), ["doc-b"]);
});

test("incomplete, duplicate, or unknown mappings fail closed", () => {
  const missing = session();
  delete missing.savedWorkspace!.docIdByFileId["local-b"];
  assert.equal(completeSavedWorkspace(missing), null);

  const missingWorkspace = session();
  missingWorkspace.savedWorkspace!.kbWorkspaceId = "";
  assert.equal(completeSavedWorkspace(missingWorkspace), null);

  const duplicate = session();
  duplicate.savedWorkspace!.docIdByFileId["local-b"] = "doc-a";
  assert.equal(completeSavedWorkspace(duplicate), null);

  const unknown = session();
  assert.equal(selectedWorkspaceDocIds(unknown, ["not-in-pile"]), null);
});

test("content mutation removes the saved workspace binding", () => {
  const local = withoutSavedWorkspace(session());
  assert.equal(local.savedWorkspace, undefined);
  assert.equal(local.files.length, 2);
});

test("reload bindings stay complete when pile ids equal Aurora doc ids", () => {
  const reloaded = session();
  reloaded.files = reloaded.files.map((file, index) => ({
    ...file,
    id: index === 0 ? "doc-a" : "doc-b",
  }));
  reloaded.savedWorkspace = {
    itemId: "workspace-1",
    kbWorkspaceId: "11111111-1111-4111-8111-111111111111",
    surface: "workingset",
    docIdByFileId: { "doc-a": "doc-a", "doc-b": "doc-b" },
  };
  assert.ok(completeSavedWorkspace(reloaded));
  assert.deepEqual(selectedWorkspaceDocIds(reloaded), ["doc-a", "doc-b"]);
});
