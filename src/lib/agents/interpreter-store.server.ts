import { createHash } from "node:crypto";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  EMPTY_SESSION,
  INTERPRETER_LEASE_MS,
  INTERPRETER_RECORD_TTL_SECONDS,
  InterpreterBusyError,
  workspaceUnavailable,
  type InterpreterSessionStore,
  type SessionSnapshot,
} from "./interpreter-registry";

type Client = {
  send(
    command: GetCommand | UpdateCommand,
  ): Promise<{ Item?: Record<string, unknown>; Attributes?: Record<string, unknown> }>;
};

export function interpreterKeys(owner: string, scope: string, target: string) {
  if (!owner || owner.length > 512 || !/^office:[a-zA-Z0-9_-]{1,100}$/.test(scope))
    throw new Error("Invalid authenticated Python task scope.");
  return {
    PK: `USER#${owner}`,
    SK: `OFFICE_PYTHON#v1#${createHash("sha256")
      .update(JSON.stringify([target, scope]))
      .digest("hex")}`,
  };
}
function isConditional(error: unknown) {
  return (error as { name?: string })?.name === "ConditionalCheckFailedException";
}
function snapshotOf(value: unknown): SessionSnapshot {
  if (value === undefined) return structuredClone(EMPTY_SESSION);
  const s = value as SessionSnapshot;
  if (
    !s ||
    !Array.isArray(s.seenFiles) ||
    !s.seenFiles.every((f) => typeof f === "string") ||
    !(s.baselinedFor === null || typeof s.baselinedFor === "string") ||
    !(
      s.session === null ||
      (typeof s.session?.id === "string" && Number.isFinite(s.session.startedAt))
    ) ||
    !(s.blockedReason === undefined || typeof s.blockedReason === "string")
  )
    throw workspaceUnavailable("has invalid saved state");
  return s;
}

/** Existing app table, exact authenticated owner key; no scan, new table or GSI. */
export function createInterpreterStore(
  client: Client,
  table: string,
  target: string,
): InterpreterSessionStore {
  const read = async (Key: ReturnType<typeof interpreterKeys>) =>
    (await client.send(new GetCommand({ TableName: table, Key, ConsistentRead: true }))).Item;
  return {
    async claim(owner, scope, token, now) {
      const Key = interpreterKeys(owner, scope, target);
      try {
        const r = await client.send(
          new UpdateCommand({
            TableName: table,
            Key,
            UpdateExpression:
              "SET #kind = :kind, #status = if_not_exists(#status, :ready), leaseToken = :token, leaseUntil = :until, #ttl = :ttl",
            // A retry of this SAME acquisition is idempotent. Expired leases are
            // intentionally absent from this condition; never steal a live sandbox.
            ConditionExpression:
              "(attribute_not_exists(leaseToken) OR leaseToken = :token) AND (attribute_not_exists(#status) OR #status = :ready)",
            ExpressionAttributeNames: { "#kind": "type", "#status": "status", "#ttl": "ttl" },
            ExpressionAttributeValues: {
              ":kind": "office-python-session",
              ":ready": "ready",
              ":token": token,
              ":until": now + INTERPRETER_LEASE_MS,
              ":ttl": Math.floor(now / 1000) + INTERPRETER_RECORD_TTL_SECONDS,
            },
            ReturnValues: "ALL_NEW",
          }),
        );
        if (!r.Attributes || typeof r.Attributes.leaseUntil !== "number")
          throw workspaceUnavailable("could not establish exclusive access");
        return { snapshot: snapshotOf(r.Attributes.snapshot), leaseUntil: r.Attributes.leaseUntil };
      } catch (error) {
        if (!isConditional(error)) throw error;
        const row = await read(Key);
        if (row?.status === "blocked")
          throw workspaceUnavailable("cannot safely resume its previous operation");
        if (typeof row?.leaseUntil === "number" && row.leaseUntil <= now)
          throw workspaceUnavailable("was interrupted before completion could be confirmed");
        throw new InterpreterBusyError();
      }
    },
    async checkpoint(owner, scope, token, snapshot, now) {
      await client.send(
        new UpdateCommand({
          TableName: table,
          Key: interpreterKeys(owner, scope, target),
          UpdateExpression: "SET #snapshot = :snapshot",
          ConditionExpression: "leaseToken = :token AND leaseUntil > :now AND #status = :ready",
          ExpressionAttributeNames: { "#status": "status", "#snapshot": "snapshot" },
          ExpressionAttributeValues: {
            ":token": token,
            ":now": now,
            ":ready": "ready",
            ":snapshot": snapshot,
          },
        }),
      );
    },
    async finish(owner, scope, token, snapshot, now) {
      const Key = interpreterKeys(owner, scope, target);
      try {
        await client.send(
          new UpdateCommand({
            TableName: table,
            Key,
            UpdateExpression:
              "SET #snapshot = :snapshot, #status = :status, lastFinished = :token, #ttl = :ttl REMOVE leaseToken, leaseUntil",
            ConditionExpression: "leaseToken = :token",
            ExpressionAttributeNames: {
              "#status": "status",
              "#ttl": "ttl",
              "#snapshot": "snapshot",
            },
            ExpressionAttributeValues: {
              ":snapshot": snapshot,
              ":status": snapshot.blockedReason ? "blocked" : "ready",
              ":token": token,
              ":ttl": Math.floor(now / 1000) + INTERPRETER_RECORD_TTL_SECONDS,
            },
          }),
        );
      } catch (error) {
        // An acknowledged conditional write may be retried after a lost reply.
        // Only THIS operation's saved completion marker proves it was committed.
        const row = await read(Key).catch(() => undefined);
        if (row?.lastFinished !== token) throw error;
      }
    },
  };
}

export async function officeInterpreterStore(): Promise<InterpreterSessionStore> {
  const { doc, tableName } = await import("../data/dynamo.server");
  const region = process.env.BEDROCK_REGION ?? process.env.AWS_REGION ?? "us-east-1";
  const interpreter = process.env.CODE_INTERPRETER_ID || "aws.codeinterpreter.v1";
  return createInterpreterStore(doc(), tableName(), `${region}:${interpreter}`);
}
