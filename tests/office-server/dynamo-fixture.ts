import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
export function localDynamoClient() {
  const endpoint = process.env.OFFICE_DYNAMO_TEST_ENDPOINT;
  if (!endpoint)
    throw new Error("Run with bun scripts/test-office-dynamo.mjs (local emulator required).");
  const url = new URL(endpoint);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port)
    throw new Error("Office protocol tests can only access an explicit loopback endpoint.");
  const client = new DynamoDBClient({
    endpoint,
    region: "us-east-1",
    maxAttempts: 1,
    credentials: { accessKeyId: "local-test-key", secretAccessKey: "local-test-secret" },
  });
  return DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
}
