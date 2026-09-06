import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
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
  assert.equal(
    workspaceFileFingerprint(file, 0),
    workspaceFileFingerprint(reordered, 0),
  );
  assert.notEqual(
    workspaceFileFingerprint(file, 0),
    workspaceFileFingerprint({ ...file, pages: [{ page: 1, text: "Changed" }] }, 0),
  );
  assert.notEqual(
    workspaceFileFingerprint(file, 0),
    workspaceFileFingerprint(file, 1),
  );
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
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(fingerprint, /First page|motion\.pdf/);
});

test("workspace request ids must be UUIDs suitable for the Aurora workspace key", () => {
  assert.equal(isUuid("123e4567-e89b-42d3-a456-426614174000"), true);
  assert.equal(isUuid("not-a-uuid"), false);
  assert.equal(isUuid("123e4567-e89b-02d3-a456-426614174000"), false);
});

test("workspace save reserves before bounded ingest and finalizes a terminal state", () => {
  const server = readFileSync(new URL("./workspace.server.ts", import.meta.url), "utf8");
  const functions = readFileSync(
    new URL("./workspace.functions.ts", import.meta.url),
    "utf8",
  );
  assert.match(server, /putItemIfAbsent\(row\)/);
  assert.match(server, /workspace save request does not match its reservation/);
  assert.match(functions, /requestId:\s*data\.requestId/);
  assert.match(functions, /mapPool<[^>]+,\s*Outcome>\(\s*files,\s*3,/s);
  assert.match(functions, /status:\s*failed \? "error" : "ready"/);
  assert.ok(
    functions.indexOf("reserveWorkspace(sub") < functions.indexOf("ingestPages(sub"),
    "the DynamoDB reservation must be created before Aurora ingest",
  );
});

test("client retries reuse their request and bind original bytes by pile file id", () => {
  const client = readFileSync(new URL("../use-pile.ts", import.meta.url), "utf8");
  assert.match(client, /pendingWorkspaceSaveRef/);
  assert.match(client, /requestId:\s*attempt\.requestId/);
  assert.match(client, /filesByIdRef\.current\.get\(file\.id\)/);
  assert.doesNotMatch(client, /filesByNameRef/);
});
