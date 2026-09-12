import test from "node:test";
import assert from "node:assert/strict";
import {
  EventQueue,
  initialize,
  toolResult,
  parseClientMessage,
  VOICE_TOOLS,
} from "./protocol.mjs";
const decode = (value) => JSON.parse(new TextDecoder().decode(value.chunk.bytes)).event;
test("Sonic initialization declares distinct input/output rates and task-only tools", async () => {
  const queue = new EventQueue();
  const ids = initialize(queue, { app: "writer", mode: "ask" }, "Prior task");
  const events = queue.items.map(decode);
  assert.equal(events[0].sessionStart.inferenceConfiguration.maxTokens, 1024);
  assert.equal(events[1].promptStart.audioOutputConfiguration.sampleRateHertz, 24000);
  assert.equal(events.at(-1).contentStart.audioInputConfiguration.sampleRateHertz, 16000);
  assert.equal(events.at(-1).contentStart.contentName, ids.audioName);
  assert.match(events[3].textInput.content, /do not grant write access/);
  assert.deepEqual(
    VOICE_TOOLS.map((t) => t.toolSpec.name),
    ["task_status", "start_task", "steer_task", "stop_task"],
  );
  VOICE_TOOLS.forEach((t) =>
    assert.equal(JSON.parse(t.toolSpec.inputSchema.json).additionalProperties, false),
  );
});
test("tool acknowledgments preserve the provider ID and ordered content envelope", () => {
  const queue = new EventQueue();
  toolResult(queue, "prompt", "tool-7", '{"submitted":true}');
  const events = queue.items.map(decode);
  assert.equal(events[0].contentStart.toolResultInputConfiguration.toolUseId, "tool-7");
  assert.equal(events[1].toolResult.content, '{"submitted":true}');
  assert.equal(events[0].contentStart.contentName, events[2].contentEnd.contentName);
});
test("queue wakes a pending reader and abort closes it", async () => {
  const q = new EventQueue();
  const pending = q.next();
  q.push({ sessionStart: {} });
  assert.equal((await pending).done, false);
  const waiting = q.next();
  q.close();
  assert.equal((await waiting).done, true);
});
test("input queues cannot grow without limit", () => {
  const q = new EventQueue();
  for (let i = 0; i < 160; i++) q.push({});
  assert.throws(() => q.push({}), /too slow/);
});
test("audio framing rejects corrupt, oversized, and odd-byte PCM data", () => {
  for (const data of ["garbage", "YQ==", "=".repeat(12001)])
    assert.throws(() => parseClientMessage(JSON.stringify({ type: "audio", data })));
  assert.equal(parseClientMessage('{"type":"audio","data":"AAA="}').data, "AAA=");
});
test("unsupported messages and unbounded tool results are rejected", () => {
  assert.throws(() => parseClientMessage('{"type":"run_python","code":"print(1)"}'));
  assert.throws(() =>
    parseClientMessage(JSON.stringify({ type: "tool_result", id: "1", result: "x".repeat(20001) })),
  );
});
