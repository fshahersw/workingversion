import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { SignJWT } from "jose";
import WebSocket from "ws";
import { createVoiceServer } from "./server.mjs";
import { EventQueue } from "./protocol.mjs";
const secret = "test-only-office-voice-secret-never-use-in-production";
async function token(overrides = {}) {
  return new SignJWT({ app: "writer", mode: "ask", document: "test", ...overrides })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("user-1")
    .setIssuer("seegerweiss-platform")
    .setAudience("seegerweiss-office-voice")
    .setJti(crypto.randomUUID())
    .setIssuedAt()
    .setExpirationTime(overrides.exp ?? "60s")
    .sign(new TextEncoder().encode(secret));
}
async function fixture(t) {
  let calls = 0;
  let downstream, upstream;
  const service = createVoiceServer({
    secret,
    origins: ["http://localhost:5176"],
    provider: async (input, signal) => {
      calls++;
      upstream = input;
      downstream = new EventQueue();
      signal.addEventListener("abort", () => downstream.close(), { once: true });
      return downstream;
    },
  });
  await new Promise((resolve) => service.http.listen(0, "127.0.0.1", resolve));
  t.after(() => service.close());
  const connect = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${service.http.address().port}/voice`, {
      origin: "http://localhost:5176",
    });
    const messages = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await once(ws, "open");
    t.after(() => ws.terminate());
    return { ws, messages };
  };
  return {
    connect,
    service,
    calls: () => calls,
    output: (event) => downstream.push(event),
    input: () => upstream,
  };
}
const until = async (predicate) => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("Condition did not resolve");
};
test("a valid signed binding connects; closing aborts the provider", async (t) => {
  const f = await fixture(t);
  const { ws, messages } = await f.connect();
  ws.send(JSON.stringify({ type: "auth", token: await token() }));
  await until(() => messages.some((m) => m.type === "ready"));
  assert.equal(f.calls(), 1);
  ws.close();
  await until(() => f.input().closed);
});
test("invalid, expired, and disallowed-mode grants never call AWS", async (t) => {
  const f = await fixture(t);
  for (const grant of ["bad-token", await token({ exp: 1 }), await token({ mode: "research" })]) {
    const { ws, messages } = await f.connect();
    ws.send(JSON.stringify({ type: "auth", token: grant }));
    await once(ws, "close");
    assert.equal(messages[0].type, "error");
  }
  assert.equal(f.calls(), 0);
});
test("one grant cannot open two connections", async (t) => {
  const f = await fixture(t),
    grant = await token();
  const a = await f.connect();
  a.ws.send(JSON.stringify({ type: "auth", token: grant }));
  await until(() => a.messages.some((m) => m.type === "ready"));
  const b = await f.connect();
  b.ws.send(JSON.stringify({ type: "auth", token: grant }));
  await once(b.ws, "close");
  assert.equal(f.calls(), 1);
});
test("untrusted browser origins are rejected before upgrade", async (t) => {
  const f = await fixture(t);
  const ws = new WebSocket(`ws://127.0.0.1:${f.service.http.address().port}/voice`, {
    origin: "https://untrusted.example",
  });
  const [error] = await once(ws, "error");
  assert.match(error.message, /403/);
  assert.equal(f.calls(), 0);
});
test("tool results correlate once; late acknowledgments cannot duplicate them", async (t) => {
  const f = await fixture(t);
  const { ws, messages } = await f.connect();
  ws.send(JSON.stringify({ type: "auth", token: await token() }));
  await until(() => messages.some((m) => m.type === "ready"));
  f.output({
    toolUse: {
      toolUseId: "tool-1",
      contentName: "content-1",
      toolName: "task_status",
      content: "{}",
    },
  });
  f.output({ contentEnd: { type: "TOOL", contentName: "content-1" } });
  await until(() => messages.some((m) => m.type === "tool"));
  const ack = JSON.stringify({ type: "tool_result", id: "tool-1", result: '{"busy":true}' });
  ws.send(ack);
  ws.send(ack);
  await until(() => f.input().items.length === 9);
  const resultEvents = f
    .input()
    .items.map((v) => JSON.parse(new TextDecoder().decode(v.chunk.bytes)).event)
    .filter((e) => e.toolResult);
  assert.equal(resultEvents.length, 1);
});
