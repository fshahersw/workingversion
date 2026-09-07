import assert from "node:assert/strict";
import { test } from "node:test";

import { createSqsBatchHandler } from "../../../infra/lambda/kb-ingest/handler-core.ts";
import { parseIngestCompletionEvent } from "./ingest-events.ts";

test("SQS handler reports only failed records for ReportBatchItemFailures", async () => {
  const seen: string[] = [];
  const handler = createSqsBatchHandler(async (body) => {
    seen.push(body);
    if (body === "retry") throw new Error("synthetic failure");
  });
  const result = await handler({
    Records: [
      { messageId: "ok-1", body: "ok" },
      { messageId: "retry-1", body: "retry" },
      { messageId: "ok-2", body: "ok-again" },
    ],
  });
  assert.deepEqual(seen.sort(), ["ok", "ok-again", "retry"]);
  assert.deepEqual(result, {
    batchItemFailures: [{ itemIdentifier: "retry-1" }],
  });
});

test("compact worker events contain correlation only", () => {
  const event = parseIngestCompletionEvent(
    JSON.stringify({
      version: 1,
      invocationArn:
        "arn:aws:bedrock:us-east-1:123456789012:data-automation-invocation/service-job-1",
      outcome: "success",
      correlationId: "event-1",
    }),
  );
  assert.deepEqual(event, {
    version: 1,
    jobId: "service-job-1",
    invocationArn:
      "arn:aws:bedrock:us-east-1:123456789012:data-automation-invocation/service-job-1",
    outcome: "success",
    correlationId: "event-1",
  });
  assert.doesNotMatch(JSON.stringify(event), /owner|file|text|s3/i);
});

test("actual BDA EventBridge envelopes derive the invocation ARN from trusted metadata", () => {
  const event = parseIngestCompletionEvent({
    version: "0",
    id: "4d6fdad5-8f01-4f93-84f7-2c747bf7f628",
    "detail-type": "Bedrock Data Automation Job Succeeded",
    source: "aws.bedrock",
    account: "123456789012",
    region: "us-east-1",
    resources: [],
    detail: {
      job_id: "service-job-2",
      job_status: "SUCCESS",
      input_s3_object: { name: "ignored-sensitive-service-field" },
    },
  });
  assert.deepEqual(event, {
    version: 1,
    invocationArn:
      "arn:aws:bedrock:us-east-1:123456789012:data-automation-invocation/service-job-2",
    jobId: "service-job-2",
    outcome: "success",
    correlationId: "4d6fdad5-8f01-4f93-84f7-2c747bf7f628",
  });
  assert.doesNotMatch(JSON.stringify(event), /ignored-sensitive-service-field/);
});

test("BDA failure variants accept a matching resource ARN and reject ambiguous identity", () => {
  const invocationArn =
    "arn:aws:bedrock:us-east-1:123456789012:data-automation-invocation/service-job-3";
  assert.equal(
    parseIngestCompletionEvent({
      version: "0",
      id: "event-failure-1",
      "detail-type": "Bedrock Data Automation Job Failed With Service Error",
      source: "aws.bedrock",
      account: "123456789012",
      region: "us-east-1",
      resources: [invocationArn],
      detail: { job_id: "service-job-3" },
    }).outcome,
    "failure",
  );
  assert.throws(() =>
    parseIngestCompletionEvent({
      version: "0",
      id: "event-spoof-1",
      "detail-type": "Bedrock Data Automation Job Succeeded",
      source: "client.application",
      account: "123456789012",
      region: "us-east-1",
      resources: [invocationArn],
      detail: { job_id: "service-job-3" },
    }),
  );
  assert.throws(() =>
    parseIngestCompletionEvent({
      version: 1,
      jobId: "client-selected-id",
      outcome: "success",
      correlationId: "event-spoof-2",
    }),
  );
});
