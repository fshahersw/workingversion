import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createAsyncIngestOrchestrator,
  type AsyncIngestDependencies,
} from "./ingest-async.server.ts";
import type { IngestJobRecord, IngestJobStore } from "./ingest-job-store.server.ts";

const ownerSub = "123e4567-e89b-42d3-a456-426614174111";
const workspaceId = "123e4567-e89b-42d3-a456-426614174222";
const docId = "123e4567-e89b-42d3-a456-426614174333";
const outputPrefix = `kb/bda-output/${ownerSub}/${docId}/`;
const invocationArn =
  "arn:aws:bedrock:us-east-1:123456789012:data-automation-invocation/service-job-1";

function fixtureJob(status: IngestJobRecord["status"] = "converting"): IngestJobRecord {
  return {
    recordType: "job",
    jobId: `kb-${"a".repeat(64)}`,
    invocationJobId: "service-job-1",
    invocationArn,
    ownerSub,
    docId,
    workspaceItemId: workspaceId,
    workspaceId,
    clientFileId: "client-file-1",
    requestFingerprint: "c".repeat(64),
    sourceSha256: "b".repeat(64),
    sourceByteSize: 1024,
    inputKey: `uploads/${ownerSub}/01SYNTHETIC/input.pdf`,
    outputPrefix,
    status,
    attempts: 0,
    createdAt: "2026-09-06T12:00:00.000Z",
    updatedAt: "2026-09-06T12:00:00.000Z",
    ttl: 1_800_000_000,
  } satisfies IngestJobRecord;
}

function harness(initial = fixtureJob()) {
  let job = { ...initial };
  const calls = {
    processed: 0,
    checkpoints: 0,
    finalized: 0,
    documentUpdates: 0,
    enqueued: [] as unknown[],
    touched: 0,
    started: 0,
    verified: 0,
  };
  const jobs: IngestJobStore = {
    reserve: async () => job,
    attachInvocation: async (_canonicalJobId, invocationJobId, attachedArn) => {
      job = {
        ...job,
        status: "converting",
        invocationJobId,
        invocationArn: attachedArn,
      };
      return job;
    },
    getByLookupId: async (lookupId) =>
      lookupId === job.invocationJobId || lookupId === job.jobId ? job : null,
    claimSuccess: async (_jobId, processingToken) => {
      if (job.status === "ready" || job.status === "error") {
        return { kind: "terminal", job };
      }
      if (job.status === "embedding") return { kind: "busy", job };
      job = {
        ...job,
        status: "embedding",
        attempts: job.attempts + 1,
        processingToken,
      };
      return { kind: "claimed", job, processingToken };
    },
    complete: async (_jobId, processingToken) => {
      if (job.processingToken !== processingToken) return false;
      job = { ...job, status: "ready", processingToken: undefined };
      return true;
    },
    fail: async (_jobId, kind, processingToken) => {
      if (job.status === "ready") return false;
      if (job.status === "embedding" && processingToken !== job.processingToken) {
        return false;
      }
      job = {
        ...job,
        status: "error",
        errorKind: kind,
        errorSummary: `bounded-${kind}`,
        processingToken: undefined,
      };
      return true;
    },
    release: async () => {
      job = { ...job, status: "converting", processingToken: undefined };
    },
    touch: async () => {
      calls.touched += 1;
    },
    listStale: async () => [job],
    delete: async () => {},
  };
  const dependencies: AsyncIngestDependencies = {
    jobs,
    bucket: "synthetic-private-bucket",
    now: () => new Date("2026-09-06T13:00:00.000Z"),
    staleAfterSeconds: 900,
    reserveDocument: async () => docId,
    getDocument: async () => ({
      doc_id: docId,
      owner_sub: ownerSub,
      workspace_id: workspaceId,
      surface: "workingset",
      file_name: "synthetic.pdf",
      mime: "application/pdf",
      sha256: "b".repeat(64),
      byte_size: 1024,
      page_count: null,
      s3_key: null,
      converter: "bda",
      status: "converting",
      bda_invocation_arn: invocationArn,
      bda_input_key: job.inputKey,
      bda_output_prefix: outputPrefix,
      bda_output_s3_uri: null,
      bda_client_file_id: "client-file-1",
    }),
    updateDocument: async () => {
      calls.documentUpdates += 1;
      return true;
    },
    startBda: async () => {
      calls.started += 1;
      return {
        invocationArn,
        outputPrefix,
      };
    },
    verifyInput: async () => {
      calls.verified += 1;
    },
    getBdaStatus: async () => ({
      status: "Success",
      outputS3Uri: `s3://synthetic-private-bucket/${outputPrefix}job/job_metadata.json`,
    }),
    readBdaResult: async () => ({
      markdown: "[page 1]\nSynthetic fixture text.",
      summary: "",
      pages: 1,
      tablesCsv: [],
    }),
    putPages: async () => `kb/pages/${ownerSub}/${docId}.json`,
    processExisting: async () => {
      calls.processed += 1;
      return { docId, pageCount: 1, chunkCount: 1 };
    },
    reserveCheckpoint: async () => {},
    checkpoint: async () => {
      calls.checkpoints += 1;
    },
    finalizeWorkspace: async () => {
      calls.finalized += 1;
    },
    enqueue: async (event) => {
      calls.enqueued.push(event);
    },
  };
  return {
    calls,
    jobs,
    dependencies,
    currentJob: () => job,
  };
}

