import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { kbIngestAction } from "./ingest-route.ts";

test("action-less KB ingest bodies remain on the synchronous compatibility path", () => {
  assert.equal(
    kbIngestAction({
      workspaceId: "workspace",
      surface: "workingset",
      fileName: "fixture.pdf",
      pages: [{ page: 1, text: "synthetic text" }],
    }),
    "sync",
  );
  assert.equal(kbIngestAction({ action: "sync" }), "sync");
  assert.equal(kbIngestAction({ action: "prepare" }), "prepare");
  assert.equal(kbIngestAction({ action: "status-batch" }), "status-batch");
  assert.throws(() => kbIngestAction({ action: "unknown" }));
});

test("async route responses never return a BDA invocation ARN", () => {
  const route = readFileSync(new URL("../../routes/api/kb/ingest.ts", import.meta.url), "utf8");
  assert.match(route, /action === "start"/);
  assert.match(route, /registerAsyncIngest/);
  assert.match(route, /getWorkspaceIngestReservation\(user\.sub, workspaceItemId\)/);
  assert.match(route, /requireOwnedUploadKey\(user\.sub, inputKey\)/);
  assert.match(route, /uploadObjectName\.includes\("\/"\)/);
  assert.match(route, /requestFingerprint:\s*workspace\.requestFingerprint/);
  assert.match(route, /action === "status-batch"/);
  assert.doesNotMatch(route, /ownerSub\s*=\s*(body|data)|body\.owner|body\.sub/);
  assert.doesNotMatch(route, /console\.(?:log|warn|error)/);
  assert.doesNotMatch(route, /Response\.json\(\{[^}]*invocationArn/s);
});

test("async uploads bind the declared SHA-256 and size to the S3 object", () => {
  const route = readFileSync(new URL("../../routes/api/kb/ingest.ts", import.meta.url), "utf8");
  const storage = readFileSync(new URL("../data/s3.server.ts", import.meta.url), "utf8");
  const library = readFileSync(new URL("../library/library.server.ts", import.meta.url), "utf8");
  const client = readFileSync(new URL("../use-pile.ts", import.meta.url), "utf8");
  const orchestrator = readFileSync(new URL("./ingest-async.server.ts", import.meta.url), "utf8");
  assert.match(route, /sha256,\s*\n\s*\}\);/);
  assert.match(library, /ChecksumSHA256|x-amz-checksum-sha256/);
  assert.match(storage, /new HeadObjectCommand/);
  assert.match(storage, /ChecksumMode: "ENABLED"/);
  assert.match(storage, /result\.ContentLength !== expectedSize/);
  assert.match(client, /headers: up\.uploadHeaders/);
  assert.match(orchestrator, /dependencies\.verifyInput/);
});
