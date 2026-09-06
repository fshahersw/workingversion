import assert from "node:assert/strict";
import { test } from "node:test";

import { startSseHeartbeat } from "../sse.server.ts";

test("SSE heartbeat emits comments and stops cleanly", async () => {
  const comments: string[] = [];
  const stop = startSseHeartbeat((comment) => comments.push(comment), undefined, 5);
  await new Promise((resolve) => setTimeout(resolve, 18));
  assert.ok(comments.length >= 2);
  assert.ok(comments.every((comment) => comment === ": keep-alive\n\n"));

  stop();
  const stoppedAt = comments.length;
  await new Promise((resolve) => setTimeout(resolve, 12));
  assert.equal(comments.length, stoppedAt);
});

test("SSE heartbeat stops when the request aborts", async () => {
  const controller = new AbortController();
  let beats = 0;
  startSseHeartbeat(() => {
    beats += 1;
  }, controller.signal, 5);
  controller.abort();
  const stoppedAt = beats;
  await new Promise((resolve) => setTimeout(resolve, 12));
  assert.equal(beats, stoppedAt);
});
