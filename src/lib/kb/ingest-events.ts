import { createHash } from "node:crypto";

import { invocationJobId } from "./ingest-keys.ts";

export const BDA_SUCCESS_DETAIL_TYPE = "Bedrock Data Automation Job Succeeded";
export const BDA_FAILURE_DETAIL_TYPES = [
  "Bedrock Data Automation Job Failed With Client Error",
  "Bedrock Data Automation Job Failed With Service Error",
] as const;

const BDA_DETAIL_TYPES = new Set<string>([BDA_SUCCESS_DETAIL_TYPE, ...BDA_FAILURE_DETAIL_TYPES]);
const CORRELATION_ID = /^[A-Za-z0-9._:-]{1,256}$/;
const ACCOUNT_ID = /^[0-9]{12}$/;
const REGION = /^[a-z]{2}(?:-[a-z0-9]+)+-[0-9]+$/;
const JOB_ID = /^[A-Za-z0-9._:-]{1,256}$/;
const INVOCATION_ARN =
  /^arn:(aws|aws-cn|aws-us-gov|aws-iso|aws-iso-b):bedrock:([^:]+):([0-9]{12}):data-automation-invocation\/([A-Za-z0-9._:-]{1,256})$/;

export type IngestQueueMessage = {
  version: 1;
  invocationArn: string;
  outcome: "success" | "failure";
  correlationId: string;
};

export type IngestCompletionEvent = IngestQueueMessage & {
  /** Derived from the validated invocation ARN. Never accepted as client identity. */
  jobId: string;
};

function parseJson(value: string | unknown): unknown {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error("invalid ingest completion event");
    }
  }
  return parsed;
}

function normalizedMessage(message: IngestQueueMessage): IngestCompletionEvent {
  if (
    !CORRELATION_ID.test(message.correlationId) ||
    (message.outcome !== "success" && message.outcome !== "failure")
  ) {
    throw new Error("invalid ingest completion event");
  }
  return {
    ...message,
    invocationArn: validateInvocationArn(message.invocationArn),
    jobId: invocationJobId(message.invocationArn),
  };
}

function validateInvocationArn(value: unknown): string {
  if (typeof value !== "string" || !INVOCATION_ARN.test(value)) {
    throw new Error("invalid ingest completion event");
  }
  return value;
}

function partitionForRegion(region: string): string {
  if (region.startsWith("cn-")) return "aws-cn";
  if (region.startsWith("us-gov-")) return "aws-us-gov";
  if (region.startsWith("us-iso-")) return "aws-iso";
  if (region.startsWith("us-isob-")) return "aws-iso-b";
  return "aws";
}

function eventBridgeInvocationArn(candidate: Record<string, unknown>): string {
  const detail =
    candidate["detail"] && typeof candidate["detail"] === "object"
      ? (candidate["detail"] as Record<string, unknown>)
      : {};
  const resources = Array.isArray(candidate["resources"])
    ? candidate["resources"].filter((value): value is string => typeof value === "string")
    : [];
  const direct = [
    detail["invocationArn"],
    detail["invocation_arn"],
    detail["jobArn"],
    detail["job_arn"],
    ...resources,
  ].filter((value): value is string => typeof value === "string" && INVOCATION_ARN.test(value));

  const account = candidate["account"];
  const region = candidate["region"];
  const rawJobId = detail["job_id"] ?? detail["jobId"];
  let reconstructed: string | undefined;
  if (
    typeof rawJobId === "string" &&
    JOB_ID.test(rawJobId) &&
    typeof account === "string" &&
    ACCOUNT_ID.test(account) &&
    typeof region === "string" &&
    REGION.test(region)
  ) {
    reconstructed = `arn:${partitionForRegion(region)}:bedrock:${region}:${account}:data-automation-invocation/${rawJobId}`;
  }

  const candidates = new Set(direct);
  if (reconstructed) candidates.add(reconstructed);
  if (candidates.size !== 1) {
    throw new Error("invalid ingest completion event");
  }
  const invocationArn = validateInvocationArn([...candidates][0]);
  const match = INVOCATION_ARN.exec(invocationArn)!;
  if (
    (typeof account === "string" && account !== match[3]) ||
    (typeof region === "string" && region !== match[2]) ||
    (typeof rawJobId === "string" && rawJobId !== match[4])
  ) {
    throw new Error("invalid ingest completion event");
  }
  return invocationArn;
}

export function toIngestQueueMessage(
  invocationArn: string,
  outcome: "success" | "failure",
  correlationId: string,
): IngestQueueMessage {
  const normalized = normalizedMessage({
    version: 1,
    invocationArn,
    outcome,
    correlationId,
  });
  const { jobId: _jobId, ...message } = normalized;
  return message;
}

/**
 * Accept either the compact v1 reconciliation message or an unmodified BDA
 * EventBridge service envelope. A bare job/client id is deliberately rejected.
 */
export function parseIngestCompletionEvent(value: string | unknown): IngestCompletionEvent {
  const parsed = parseJson(value);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("invalid ingest completion event");
  }
  const candidate = parsed as Record<string, unknown>;

  if (candidate["version"] === 1) {
    if (
      typeof candidate["invocationArn"] !== "string" ||
      (candidate["outcome"] !== "success" && candidate["outcome"] !== "failure") ||
      typeof candidate["correlationId"] !== "string"
    ) {
      throw new Error("invalid ingest completion event");
    }
    return normalizedMessage({
      version: 1,
      invocationArn: candidate["invocationArn"],
      outcome: candidate["outcome"],
      correlationId: candidate["correlationId"],
    });
  }

  const detailType = candidate["detail-type"];
  if (
    candidate["version"] !== "0" ||
    candidate["source"] !== "aws.bedrock" ||
    typeof detailType !== "string" ||
    !BDA_DETAIL_TYPES.has(detailType) ||
    typeof candidate["id"] !== "string" ||
    !CORRELATION_ID.test(candidate["id"])
  ) {
    throw new Error("invalid ingest completion event");
  }
  return normalizedMessage({
    version: 1,
    invocationArn: eventBridgeInvocationArn(candidate),
    outcome: detailType === BDA_SUCCESS_DETAIL_TYPE ? "success" : "failure",
    correlationId: candidate["id"],
  });
}

export function reconciliationCorrelationId(invocationArn: string, observedAt: string): string {
  validateInvocationArn(invocationArn);
  const digest = createHash("sha256")
    .update(invocationArn)
    .update("|")
    .update(observedAt)
    .digest("hex")
    .slice(0, 32);
  return `reconcile-${digest}`;
}
