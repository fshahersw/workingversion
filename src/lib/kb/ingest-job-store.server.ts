import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

import { loadKbAsyncIngestConfig, type KbAsyncIngestConfig } from "../config.server.ts";
import {
  ASYNC_INGEST_MAX_BYTES,
  isSha256,
  isTerminalErrorKind,
  terminalErrorSummary,
  type IngestStatus,
  type TerminalErrorKind,
} from "./ingest-state.ts";
import {
  deterministicBdaClientToken,
  invocationJobId as jobIdFromInvocationArn,
  requireClientFileId,
  requireJobLookupId,
  requireOwnedBdaOutputPrefix,
  requireOwnedUploadKey,
} from "./ingest-keys.ts";

export type IngestJobRecord = {
  recordType: "job";
  jobId: string;
  invocationJobId?: string;
  invocationArn?: string;
  ownerSub: string;
  docId: string;
  workspaceItemId: string;
  workspaceId: string;
  clientFileId: string;
  requestFingerprint: string;
  sourceSha256: string;
  sourceByteSize: number;
  inputKey: string;
  outputPrefix: string;
  status: IngestStatus;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  errorKind?: TerminalErrorKind;
  errorSummary?: string;
  processingToken?: string;
  leaseUntil?: number;
  ttl: number;
};

type IngestJobAlias = {
  recordType: "alias";
  jobId: string;
  canonicalJobId: string;
  ttl: number;
};

export type ReserveIngestJobInput = Omit<
  IngestJobRecord,
  | "recordType"
  | "attempts"
  | "createdAt"
  | "updatedAt"
  | "completedAt"
  | "errorKind"
  | "errorSummary"
  | "processingToken"
  | "leaseUntil"
  | "ttl"
  | "invocationArn"
  | "invocationJobId"
  | "status"
>;

export type JobClaim =
  | {
      kind: "claimed";
      job: IngestJobRecord;
      processingToken: string;
    }
  | { kind: "busy" | "terminal"; job: IngestJobRecord };

export type IngestJobStore = {
  reserve(input: ReserveIngestJobInput): Promise<IngestJobRecord>;
  attachInvocation(
    canonicalJobId: string,
    invocationJobId: string,
    invocationArn: string,
  ): Promise<IngestJobRecord>;
  getByLookupId(lookupId: string): Promise<IngestJobRecord | null>;
  claimSuccess(
    canonicalJobId: string,
    processingToken: string,
    leaseSeconds?: number,
  ): Promise<JobClaim>;
  complete(canonicalJobId: string, processingToken: string): Promise<boolean>;
  fail(canonicalJobId: string, kind: TerminalErrorKind, processingToken?: string): Promise<boolean>;
  release(canonicalJobId: string, processingToken: string): Promise<void>;
  touch(canonicalJobId: string): Promise<void>;
  listStale(
    statuses: readonly ("queued" | "converting" | "embedding")[],
    updatedBefore: string,
    limit?: number,
  ): Promise<IngestJobRecord[]>;
  delete(canonicalJobId: string): Promise<void>;
};

type StoreOptions = {
  client?: DynamoDBDocumentClient;
  config?: KbAsyncIngestConfig;
  now?: () => Date;
};

let cachedClient: DynamoDBDocumentClient | undefined;
let cachedRegion = "";

function defaultClient(region: string): DynamoDBDocumentClient {
  if (!cachedClient || cachedRegion !== region) {
    cachedClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
      marshallOptions: { removeUndefinedValues: true },
    });
    cachedRegion = region;
  }
  return cachedClient;
}

function isConditionalFailure(error: unknown): boolean {
  return (
    (error as { name?: string } | undefined)?.name === "ConditionalCheckFailedException" ||
    (error as { name?: string } | undefined)?.name === "TransactionCanceledException"
  );
}

