// DynamoDB Document client + helpers for the SeegerWeissAI data layer.
// Server-only. Uses the default AWS credential chain (SSO profile in dev; a
// scoped role in prod) and AWS_REGION. Table from SW_DDB_TABLE.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
  BatchWriteCommand,
  type QueryCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { loadDynamoConfig } from "../config.server";
import { localServiceEndpoint } from "../local-development";

let _doc: DynamoDBDocumentClient | undefined;
let _docRegion = "";

export function tableName(): string {
  return loadDynamoConfig().table;
}

export function doc(): DynamoDBDocumentClient {
  const { region } = loadDynamoConfig();
  const endpoint = localServiceEndpoint("dynamo");
  const cacheKey = `${region}:${endpoint ?? "aws"}`;
  if (!_doc || _docRegion !== cacheKey) {
    const base = new DynamoDBClient({ region, ...(endpoint ? { endpoint, credentials: { accessKeyId: "localsynthetic", secretAccessKey: "localsynthetic" } } : {}) });
    _doc = DynamoDBDocumentClient.from(base, {
      marshallOptions: { removeUndefinedValues: true },
    });
    _docRegion = cacheKey;
  }
  return _doc;
}

export type Item = Record<string, unknown>;

export async function putItem(item: Item): Promise<void> {
  await doc().send(new PutCommand({ TableName: tableName(), Item: item }));
}

/** Atomic condition for callers that must not overwrite concurrently reviewed data. */
export async function putItemConditionally(
  item: Item,
  condition: {
    expression: string;
    names: Record<string, string>;
    values: Record<string, unknown>;
  },
): Promise<boolean> {
  try {
    await doc().send(
      new PutCommand({
        TableName: tableName(),
        Item: item,
        ConditionExpression: condition.expression,
        ExpressionAttributeNames: condition.names,
        ExpressionAttributeValues: condition.values,
      }),
    );
    return true;
  } catch (error) {
    if ((error as { name?: string })?.name === "ConditionalCheckFailedException") return false;
    throw error;
  }
}

/** Conditional create used by idempotent job/workspace reservations. */
export async function putItemIfAbsent(item: Item): Promise<boolean> {
  try {
    await doc().send(
      new PutCommand({
        TableName: tableName(),
        Item: item,
        ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
      }),
    );
    return true;
  } catch (error) {
    if ((error as { name?: string })?.name === "ConditionalCheckFailedException") {
      return false;
    }
    throw error;
  }
}

export async function getItem(
  pk: string,
  sk: string,
  opts?: { consistent?: boolean },
): Promise<Item | undefined> {
  const r = await doc().send(
    new GetCommand({
      TableName: tableName(),
      Key: { PK: pk, SK: sk },
      ConsistentRead: opts?.consistent ?? false,
    }),
  );
  return r.Item;
}

export async function queryPrefix(
  pk: string,
  skPrefix: string,
  opts?: { limit?: number; scanForward?: boolean; consistent?: boolean },
): Promise<Item[]> {
  const items: Item[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const input: QueryCommandInput = {
      TableName: tableName(),
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :p)",
      ExpressionAttributeValues: { ":pk": pk, ":p": skPrefix },
      ScanIndexForward: opts?.scanForward ?? true,
      ConsistentRead: opts?.consistent ?? false,
      ExclusiveStartKey,
    };
    if (opts?.limit) input.Limit = opts.limit;
    const r = await doc().send(new QueryCommand(input));
    if (r.Items) items.push(...r.Items);
    ExclusiveStartKey = r.LastEvaluatedKey as Record<string, unknown> | undefined;
    if (opts?.limit && items.length >= opts.limit) break;
  } while (ExclusiveStartKey);
  return items;
}

/** Query a GSI by partition key + SK prefix (used for folder contents on GSI1). */
export async function queryIndexPrefix(
  index: "GSI1" | "GSI2",
  pk: string,
  skPrefix: string,
  opts?: { limit?: number; scanForward?: boolean },
): Promise<Item[]> {
  const pkName = `${index}PK`;
  const skName = `${index}SK`;
  const items: Item[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const input: QueryCommandInput = {
      TableName: tableName(),
      IndexName: index,
      KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :p)",
      ExpressionAttributeNames: { "#pk": pkName, "#sk": skName },
      ExpressionAttributeValues: { ":pk": pk, ":p": skPrefix },
      ScanIndexForward: opts?.scanForward ?? true,
      ExclusiveStartKey,
    };
    if (opts?.limit) input.Limit = opts.limit;
    const r = await doc().send(new QueryCommand(input));
    if (r.Items) items.push(...r.Items);
    ExclusiveStartKey = r.LastEvaluatedKey as Record<string, unknown> | undefined;
    if (opts?.limit && items.length >= opts.limit) break;
  } while (ExclusiveStartKey);
  return items;
}

export async function updateItem(
  pk: string,
  sk: string,
  params: { set?: Record<string, unknown>; remove?: string[] },
): Promise<void> {
  const setKeys = Object.keys(params.set ?? {});
  const removeKeys = params.remove ?? [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const setExpr = setKeys.map((k, i) => {
    names[`#s${i}`] = k;
    values[`:s${i}`] = (params.set as Record<string, unknown>)[k];
    return `#s${i} = :s${i}`;
  });
  const remExpr = removeKeys.map((k, i) => {
    names[`#r${i}`] = k;
    return `#r${i}`;
  });
  const parts: string[] = [];
  if (setExpr.length) parts.push("SET " + setExpr.join(", "));
  if (remExpr.length) parts.push("REMOVE " + remExpr.join(", "));
  if (!parts.length) return;
  await doc().send(
    new UpdateCommand({
      TableName: tableName(),
      Key: { PK: pk, SK: sk },
      UpdateExpression: parts.join(" "),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: Object.keys(values).length ? values : undefined,
    }),
  );
}

export async function deleteItem(pk: string, sk: string): Promise<void> {
  await doc().send(new DeleteCommand({ TableName: tableName(), Key: { PK: pk, SK: sk } }));
}

export async function batchDelete(keys: { PK: string; SK: string }[]): Promise<void> {
  const table = tableName();
  for (let i = 0; i < keys.length; i += 25) {
    let pending = keys.slice(i, i + 25);
    for (let attempt = 0; pending.length && attempt < 8; attempt++) {
      const response = await doc().send(
        new BatchWriteCommand({
          RequestItems: { [table]: pending.map((Key) => ({ DeleteRequest: { Key } })) },
        }),
      );
      const unprocessed = response.UnprocessedItems?.[table] ?? [];
      pending = unprocessed.flatMap((request) => {
        const key = request.DeleteRequest?.Key;
        return typeof key?.["PK"] === "string" && typeof key["SK"] === "string"
          ? [{ PK: key["PK"], SK: key["SK"] }]
          : [];
      });
      if (pending.length && attempt < 7) {
        await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
      }
    }
    if (pending.length) {
      throw new Error("one or more DynamoDB items could not be deleted");
    }
  }
}
