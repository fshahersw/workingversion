import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { drainInterpreterStream } from "./code-interpreter-stream";

const response = (...events: unknown[]) => ({
  stream: (async function* () {
    yield* events;
  })(),
});
const result = (taskStatus?: string, isError?: boolean) => ({
  result: {
    content: [{ type: "text", text: "Python output" }],
    ...(taskStatus ? { structuredContent: { taskStatus } } : {}),
    ...(isError !== undefined ? { isError } : {}),
  },
});

describe("Python completion evidence", () => {
  test("returns an immediate result and combines completed stream output", async () => {
    assert.equal((await drainInterpreterStream(response(result()))).isError, false);
    const out = await drainInterpreterStream(response(result("working"), result("completed")));
    assert.equal(out.content.length, 2);
    assert.equal(out.isError, false);
  });
  for (const status of ["failed", "canceled"])
    test(`treats confirmed ${status} as an error even without isError`, async () => {
      assert.equal((await drainInterpreterStream(response(result(status)))).isError, true);
      assert.equal((await drainInterpreterStream(response(result(status, false)))).isError, true);
    });
  test("preserves an explicit tool error even with completed status", async () => {
    assert.equal((await drainInterpreterStream(response(result("completed", true)))).isError, true);
  });
  for (const status of ["submitted", "working", "unknown", "cancelled"])
    test(`rejects unconfirmed status ${status}`, async () => {
      await assert.rejects(drainInterpreterStream(response(result(status))), /completed result/);
    });
  test("does not treat missing results or empty streams as success", async () => {
    for (const resp of [{}, response(), response({ metadata: {} })])
      await assert.rejects(drainInterpreterStream(resp), /completed result/);
  });
  test("rejects service errors even after an apparent result", async () => {
    await assert.rejects(
      drainInterpreterStream(response(result("completed"), { internalServerException: {} })),
      /completion is unconfirmed/,
    );
  });
  test("does not swallow a lost transport after receiving partial output", async () => {
    const stream = (async function* () {
      yield result("working");
      throw new Error("socket lost");
    })();
    await assert.rejects(drainInterpreterStream({ stream }), /socket lost/);
  });
});