function sameReservation(current: IngestJobRecord, input: ReserveIngestJobInput): boolean {
  return (
    current.jobId === input.jobId &&
    current.ownerSub === input.ownerSub &&
    current.docId === input.docId &&
    current.workspaceItemId === input.workspaceItemId &&
    current.workspaceId === input.workspaceId &&
    current.clientFileId === input.clientFileId &&
    current.requestFingerprint === input.requestFingerprint &&
    current.sourceSha256 === input.sourceSha256 &&
    current.sourceByteSize === input.sourceByteSize &&
    current.inputKey === input.inputKey &&
    current.outputPrefix === input.outputPrefix
  );
}

export function createIngestJobStore(options: StoreOptions = {}): IngestJobStore {
  const config = options.config ?? loadKbAsyncIngestConfig();
  if (!config.jobsTable) {
    throw new Error(terminalErrorSummary("configuration"));
  }
  const client = options.client ?? defaultClient(config.region);
  const now = options.now ?? (() => new Date());
  const table = config.jobsTable;

  const expiry = (from: Date): number =>
    Math.floor(from.getTime() / 1000) + config.jobTtlDays * 86_400;

  async function getRaw(jobId: string): Promise<IngestJobRecord | IngestJobAlias | null> {
    const response = await client.send(
      new GetCommand({
        TableName: table,
        Key: { jobId: requireJobLookupId(jobId) },
        ConsistentRead: true,
      }),
    );
    return (response.Item as IngestJobRecord | IngestJobAlias | undefined) ?? null;
  }

  async function getCanonical(canonicalJobId: string): Promise<IngestJobRecord | null> {
    const item = await getRaw(canonicalJobId);
    return item?.recordType === "job" ? item : null;
  }

  return {
    async reserve(input) {
      requireJobLookupId(input.jobId);
      requireClientFileId(input.clientFileId);
      if (!isSha256(input.requestFingerprint) || !isSha256(input.sourceSha256)) {
        throw new Error("invalid ingest job fingerprint");
      }
      if (
        !Number.isSafeInteger(input.sourceByteSize) ||
        input.sourceByteSize < 1 ||
        input.sourceByteSize > ASYNC_INGEST_MAX_BYTES
      ) {
        throw new Error("invalid ingest job byte size");
      }
      if (
        deterministicBdaClientToken({
          principal: input.ownerSub,
          workspaceItemId: input.workspaceItemId,
          workspaceId: input.workspaceId,
          clientFileId: input.clientFileId,
          sha256: input.sourceSha256,
        }) !== input.jobId
      ) {
        throw new Error("invalid ingest job token");
      }
      requireOwnedUploadKey(input.ownerSub, input.inputKey);
      requireOwnedBdaOutputPrefix(input.ownerSub, input.docId, input.outputPrefix);
      const timestamp = now();
      const item: IngestJobRecord = {
        recordType: "job",
        ...input,
        status: "queued",
        attempts: 0,
        createdAt: timestamp.toISOString(),
        updatedAt: timestamp.toISOString(),
        ttl: expiry(timestamp),
      };
      try {
        await client.send(
          new PutCommand({
            TableName: table,
            Item: item,
            ConditionExpression: "attribute_not_exists(jobId)",
          }),
        );
        return item;
      } catch (error) {
        if (!isConditionalFailure(error)) throw error;
        const current = await getCanonical(input.jobId);
        if (!current || !sameReservation(current, input)) {
          throw new Error("ingest job reservation conflict");
        }
        return current;
      }
    },

    async attachInvocation(canonicalJobId, invocationJobId, invocationArn) {
      requireJobLookupId(canonicalJobId);
      requireJobLookupId(invocationJobId);
      if (jobIdFromInvocationArn(invocationArn) !== invocationJobId) {
        throw new Error("ingest invocation correlation conflict");
      }
      const timestamp = now();
      const alias: IngestJobAlias = {
        recordType: "alias",
        jobId: invocationJobId,
        canonicalJobId,
        ttl: expiry(timestamp),
      };
      try {
        await client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: table,
                  Item: alias,
                  ConditionExpression:
                    "attribute_not_exists(jobId) OR (recordType = :alias AND canonicalJobId = :canonical)",
                  ExpressionAttributeValues: {
                    ":alias": "alias",
                    ":canonical": canonicalJobId,
                  },
                },
              },
              {
                Update: {
                  TableName: table,
                  Key: { jobId: canonicalJobId },
                  UpdateExpression:
                    "SET invocationJobId = :lookup, invocationArn = :arn, #status = :converting, updatedAt = :now",
                  ConditionExpression:
                    "recordType = :job AND (#status = :queued OR #status = :converting) AND (attribute_not_exists(invocationArn) OR invocationArn = :arn)",
                  ExpressionAttributeNames: { "#status": "status" },
                  ExpressionAttributeValues: {
                    ":lookup": invocationJobId,
                    ":arn": invocationArn,
                    ":converting": "converting",
                    ":now": timestamp.toISOString(),
                    ":job": "job",
                  },
                },
              },
            ],
          }),
        );
      } catch (error) {
        if (!isConditionalFailure(error)) throw error;
        const [current, currentAlias] = await Promise.all([
          getCanonical(canonicalJobId),
          getRaw(invocationJobId),
        ]);
        if (
          !current ||
          current.invocationArn !== invocationArn ||
          current.invocationJobId !== invocationJobId ||
          currentAlias?.recordType !== "alias" ||
          currentAlias.canonicalJobId !== canonicalJobId
        ) {
          throw new Error("ingest invocation correlation conflict");
        }
        return current;
      }
      const updated = await getCanonical(canonicalJobId);
      if (!updated) throw new Error("ingest job mapping was not found");
      return updated;
    },

    async getByLookupId(lookupId) {
      const item = await getRaw(lookupId);
      if (!item) return null;
      if (item.recordType === "job") return item;
      return getCanonical(item.canonicalJobId);
    },

    async claimSuccess(canonicalJobId, processingToken, leaseSeconds = 840) {
      requireJobLookupId(canonicalJobId);
      if (!processingToken || processingToken.length > 256) {
        throw new Error("invalid processing correlation");
      }
      const timestamp = now();
      const epoch = Math.floor(timestamp.getTime() / 1000);
      try {
        const response = await client.send(
          new UpdateCommand({
            TableName: table,
            Key: { jobId: canonicalJobId },
            UpdateExpression:
              "SET #status = :embedding, processingToken = :token, leaseUntil = :lease, updatedAt = :updated ADD attempts :one",
            ConditionExpression:
              "recordType = :job AND (#status = :converting OR (#status = :embedding AND leaseUntil < :epoch))",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":job": "job",
              ":converting": "converting",
              ":embedding": "embedding",
              ":token": processingToken,
              ":lease": epoch + leaseSeconds,
              ":epoch": epoch,
              ":updated": timestamp.toISOString(),
              ":one": 1,
            },
            ReturnValues: "ALL_NEW",
          }),
        );
        const job = response.Attributes as IngestJobRecord | undefined;
        if (!job) throw new Error("ingest job claim returned no record");
        return { kind: "claimed", job, processingToken };
      } catch (error) {
        if (!isConditionalFailure(error)) throw error;
        const job = await getCanonical(canonicalJobId);
        if (!job) throw new Error("ingest job mapping was not found");
        return {
          kind: job.status === "ready" || job.status === "error" ? "terminal" : "busy",
          job,
        };
      }
    },

    async complete(canonicalJobId, processingToken) {
      const timestamp = now().toISOString();
      try {
        await client.send(
          new UpdateCommand({
            TableName: table,
            Key: { jobId: requireJobLookupId(canonicalJobId) },
            UpdateExpression:
              "SET #status = :ready, updatedAt = :now, completedAt = if_not_exists(completedAt, :now) REMOVE processingToken, leaseUntil",
            ConditionExpression:
              "recordType = :job AND #status = :embedding AND processingToken = :token",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":job": "job",
              ":embedding": "embedding",
              ":ready": "ready",
              ":token": processingToken,
              ":now": timestamp,
            },
          }),
        );
        return true;
      } catch (error) {
        if (!isConditionalFailure(error)) throw error;
        const current = await getCanonical(canonicalJobId);
        return current?.status === "ready";
      }
    },

    async fail(canonicalJobId, kind, processingToken) {
      if (!isTerminalErrorKind(kind)) {
        throw new Error("invalid terminal ingest error kind");
      }
      const failedAt = now();
      const timestamp = failedAt.toISOString();
      const values: Record<string, unknown> = {
        ":job": "job",
        ":queued": "queued",
        ":converting": "converting",
        ":embedding": "embedding",
        ":error": "error",
        ":kind": kind,
        ":summary": terminalErrorSummary(kind),
        ":now": timestamp,
        ":epoch": Math.floor(failedAt.getTime() / 1000),
      };
      let condition =
        "recordType = :job AND (#status = :queued OR #status = :converting OR (#status = :embedding AND leaseUntil < :epoch))";
      if (processingToken) {
        condition =
          "recordType = :job AND (#status = :queued OR #status = :converting OR (#status = :embedding AND (processingToken = :token OR leaseUntil < :epoch)))";
        values[":token"] = processingToken;
      }
      try {
        await client.send(
          new UpdateCommand({
            TableName: table,
            Key: { jobId: requireJobLookupId(canonicalJobId) },
            UpdateExpression:
              "SET #status = :error, errorKind = :kind, errorSummary = :summary, updatedAt = :now, completedAt = if_not_exists(completedAt, :now) REMOVE processingToken, leaseUntil",
            ConditionExpression: condition,
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: values,
          }),
        );
        return true;
      } catch (error) {
        if (!isConditionalFailure(error)) throw error;
        return false;
      }
    },

    async release(canonicalJobId, processingToken) {
      try {
        await client.send(
          new UpdateCommand({
            TableName: table,
            Key: { jobId: requireJobLookupId(canonicalJobId) },
            UpdateExpression: "SET leaseUntil = :expired, updatedAt = :now REMOVE processingToken",
            ConditionExpression:
              "recordType = :job AND #status = :embedding AND processingToken = :token",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":job": "job",
              ":embedding": "embedding",
              ":token": processingToken,
              ":expired": 0,
              ":now": now().toISOString(),
            },
          }),
        );
      } catch (error) {
        if (!isConditionalFailure(error)) throw error;
      }
    },

    async touch(canonicalJobId) {
      await client.send(
        new UpdateCommand({
          TableName: table,
          Key: { jobId: requireJobLookupId(canonicalJobId) },
          UpdateExpression: "SET updatedAt = :now",
          ConditionExpression:
            "recordType = :job AND (#status = :converting OR #status = :embedding)",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":job": "job",
            ":converting": "converting",
            ":embedding": "embedding",
            ":now": now().toISOString(),
          },
        }),
      );
    },

    async listStale(statuses, updatedBefore, limit = 50) {
      const jobs: IngestJobRecord[] = [];
      for (const status of statuses) {
        if (jobs.length >= limit) break;
        const response = await client.send(
          new QueryCommand({
            TableName: table,
            IndexName: "StatusUpdated",
            KeyConditionExpression: "#status = :status AND updatedAt <= :updatedBefore",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":status": status,
              ":updatedBefore": updatedBefore,
            },
            Limit: limit - jobs.length,
            ScanIndexForward: true,
          }),
        );
        for (const item of response.Items ?? []) {
          if ((item as IngestJobRecord).recordType === "job") {
            jobs.push(item as IngestJobRecord);
          }
        }
      }
      return jobs.slice(0, limit);
    },

    async delete(canonicalJobId) {
      const current = await getCanonical(canonicalJobId);
      if (!current) return;
      if (current.invocationJobId) {
        try {
          await client.send(
            new DeleteCommand({
              TableName: table,
              Key: { jobId: current.invocationJobId },
              ConditionExpression: "recordType = :alias AND canonicalJobId = :canonical",
              ExpressionAttributeValues: {
                ":alias": "alias",
                ":canonical": current.jobId,
              },
            }),
          );
        } catch (error) {
          if (!isConditionalFailure(error)) throw error;
        }
      }
      try {
        await client.send(
          new DeleteCommand({
            TableName: table,
            Key: { jobId: current.jobId },
            ConditionExpression: "recordType = :job",
            ExpressionAttributeValues: { ":job": "job" },
          }),
        );
      } catch (error) {
        if (!isConditionalFailure(error)) throw error;
      }
    },
  };
}
