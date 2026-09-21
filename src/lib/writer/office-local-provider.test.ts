import assert from "node:assert/strict";
import { test } from "node:test";
import { localProviderMessages, officeLocalModel, officeLocalProvider, streamOfficeLocalTurn } from "./office-local-provider.server.ts";
import { streamWriterTurn, type AgentToolCall, type RouteDecision, type WriterStreamCallbacks } from "./inference.server.ts";

const route: RouteDecision = { model: "us.anthropic.claude-sonnet-5", tier: "main", taskClass: "draft" };
const local = { LOCAL_SYNTHETIC_MODE: "1", NODE_ENV: "development", OFFICE_LOCAL_PROVIDER: "anthropic" };
const evt = (v: unknown) => `data: ${JSON.stringify(v)}\r\n\r\n`;
const beginTool = (i: number, id: string, name = "edit") => evt({ type: "content_block_start", index: i, content_block: { type: "tool_use", id, name, input: {} } });
const args = (i: number, json: string) => evt({ type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: json } });
const close = (i: number) => evt({ type: "content_block_stop", index: i });
const finish = (reason = "tool_use") => evt({ type: "message_delta", delta: { stop_reason: reason }, usage: { output_tokens: 8 } }) + evt({ type: "message_stop" });

function response(data: string): Response {
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    const bytes = new TextEncoder().encode(data);
    for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
    controller.close();
  } }));
}
async function withLocal(fn: () => Promise<void>, provider = "anthropic") {
  const values = {
    ...local, OFFICE_LOCAL_PROVIDER: provider,
    OFFICE_LOCAL_ANTHROPIC_MODEL: "claude-test-model", OFFICE_LOCAL_FIREWORKS_MODEL: "accounts/fireworks/models/test-model",
    ANTHROPIC_API_KEY: "synthetic-placeholder", FIREWORKS_API_KEY: "synthetic-placeholder",
    APP_ENVIRONMENT: "local", AWS_LAMBDA_FUNCTION_NAME: "", AWS_EXECUTION_ENV: "", ECS_CONTAINER_METADATA_URI: "", ECS_CONTAINER_METADATA_URI_V4: "",
  };
  const prior = new Map(Object.keys(values).map(k => [k, process.env[k]]));
  Object.assign(process.env, values);
  try { await fn(); } finally { for (const [k, v] of prior) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
function callbacks() {
  const calls: AgentToolCall[] = [], deltas: string[] = [], stops: string[] = [], usages: unknown[] = [], reasoning: string[] = [];
  const cb: WriterStreamCallbacks = { onDelta: t => deltas.push(t), onReasoning: t => reasoning.push(t), onToolCall: c => calls.push(c), onStopReason: r => stops.push(r), onUsage: u => usages.push(u) };
  return { calls, deltas, stops, usages, reasoning, cb };
}
const request = () => ({ provider: "anthropic" as const, route, profile: "standard" as const, system: "Synthetic test", messages: [{ role: "user" as const, text: "Format fixture" }], tools: [{ name: "edit", description: "Edit fixture", inputSchema: { type: "object" } }], signal: new AbortController().signal });

test("local provider is opt-in and rejected in production or AWS execution", () => {
  assert.equal(officeLocalProvider({}), null);
  assert.equal(officeLocalProvider(local), "anthropic");
  for (const denied of [
    { OFFICE_LOCAL_PROVIDER: "anthropic" }, { ...local, NODE_ENV: "production" },
    { ...local, APP_ENVIRONMENT: "testing" }, { ...local, AWS_LAMBDA_FUNCTION_NAME: "worker" },
    { ...local, AWS_EXECUTION_ENV: "AWS_Lambda_nodejs22.x" }, { ...local, ECS_CONTAINER_METADATA_URI_V4: "http://metadata" },
  ]) assert.throws(() => officeLocalProvider(denied));
  assert.throws(() => officeLocalProvider({ ...local, OFFICE_LOCAL_PROVIDER: "other" }));
});

test("synthetic mode without a provider cannot fall through to Bedrock", () => withLocal(async () => {
  delete process.env.OFFICE_LOCAL_PROVIDER;
  await assert.rejects(streamWriterTurn(request(), callbacks().cb), /AWS fallback is disabled/);
}));

test("direct models require explicit provider IDs and tier mappings", () => {
  assert.throws(() => officeLocalModel("anthropic", route, "standard", undefined, {}), /explicit/);
  assert.throws(() => officeLocalModel("anthropic", route, "standard", route.model, {}), /not interchangeable/);
  assert.throws(() => officeLocalModel("fireworks", route, "standard", "claude-test", {}), /not interchangeable/);
  const env = { OFFICE_LOCAL_ANTHROPIC_MODEL: "claude-main", OFFICE_LOCAL_ANTHROPIC_FAST_MODEL: "claude-fast", OFFICE_LOCAL_ANTHROPIC_THOROUGH_MODEL: "claude-thorough" };
  assert.equal(officeLocalModel("anthropic", { ...route, tier: "fast" }, "standard", undefined, env), "claude-fast");
  assert.equal(officeLocalModel("anthropic", route, "thorough", undefined, env), "claude-thorough");
});

test("message conversion preserves tool IDs/results and images without replaying Bedrock signatures", () => {
  const messages = localProviderMessages("anthropic", [
    { role: "assistant", text: "", reasoning: "sw-opaque-reasoning:invalid", toolCalls: [{ id: "call-1", name: "read", input: { page: 1 } }] },
    { role: "tool", results: [{ id: "call-1", name: "read", output: "fixture", isError: true, images: [{ mime: "image/png", base64: "test" }] }] },
  ]);
  assert.equal(JSON.stringify(messages).includes("opaque"), false);
  assert.deepEqual((messages[0]!.content as unknown[])[0], { type: "tool_use", id: "call-1", name: "read", input: { page: 1 } });
  const result = (messages[1]!.content as Record<string, unknown>[])[0]!;
  assert.equal(result.tool_use_id, "call-1"); assert.equal(result.is_error, true);
  assert.equal((result.content as unknown[]).length, 2);
});

test("Anthropic SSE preserves multiple tools, complete arguments, text and usage across arbitrary chunk boundaries", () => withLocal(async () => {
  const fixture = evt({ type: "message_start", message: { usage: { input_tokens: 17, cache_read_input_tokens: 9 } } })
    + evt({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Working" } })
    + beginTool(1, "one") + args(1, '{"page":') + args(1, "1}") + close(1)
    + beginTool(2, "two") + args(2, '{"page":2}') + close(2) + finish();
  const c = callbacks();
  await streamOfficeLocalTurn({ ...request(), fetchImpl: (async (url, init) => {
    assert.equal(String(url), "https://api.anthropic.com/v1/messages");
    const body = JSON.parse(String(init?.body)); assert.equal(body.model, "claude-test-model"); assert.equal(body.stream, true);
    assert.equal(c.calls.length, 0);
    return response(fixture);
  }) as typeof fetch }, c.cb);
  assert.deepEqual(c.calls.map(x => [x.id, x.input.page]), [["one", 1], ["two", 2]]);
  assert.deepEqual(c.deltas, ["Working"]); assert.deepEqual(c.stops, ["tool_use"]);
  assert.equal((c.usages[0] as { inputTokens: number }).inputTokens, 17);
}));

test("truncated, failed and stopped tool streams cannot dispatch any tool", () => withLocal(async () => {
  for (const fixture of [
    beginTool(0, "one") + args(0, '{"x":1}') + close(0),
    beginTool(0, "one") + args(0, '{"x":1}') + close(0) + finish("max_tokens"),
    beginTool(0, "one") + evt({ type: "error", error: { type: "overloaded_error" } }),
    beginTool(0, "one") + args(0, '{"x":1}') + finish(),
    beginTool(0, "one") + close(0) + beginTool(1, "one") + close(1) + finish(),
  ]) {
    const c = callbacks();
    await assert.rejects(streamOfficeLocalTurn({ ...request(), fetchImpl: (async () => response(fixture)) as typeof fetch }, c.cb));
    assert.equal(c.calls.length, 0);
  }
}));

test("malformed arguments and disallowed tools are explicit input errors, never silent empty actions", () => withLocal(async () => {
  const c = callbacks();
  await streamOfficeLocalTurn({ ...request(), fetchImpl: (async () => response(beginTool(0, "one") + args(0, "[1]") + close(0) + beginTool(1, "two", "delete_everything") + close(1) + finish())) as typeof fetch }, c.cb);
  assert.equal(c.calls.length, 2); assert.ok(c.calls.every(c => c.inputError));
}));

test("Fireworks SSE converts the OpenAI tool protocol and waits for DONE", () => withLocal(async () => {
  const c = callbacks();
  const fixture = evt({ choices: [{ delta: { tool_calls: [{ index: 0, id: "one", function: { name: "edit", arguments: '{"p":' } }] } }] })
    + evt({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] }, finish_reason: "tool_calls" }] })
    + evt({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 3 } }) + "data: [DONE]\r\n\r\n";
  await streamOfficeLocalTurn({ ...request(), provider: "fireworks", fetchImpl: (async () => response(fixture)) as typeof fetch }, c.cb);
  assert.deepEqual(c.calls.map(c => c.input), [{ p: 1 }]); assert.deepEqual(c.stops, ["tool_use"]);
  const incomplete = callbacks();
  await assert.rejects(streamOfficeLocalTurn({ ...request(), provider: "fireworks", fetchImpl: (async () => response(fixture.replace("data: [DONE]\r\n\r\n", ""))) as typeof fetch }, incomplete.cb));
  assert.equal(incomplete.calls.length, 0);
}, "fireworks"));