test("duplicate EventBridge and SQS success delivery processes one document once", async () => {
  const testHarness = harness();
  const orchestrator = createAsyncIngestOrchestrator(testHarness.dependencies);
  const event = {
    version: 1 as const,
    jobId: "service-job-1",
    invocationArn,
    outcome: "success" as const,
    correlationId: "event-1",
  };
  assert.deepEqual(await orchestrator.handleCompletion(event), {
    status: "processed",
  });
  assert.deepEqual(await orchestrator.handleCompletion(event), {
    status: "duplicate",
  });
  assert.equal(testHarness.calls.processed, 1);
  assert.equal(testHarness.currentJob().status, "ready");
});

test("duplicate failure delivery stores only generic terminal state", async () => {
  const testHarness = harness();
  const orchestrator = createAsyncIngestOrchestrator(testHarness.dependencies);
  const event = {
    version: 1 as const,
    jobId: "service-job-1",
    invocationArn,
    outcome: "failure" as const,
    correlationId: "event-failure",
  };
  assert.deepEqual(await orchestrator.handleCompletion(event), {
    status: "processed",
  });
  assert.deepEqual(await orchestrator.handleCompletion(event), {
    status: "duplicate",
  });
  assert.equal(testHarness.currentJob().status, "error");
  assert.equal(testHarness.calls.documentUpdates, 2);
  assert.equal(testHarness.calls.finalized, 2);
  assert.equal(testHarness.calls.processed, 0);
});

test("terminal replay repairs owner state after the job transition committed", async () => {
  const testHarness = harness();
  let failOwnerUpdate = true;
  testHarness.dependencies.updateDocument = async () => {
    testHarness.calls.documentUpdates += 1;
    if (failOwnerUpdate) throw new Error("synthetic owner-store outage");
    return true;
  };
  const orchestrator = createAsyncIngestOrchestrator(testHarness.dependencies);
  const event = {
    version: 1 as const,
    jobId: "service-job-1",
    invocationArn,
    outcome: "failure" as const,
    correlationId: "event-terminal-repair",
  };
  await assert.rejects(() => orchestrator.handleCompletion(event));
  assert.equal(testHarness.currentJob().status, "error");
  assert.equal(testHarness.currentJob().errorKind, "conversion");
  assert.equal(testHarness.calls.finalized, 0);

  failOwnerUpdate = false;
  assert.deepEqual(await orchestrator.handleCompletion(event), {
    status: "duplicate",
  });
  assert.equal(testHarness.calls.documentUpdates, 2);
  assert.equal(testHarness.calls.finalized, 1);
});

test("stale reconciliation enqueues the same compact idempotent completion event", async () => {
  const testHarness = harness();
  const result = await createAsyncIngestOrchestrator(testHarness.dependencies).reconcileStale();
  assert.deepEqual(result, { checked: 1, enqueued: 1 });
  assert.equal(testHarness.calls.touched, 1);
  assert.equal(testHarness.calls.enqueued.length, 1);
  const queued = testHarness.calls.enqueued[0] as {
    version: number;
    invocationArn: string;
    outcome: string;
    correlationId: string;
  };
  assert.deepEqual(
    {
      version: queued.version,
      invocationArn: queued.invocationArn,
      outcome: queued.outcome,
    },
    {
      version: 1,
      invocationArn,
      outcome: "success",
    },
  );
  assert.match(queued.correlationId, /^reconcile-[0-9a-f]{32}$/);
});

