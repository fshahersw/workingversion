import assert from "node:assert/strict";
import { test } from "node:test";

import { KbAskError, selectWorkspaceDocuments } from "./ask-selection.ts";
import type { WorkspaceDetailWithProgress, WorkspaceDoc } from "./workspace.server.ts";

function doc(docId: string, fileName: string): WorkspaceDoc {
  return {
    docId,
    fileName,
    pageCount: 2,
    chunkCount: 3,
    pagesKey: `kb/pages/user/${docId}.json`,
  };
}

function workspace(docs: WorkspaceDoc[]): WorkspaceDetailWithProgress {
  return {
    itemId: "workspace-1",
    name: "Daubert set",
    surface: "workingset",
    folderId: "ROOT",
    createdAt: "2026-09-06T00:00:00.000Z",
    docCount: docs.length,
    pageCount: docs.reduce((total, item) => total + item.pageCount, 0),
    status: "ready",
    pendingCount: 0,
    kbWorkspaceId: "11111111-1111-4111-8111-111111111111",
    docs,
    documentProgress: docs.map((item) => ({
      clientFileId: item.sourceFileId ?? item.docId,
      fileName: item.fileName,
      status: "ready",
      docId: item.docId,
      pageCount: item.pageCount,
      chunkCount: item.chunkCount,
    })),
  };
}

test("selectWorkspaceDocuments defaults to the full saved manifest", () => {
  const docs = [doc("a", "one.pdf"), doc("b", "two.pdf")];
  assert.deepEqual(selectWorkspaceDocuments(workspace(docs)), docs);
});

test("selectWorkspaceDocuments keeps requested order and drops duplicates", () => {
  const docs = [doc("a", "one.pdf"), doc("b", "two.pdf"), doc("c", "three.pdf")];
  assert.deepEqual(selectWorkspaceDocuments(workspace(docs), ["c", "a", "c"]), [docs[2], docs[0]]);
});

test("selectWorkspaceDocuments rejects empty or foreign document selections", () => {
  const saved = workspace([doc("a", "one.pdf")]);
  assert.throws(() => selectWorkspaceDocuments(saved, []), KbAskError);
  assert.throws(
    () => selectWorkspaceDocuments(saved, ["missing"]),
    (error: unknown) => {
      assert.ok(error instanceof KbAskError);
      assert.equal(error.status, 403);
      return true;
    },
  );
});
