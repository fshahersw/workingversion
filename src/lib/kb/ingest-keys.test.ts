import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bdaOutputPrefix,
  deterministicBdaClientToken,
  invocationJobId,
  requireClientFileId,
  requireOwnedBdaResultUri,
  requireOwnedUploadKey,
} from "./ingest-keys.ts";

const principal = "123e4567-e89b-42d3-a456-426614174111";
const workspaceId = "123e4567-e89b-42d3-a456-426614174222";
const docId = "123e4567-e89b-42d3-a456-426614174333";

test("BDA client token is deterministic, opaque, and input-sensitive", () => {
  const input = {
    principal,
    workspaceItemId: workspaceId,
    workspaceId,
    clientFileId: "pile-1",
    sha256: "a".repeat(64),
  };
  const token = deterministicBdaClientToken(input);
  assert.equal(deterministicBdaClientToken(input), token);
  assert.notEqual(deterministicBdaClientToken({ ...input, clientFileId: "pile-2" }), token);
  assert.match(token, /^kb-[0-9a-f]{64}$/);
  assert.doesNotMatch(token, new RegExp(principal));
});

test("tenant input and output keys are accepted only in exact owned prefixes", () => {
  assert.equal(
    requireOwnedUploadKey(principal, `uploads/${principal}/01ABC/file.pdf`),
    `uploads/${principal}/01ABC/file.pdf`,
  );
  assert.throws(() => requireOwnedUploadKey(principal, "uploads/another-owner/01ABC/file.pdf"));
  assert.throws(() => requireOwnedUploadKey(principal, `uploads/${principal}/01ABC/../other.pdf`));

  const prefix = bdaOutputPrefix(principal, docId);
  assert.equal(prefix, `kb/bda-output/${principal}/${docId}/`);
  assert.equal(
    requireOwnedBdaResultUri({
      uri: `s3://private-bucket/${prefix}job/job_metadata.json`,
      bucket: "private-bucket",
      principal,
      docId,
      outputPrefix: prefix,
    }),
    `${prefix}job/job_metadata.json`,
  );
  assert.throws(() =>
    requireOwnedBdaResultUri({
      uri: `s3://other-bucket/${prefix}job/job_metadata.json`,
      bucket: "private-bucket",
      principal,
      docId,
      outputPrefix: prefix,
    }),
  );
});

test("invocation ARN parsing returns only the exact service job lookup id", () => {
  assert.equal(
    invocationJobId("arn:aws:bedrock:us-east-1:123456789012:data-automation-invocation/job-123"),
    "job-123",
  );
  assert.throws(() =>
    invocationJobId("arn:aws:bedrock:us-east-1:123456789012:data-automation-project/job-123"),
  );
  assert.throws(() =>
    invocationJobId(
      "arn:client-selected:bedrock:us-east-1:123456789012:data-automation-invocation/job-123",
    ),
  );
});

test("client file identifiers are bounded correlation values, not arbitrary key material", () => {
  assert.equal(requireClientFileId("pile-file_1:page.2"), "pile-file_1:page.2");
  assert.throws(() => requireClientFileId("../foreign"));
  assert.throws(() => requireClientFileId("contains space"));
  assert.throws(() => requireClientFileId("a".repeat(257)));
});