test("completion rejects an ARN mismatch before owner-scoped processing", async () => {
  const testHarness = harness();
  await assert.rejects(() =>
    createAsyncIngestOrchestrator(testHarness.dependencies).handleCompletion({
      version: 1,
      jobId: "service-job-1",
      invocationArn:
        "arn:aws:bedrock:us-west-2:123456789012:data-automation-invocation/service-job-1",
      outcome: "success",
      correlationId: "event-mismatch",
    }),
  );
  assert.equal(testHarness.calls.processed, 0);
  assert.equal(testHarness.currentJob().status, "converting");
});

test("unmapped account-level BDA events are ignored without tenant work", async () => {
  const testHarness = harness();
  testHarness.dependencies.jobs.getByLookupId = async () => null;
  assert.deepEqual(
    await createAsyncIngestOrchestrator(testHarness.dependencies).handleCompletion({
      version: 1,
      jobId: "service-job-1",
      invocationArn,
      outcome: "success",
      correlationId: "event-unmapped",
    }),
    { status: "duplicate" },
  );
  assert.equal(testHarness.calls.processed, 0);
  assert.equal(testHarness.calls.documentUpdates, 0);
});

test("correlation owner must match the exact RLS-scoped Aurora document", async () => {
  const testHarness = harness();
  const getDocument = testHarness.dependencies.getDocument;
  testHarness.dependencies.getDocument = async (owner, id) => ({
    ...(await getDocument(owner, id))!,
    owner_sub: "synthetic-foreign-owner",
  });
  const result = await createAsyncIngestOrchestrator(testHarness.dependencies).handleCompletion({
    version: 1,
    jobId: "service-job-1",
    invocationArn,
    outcome: "success",
    correlationId: "event-owner-mismatch",
  });
  assert.deepEqual(result, { status: "processed" });
  assert.equal(testHarness.calls.processed, 0);
  assert.equal(testHarness.currentJob().status, "error");
});

test("stale queued reservations restart with the same deterministic job token", async () => {
  const queued = fixtureJob("queued");
  delete queued.invocationArn;
  delete queued.invocationJobId;
  const testHarness = harness(queued);
  let observedToken = "";
  testHarness.dependencies.startBda = async (_inputKey, _outputPrefix, options) => {
    testHarness.calls.started += 1;
    observedToken = options.clientToken;
    return { invocationArn, outputPrefix };
  };
  const result = await createAsyncIngestOrchestrator(testHarness.dependencies).reconcileStale();
  assert.deepEqual(result, { checked: 1, enqueued: 0 });
  assert.equal(testHarness.calls.verified, 1);
  assert.equal(testHarness.calls.started, 1);
  assert.equal(observedToken, queued.jobId);
  assert.equal(testHarness.currentJob().invocationArn, invocationArn);
  assert.equal(testHarness.currentJob().status, "converting");
});

test("queued reconciliation fails closed when the signed upload does not match", async () => {
  const queued = fixtureJob("queued");
  delete queued.invocationArn;
  delete queued.invocationJobId;
  const testHarness = harness(queued);
  testHarness.dependencies.verifyInput = async () => {
    const error = new Error("synthetic integrity mismatch");
    error.name = "ObjectIntegrityError";
    throw error;
  };
  assert.deepEqual(await createAsyncIngestOrchestrator(testHarness.dependencies).reconcileStale(), {
    checked: 1,
    enqueued: 0,
  });
  assert.equal(testHarness.calls.started, 0);
  assert.equal(testHarness.currentJob().status, "error");
});

test("retry repairs an attached invocation without starting or uploading again", async () => {
  const testHarness = harness();
  const result = await createAsyncIngestOrchestrator(testHarness.dependencies).registerAndStart({
    ownerSub,
    workspaceItemId: workspaceId,
    workspaceId,
    clientFileId: "client-file-1",
    fileName: "synthetic.pdf",
    surface: "workingset",
    mime: "application/pdf",
    requestFingerprint: "c".repeat(64),
    sha256: "b".repeat(64),
    byteSize: 1024,
    inputKey: `uploads/${ownerSub}/01SYNTHETIC/input.pdf`,
  });
  assert.deepEqual(result, { docId, status: "converting" });
  assert.equal(testHarness.calls.started, 0);
  assert.equal(testHarness.calls.documentUpdates, 2);
  assert.equal(testHarness.calls.checkpoints, 2);
});
