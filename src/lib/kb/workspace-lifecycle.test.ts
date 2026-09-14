import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  aggregateWorkspaceCheckpoints,
  isUuid,
  workspaceFileFingerprint,
  workspaceSaveFingerprint,
  type WorkspaceFingerprintFile,
} from "./workspace-lifecycle.ts";

const file: WorkspaceFingerprintFile = {
  fileName: "motion.pdf",
  mime: "application/pdf",
  byteSize: 1234,
  pages: [
    { page: 2, text: "Second page" },
    { page: 1, text: "First page" },
  ],
};

test("workspace file fingerprints are deterministic and page-order independent", () => {
  const reordered = { ...file, pages: [...file.pages].reverse() };
  assert.equal(workspaceFileFingerprint(file, 0), workspaceFileFingerprint(reordered, 0));
  assert.notEqual(
    workspaceFileFingerprint(file, 0),
    workspaceFileFingerprint({ ...file, pages: [{ page: 1, text: "Changed" }] }, 0),
  );
  assert.notEqual(workspaceFileFingerprint(file, 0), workspaceFileFingerprint(file, 1));
});

test("workspace request fingerprints bind name, folder, surface, order, and content", () => {
  const base = {
    name: "Daubert set",
    surface: "workingset",
    folderId: "ROOT",
    files: [file],
  };
  const fingerprint = workspaceSaveFingerprint(base).requestFingerprint;
  assert.equal(workspaceSaveFingerprint(base).requestFingerprint, fingerprint);
  assert.notEqual(
    workspaceSaveFingerprint({ ...base, name: "Other set" }).requestFingerprint,
    fingerprint,
  );
  assert.notEqual(
    workspaceSaveFingerprint({ ...base, folderId: "MOTIONS" }).requestFingerprint,
    fingerprint,
  );
  assert.notEqual(
    workspaceSaveFingerprint({
      ...base,
      files: [{ ...file, clientFileId: "pile-file-1" }],
    }).requestFingerprint,
    fingerprint,
  );
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(fingerprint, /First page|motion\.pdf/);
});

test("workspace request ids must be UUIDs suitable for the Aurora workspace key", () => {
  assert.equal(isUuid("123e4567-e89b-42d3-a456-426614174000"), true);
  assert.equal(isUuid("not-a-uuid"), false);
  assert.equal(isUuid("123e4567-e89b-02d3-a456-426614174000"), false);
});

test("checkpoint aggregation keeps pending work saving and makes failures terminal", () => {
  assert.deepEqual(aggregateWorkspaceCheckpoints(2, [{ clientFileId: "a", status: "ready" }]), {
    status: "saving",
    pendingCount: 1,
    readyCount: 1,
    failedCount: 0,
  });
  assert.deepEqual(
    aggregateWorkspaceCheckpoints(2, [
      { clientFileId: "a", status: "ready" },
      { clientFileId: "b", status: "embedding" },
    ]),
    {
      status: "saving",
      pendingCount: 1,
      readyCount: 1,
      failedCount: 0,
    },
  );
  assert.equal(
    aggregateWorkspaceCheckpoints(2, [
      { clientFileId: "a", status: "ready" },
      { clientFileId: "b", status: "ready" },
    ]).status,
    "ready",
  );
  assert.equal(
    aggregateWorkspaceCheckpoints(2, [
      { clientFileId: "a", status: "error" },
      { clientFileId: "b", status: "converting" },
    ]).status,
    "error",
  );
});

test("workspace save reserves per-document checkpoints before bounded ingest", () => {
  const server = readFileSync(new URL("./workspace.server.ts", import.meta.url), "utf8");
  const functions = readFileSync(new URL("./workspace.functions.ts", import.meta.url), "utf8");
  assert.match(server, /putItemIfAbsent\(row\)/);
  assert.match(server, /workspace save request does not match its reservation/);
  assert.match(server, /WSDOC#/);
  assert.match(server, /finalizeWorkspaceFromCheckpoints/);
  assert.match(server, /documentProgress:\s*checkpoints\.map\(toDocumentProgress\)/);
  assert.match(server, /getWorkspaceIngestReservation/);
  assert.match(server, /checkpointRevision/);
  assert.match(server, /workspaceRevision/);
  assert.match(server, /decision === "reject"/);
  assert.match(server, /attribute_not_exists\(workspaceRevision\)/);
  assert.match(functions, /requestId:\s*data\.requestId/);
  assert.match(functions, /mapPool\(\s*prepared,\s*3,/s);
  assert.match(functions, /registerAsyncIngest/);
  assert.match(functions, /finalizeWorkspaceFromCheckpoints/);
  assert.ok(
    functions.indexOf("reserveWorkspace(sub") < functions.indexOf("reserveWorkspaceDocument(sub") &&
      functions.indexOf("reserveWorkspaceDocument(sub") < functions.indexOf("ingestPages(sub"),
    "the DynamoDB reservation must be created before Aurora ingest",
  );
});

test("client retries reuse their request and bind original bytes by pile file id", () => {
  const client = readFileSync(new URL("../use-pile.ts", import.meta.url), "utf8");
  assert.match(client, /pendingWorkspaceSaveRef/);
  assert.match(client, /requestId:\s*attempt\.requestId/);
  assert.match(client, /filesByIdRef\.current\.get\(file\.id\)/);
  assert.match(client, /rawFileSha256/);
  assert.match(client, /getWorkspaceStatusFn/);
  assert.match(client, /contentRevisionRef\.current === snapshotRevision/);
  assert.match(client, /revision:\s*snapshotRevision/);
  assert.match(client, /uploadByFileId/);
  assert.match(client, /abortableDelay\(poll < 4 \? 1_000 : 5_000, controller\.signal\)/);
  assert.match(client, /saveAbort\.current\?\.abort\(\)/);
  assert.doesNotMatch(client, /filesByNameRef/);
  assert.match(client, /file\.emptyPages > 0 \|\| fp\.some/);
});

test("workspace deletion removes exact job mappings before owned artifacts, including pending saves", () => {
  const server = readFileSync(new URL("./workspace.server.ts", import.meta.url), "utf8");
  const deleteStart = server.indexOf("export async function deleteWorkspace(");
  const deleteSource = server.slice(deleteStart);
  assert.ok(deleteStart >= 0);
  assert.doesNotMatch(deleteSource, /Workspace ingest must finish before deletion/);
  assert.ok(
    deleteSource.indexOf("jobs.delete(jobId)") <
      deleteSource.indexOf("deleteWorkspaceDocuments(principal"),
  );
  assert.ok(
    deleteSource.indexOf("deleteWorkspaceDocuments(principal") <
      deleteSource.indexOf("deletePrefix(key)"),
  );
});