test("Fireworks follow-ups preserve interleaved reasoning only for the same model in an opaque envelope", () => withLocal(async () => {
  const c = callbacks();
  const fixture = evt({ choices: [{ delta: { reasoning_content: "synthetic-private-continuation" } }] })
    + evt({ choices: [{ delta: { tool_calls: [{ index: 0, id: "one", function: { name: "edit", arguments: "{}" } }] }, finish_reason: "tool_calls" }] }) + "data: [DONE]\r\n\r\n";
  await streamOfficeLocalTurn({ ...request(), provider: "fireworks", fetchImpl: (async () => response(fixture)) as typeof fetch }, c.cb);
  assert.deepEqual(c.deltas, []); assert.match(c.reasoning[0]!, /^sw-opaque-reasoning:/);
  const message = { role: "assistant" as const, text: "", toolCalls: c.calls, reasoning: c.reasoning[0] };
  assert.equal(localProviderMessages("fireworks", [message], "accounts/fireworks/models/test-model")[0]!.reasoning_content, "synthetic-private-continuation");
  assert.equal(localProviderMessages("fireworks", [message], "accounts/fireworks/models/other-model")[0]!.reasoning_content, undefined);
  assert.equal(JSON.stringify(localProviderMessages("anthropic", [message], "claude-test-model")).includes("synthetic-private"), false);
}, "fireworks"));

test("pre-abort and abort while reading a stream dispatch no tools", () => withLocal(async () => {
  let fetched = false;
  await assert.rejects(streamOfficeLocalTurn({ ...request(), signal: AbortSignal.abort(), fetchImpl: (async () => { fetched = true; return response(""); }) as typeof fetch }, callbacks().cb));
  assert.equal(fetched, false);
  const controller = new AbortController(), c = callbacks();
  const promise = streamOfficeLocalTurn({ ...request(), signal: controller.signal, fetchImpl: (async () => new Response(new ReadableStream({ start(stream) {
    stream.enqueue(new TextEncoder().encode(beginTool(0, "one")));
  } }))) as typeof fetch }, c.cb);
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(promise); assert.equal(c.calls.length, 0);
}));

test("provider throttling preserves the status without echoing an upstream error body", () => withLocal(async () => {
  const c = callbacks();
  await assert.rejects(streamOfficeLocalTurn({ ...request(), fetchImpl: (async () => new Response("sensitive upstream request echo", { status: 429 })) as typeof fetch }, c.cb), error => {
    assert.equal((error as { status: number }).status, 429);
    assert.equal((error as Error).message.includes("sensitive"), false);
    return true;
  });
  assert.equal(c.calls.length, 0);
}));
