import { afterAll, beforeAll, expect, test } from "bun:test";
import { CreateTableCommand, DeleteTableCommand } from "@aws-sdk/client-dynamodb";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  createInterpreterStore,
  interpreterKeys,
} from "../../src/lib/agents/interpreter-store.server";
import {
  createInterpreterRunner,
  EMPTY_SESSION,
  INTERPRETER_LEASE_MS,
} from "../../src/lib/agents/interpreter-registry";
import { localDynamoClient } from "./dynamo-fixture";

const table = `office-local-test-${crypto.randomUUID()}`;
const firstClient = localDynamoClient(),
  secondClient = localDynamoClient();
const firstStore = createInterpreterStore(firstClient, table, "local"),
  secondStore = createInterpreterStore(secondClient, table, "local");
const first = createInterpreterRunner(firstStore),
  second = createInterpreterRunner(secondStore);
beforeAll(async () => {
  await firstClient.send(
    new CreateTableCommand({
      TableName: table,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "PK", AttributeType: "S" },
        { AttributeName: "SK", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "PK", KeyType: "HASH" },
        { AttributeName: "SK", KeyType: "RANGE" },
      ],
    }),
  );
});
afterAll(async () => {
  try {
    await firstClient.send(new DeleteTableCommand({ TableName: table }));
  } finally {
    firstClient.destroy();
    secondClient.destroy();
  }
});

test("independent SDK clients restore session identity, uploads and artifact bookkeeping", async () => {
  await first("alice", "office:resume", async (s) => {
    s.session = { id: "python-session", startedAt: Date.now() };
    s.baselinedFor = s.session.id;
    s.seenFiles.add("deposition.docx");
    await s.checkpoint!();
  });
  await second("alice", "office:resume", async (s) => {
    expect(s.session?.id).toBe("python-session");
    expect(s.baselinedFor).toBe("python-session");
    expect([...s.seenFiles]).toEqual(["deposition.docx"]);
  });
});

test("conditional acquisition serializes two clients with no lost updates", async () => {
  let enter!: () => void;
  const entered = new Promise<void>((r) => {
    enter = r;
  });
  let active = 0,
    maximum = 0;
  const a = first("alice", "office:concurrent", async (s) => {
    maximum = Math.max(maximum, ++active);
    enter();
    await new Promise((r) => setTimeout(r, 125));
    s.seenFiles.add("first.csv");
    active--;
  });
  await entered;
  const b = second("alice", "office:concurrent", async (s) => {
    maximum = Math.max(maximum, ++active);
    expect(s.seenFiles.has("first.csv")).toBe(true);
    s.seenFiles.add("second.csv");
    active--;
  });
  await Promise.all([a, b]);
  expect(maximum).toBe(1);
  await first("alice", "office:concurrent", async (s) =>
    expect([...s.seenFiles]).toEqual(["first.csv", "second.csv"]),
  );
});

test("owner, task and interpreter target are separate durable namespaces", async () => {
  await first("alice", "office:isolation", async (s) => {
    s.seenFiles.add("private.txt");
  });
  await second("bob", "office:isolation", async (s) => expect(s.seenFiles.size).toBe(0));
  await second("alice", "office:other", async (s) => expect(s.seenFiles.size).toBe(0));
  const other = createInterpreterRunner(
    createInterpreterStore(secondClient, table, "other-region:interpreter"),
  );
  await other("alice", "office:isolation", async (s) => expect(s.seenFiles.size).toBe(0));
});

test("expired abandoned leases cannot be stolen or changed with a different token", async () => {
  const now = Date.now();
  await firstStore.claim(
    "alice",
    "office:abandoned",
    "dead-worker",
    now - INTERPRETER_LEASE_MS - 1,
  );
  await expect(secondStore.claim("alice", "office:abandoned", "new-worker", now)).rejects.toThrow(
    "interrupted",
  );
  await expect(
    secondStore.checkpoint("alice", "office:abandoned", "new-worker", EMPTY_SESSION, now),
  ).rejects.toMatchObject({ name: "ConditionalCheckFailedException" });
  await expect(
    secondStore.finish("alice", "office:abandoned", "new-worker", EMPTY_SESSION, now),
  ).rejects.toMatchObject({ name: "ConditionalCheckFailedException" });
});

test("a lost finish acknowledgment is accepted only with the same persisted completion token", async () => {
  const now = Date.now();
  const claim = await firstStore.claim("alice", "office:lost-ack", "operation-a", now);
  const lossy = createInterpreterStore(
    {
      send: async (command: GetCommand | UpdateCommand) => {
        const response = await firstClient.send(command);
        if (
          command instanceof UpdateCommand &&
          command.input.UpdateExpression?.includes("lastFinished")
        )
          throw new Error("reply lost after commit");
        return response;
      },
    },
    table,
    "local",
  );
  await lossy.finish("alice", "office:lost-ack", "operation-a", claim.snapshot, now);
  await expect(
    lossy.finish("alice", "office:lost-ack", "different-operation", claim.snapshot, now),
  ).rejects.toThrow();
  await second("alice", "office:lost-ack", async (s) => expect(s.session).toBeNull());
});

test("blocked state survives new clients and is not a reusable empty session", async () => {
  await expect(
    first("alice", "office:blocked", async (s) => {
      s.blockedReason = "has an unconfirmed execution";
    }),
  ).rejects.toThrow("unconfirmed");
  await expect(
    second("alice", "office:blocked", async () => {
      throw new Error("must not execute");
    }),
  ).rejects.toThrow("cannot safely resume");
  const row = await firstClient.send(
    new GetCommand({
      TableName: table,
      Key: interpreterKeys("alice", "office:blocked", "local"),
      ConsistentRead: true,
    }),
  );
  expect(row.Item?.status).toBe("blocked");
  expect(row.Item?.leaseToken).toBeUndefined();
});

test("a later OS process recovers the earlier process's persisted workspace", async () => {
  async function worker(mode: string) {
    const child = Bun.spawn(
      [process.execPath, "tests/office-server/interpreter-worker.fixture.ts", table, mode],
      { stdout: "pipe", stderr: "pipe", env: process.env },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    return JSON.parse(stdout);
  }
  const written = await worker("write"),
    restored = await worker("read");
  expect(restored).toEqual(written);
  expect(restored).toEqual({
    id: "fixture-remote-session",
    files: ["source.docx"],
    baseline: "fixture-remote-session",
  });
}, 20_000);
