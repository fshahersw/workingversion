import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { ulid } from "ulid";

test("local Dynamo transactions preserve all concurrent Office chat messages and idempotent replays", {
  skip: process.env.LOCAL_CHAT_INTEGRATION !== "1",
}, async () => {
  // This test creates/deletes only its own synthetic rows in the loopback test table.
  assert.equal(process.env.LOCAL_SYNTHETIC_MODE, "1");
  assert.equal(process.env.APP_ENVIRONMENT, "local");
  assert.equal(process.env.SW_DDB_TABLE, "sw-local-app");
  assert.equal(process.env.LOCAL_DYNAMO_ENDPOINT, "http://127.0.0.1:8180");
  assert.notEqual(process.env.NODE_ENV, "production");
  const { appendOfficeChat } = await import("./office.server");
  const { putItem, getItem, queryPrefix, deleteItem } = await import("../data/dynamo.server");
  const principal = `synthetic-chat-${randomUUID()}`;
  const PK = `USER#${principal}`;
  const docId = ulid();
  const documentSK = `ITEM#${docId}`;
  try {
    await putItem({ PK, SK: documentSK, owner: principal, itemId: docId, type: "draft", kind: "docx", version: 9, hash: "saved-revision" });
    await putItem({ PK, SK: `WCHAT#${docId}#00000007`, seq: 7, role: "user", text: "Legacy message", ts: "2026-01-01T00:00:00.000Z" });
    const messages = Array.from({ length: 12 }, (_, i) => ({
      operationId: randomUUID(), role: i % 2 ? "assistant" as const : "user" as const, text: `Concurrent synthetic message ${i}`,
    }));
    const results = await Promise.all([...messages, messages[0], messages[1]].map(message => appendOfficeChat(principal, docId, message)));
    assert.equal(results[12].seq, results[0].seq);
    assert.equal(results[13].seq, results[1].seq);
    const rows = await queryPrefix(PK, `WCHAT#${docId}#`, { consistent: true });
    assert.equal(rows.length, 13);
    assert.deepEqual(rows.map(row => row.seq), Array.from({ length: 13 }, (_, i) => i + 7));
    assert.deepEqual(new Set(rows.slice(1).map(row => row.text)), new Set(messages.map(message => message.text)));
    const operations = await queryPrefix(PK, `WCHATOP#${docId}#`, { consistent: true });
    assert.equal(operations.length, 12);
    const row = await getItem(PK, documentSK, { consistent: true });
    assert.equal(row?.chatSequence, 19);
    assert.equal(row?.version, 9);
    assert.equal(row?.hash, "saved-revision");
    await assert.rejects(appendOfficeChat(principal, docId, { ...messages[0], text: "changed payload" }), /reused with different chat content/);
    await assert.rejects(appendOfficeChat(`${principal}-other-owner`, docId, messages[0]), /Document not found/);
  } finally {
    for (const prefix of [`WCHAT#${docId}#`, `WCHATOP#${docId}#`]) {
      const ownedRows = await queryPrefix(PK, prefix, { consistent: true });
      for (const row of ownedRows) await deleteItem(PK, String(row.SK));
    }
    await deleteItem(PK, documentSK);
  }
});
