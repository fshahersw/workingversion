import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { kbAsyncIngestConfigured, loadKbAsyncIngestConfig } from "../config.server.ts";
import { createIngestJobStore } from "./ingest-job-store.server.ts";
import { deterministicBdaClientToken } from "./ingest-keys.ts";

const source = readFileSync(new URL("./ingest-job-store.server.ts", import.meta.url), "utf8");

test("async ingest config is optional locally and strict in production", () => {
  assert.equal(kbAsyncIngestConfigured({ NODE_ENV: "test" }), false);
  assert.throws(() => loadKbAsyncIngestConfig({ NODE_ENV: "production" }), /KB_INGEST_JOBS_TABLE/);
  const config = loadKbAsyncIngestConfig({
    NODE_ENV: "production",
    AWS_REGION: "us-east-1",
    KB_INGEST_JOBS_TABLE: "synthetic-jobs",
    KB_INGEST_QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/000000000000/synthetic",
  });
  assert.equal(config.jobsTable, "synthetic-jobs");
  assert.equal(config.staleAfterSeconds, 900);
  assert.throws(() =>
    loadKbAsyncIngestConfig({
      NODE_ENV: "test",
      KB_INGEST_JOBS_TABLE: "invalid/table",
    }),
  );
  assert.throws(() =>
    loadKbAsyncIngestConfig({
      NODE_ENV: "test",
      KB_INGEST_JOB_TTL_DAYS: "999",
    }),
  );
});

test("job store uses exact keys, conditional mutation, and StatusUpdated reconciliation", () => {
  assert.match(source, /ConditionExpression: "attribute_not_exists\(jobId\)"/);
  assert.match(source, /new TransactWriteCommand/);
  assert.match(source, /canonicalJobId = :canonical/);
  assert.match(source, /processingToken = :token/);
  assert.match(source, /#status = :embedding AND leaseUntil < :epoch/);
  assert.match(source, /IndexName: "StatusUpdated"/);
  assert.match(source, /ConsistentRead: true/);
  assert.doesNotMatch(source, /ScanCommand|ownerSub-index|invocationArn-index/);
});

test("job reservations persist only bounded correlation metadata", async () => {
  const sent: unknown[] = [];
  const client = {
    send: async (command: unknown) => {
      sent.push(command);
      return {};
    },
  };
  const owner = "123e4567-e89b-42d3-a456-426614174111";
  const docId = "123e4567-e89b-42d3-a456-426614174333";
  const workspaceId = "123e4567-e89b-42d3-a456-426614174222";
  const sourceSha256 = "c".repeat(64);
  const jobId = deterministicBdaClientToken({
    principal: owner,
    workspaceItemId: workspaceId,
    workspaceId,
    clientFileId: "client-file-1",
    sha256: sourceSha256,
  });
  const store = createIngestJobStore({
    client: client as never,
    config: {
      region: "us-east-1",
      jobsTable: "synthetic-jobs",
      queueUrl: "https://sqs.us-east-1.amazonaws.com/000000000000/synthetic",
      staleAfterSeconds: 900,
      jobTtlDays: 30,
    },
    now: () => new Date("2026-09-06T12:00:00.000Z"),
  });
  const record = await store.reserve({
    jobId,
    ownerSub: owner,
    docId,
    workspaceItemId: workspaceId,
    workspaceId,
    clientFileId: "client-file-1",
    requestFingerprint: "b".repeat(64),
    sourceSha256,
    sourceByteSize: 1024,
    inputKey: `uploads/${owner}/01SYNTHETIC/input.pdf`,
    outputPrefix: `kb/bda-output/${owner}/${docId}/`,
  });
  assert.equal(record.status, "queued");
  assert.equal(record.requestFingerprint, "b".repeat(64));
  assert.equal(record.sourceByteSize, 1024);
  assert.ok(record.ttl > 0);
  const item = (sent[0] as { input?: { Item?: Record<string, unknown> } }).input?.Item;
  assert.equal(item?.["recordType"], "job");
  assert.equal(item?.["fileName"], undefined);
  assert.equal(item?.["documentText"], undefined);
});

test("job reservations reject cross-owner keys and mismatched invocation aliases locally", async () => {
  const client = { send: async () => ({}) };
  const owner = "123e4567-e89b-42d3-a456-426614174111";
  const docId = "123e4567-e89b-42d3-a456-426614174333";
  const workspaceId = "123e4567-e89b-42d3-a456-426614174222";
  const sourceSha256 = "c".repeat(64);
  const jobId = deterministicBdaClientToken({
    principal: owner,
    workspaceItemId: workspaceId,
    workspaceId,
    clientFileId: "client-file-1",
    sha256: sourceSha256,
  });
  const store = createIngestJobStore({
    client: client as never,
    config: {
      region: "us-east-1",
      jobsTable: "synthetic-jobs",
      queueUrl: "https://sqs.us-east-1.amazonaws.com/000000000000/synthetic",
      staleAfterSeconds: 900,
      jobTtlDays: 30,
    },
  });
  await assert.rejects(() =>
    store.reserve({
      jobId,
      ownerSub: owner,
      docId,
      workspaceItemId: workspaceId,
      workspaceId,
      clientFileId: "client-file-1",
      requestFingerprint: "b".repeat(64),
      sourceSha256,
      sourceByteSize: 1024,
      inputKey: "uploads/synthetic-foreign-owner/input.pdf",
      outputPrefix: `kb/bda-output/${owner}/${docId}/`,
    }),
  );
  await assert.rejects(() =>
    store.attachInvocation(
      `kb-${"a".repeat(64)}`,
      "different-job",
      "arn:aws:bedrock:us-east-1:123456789012:data-automation-invocation/service-job",
    ),
  );
});
