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

export const TABLE = process.env.SW_DDB_TABLE ?? "sw-dev-app";
const REGION = process.env.AWS_REGION ?? "us-east-1";

let _doc: DynamoDBDocumentClient | undefined;
export function doc(): DynamoDBDocumentClient {
  if (!_doc) {
    const base = new DynamoDBClient({ region: REGION });
    _doc = DynamoDBDocumentClient.from(base, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }
  return _doc;
}

export type Item = Record<string, unknown>;

export async function putItem(item: Item): Promise<void> {
  await doc().send(new PutCommand({ TableName: TABLE, Item: item }));
}

export async function getItem(pk: string, sk: string): Promise<Item | undefined> {
  const r = await doc().send(new GetCommand({ TableName: TABLE, Key: { PK: pk, SK: sk } }));
  return r.Item;
}

export async function queryPrefix(
  pk: string,
  skPrefix: string,
  opts?: { limit?: number; scanForward?: boolean },
): Promise<Item[]> {
  const items: Item[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const input: QueryCommandInput = {
      TableName: TABLE,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :p)",
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
      TableName: TABLE,
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
      TableName: TABLE,
      Key: { PK: pk, SK: sk },
      UpdateExpression: parts.join(" "),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: Object.keys(values).length ? values : undefined,
    }),
  );
}

export async function deleteItem(pk: string, sk: string): Promise<void> {
  await doc().send(new DeleteCommand({ TableName: TABLE, Key: { PK: pk, SK: sk } }));
}

export async function batchDelete(keys: { PK: string; SK: string }[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 25) {
    const chunk = keys.slice(i, i + 25);
    if (!chunk.length) continue;
    await doc().send(
      new BatchWriteCommand({
        RequestItems: { [TABLE]: chunk.map((Key) => ({ DeleteRequest: { Key } })) },
      }),
    );
  }
}
