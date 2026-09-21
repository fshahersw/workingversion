import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyTask, jevRouterEligible, routeTurn, type AgentMessage } from "./inference.server.ts";

// An instruction no lexical heuristic classes, so the model router runs.
const INSTRUCTION = "Tidy up the exhibit schedule so its columns line up with the caption";
const PNG = { base64: "iVBORw0KGgo=", mime: "image/png" };

const jevBody = (cls: string) =>
  JSON.stringify({
    model: "jev-1.13.0",
    answers: {
      task_class: { type: "choice", choice: cls, probabilities: { inspect: 0.08, format: 0, short_edit: 0, draft: 0, analyze: 0, [cls]: 0.92 }, confidence: 0.9 },
      changes_document: { type: "noul", noul: 0.95 },
      needs_legal_judgment: { type: "noul", noul: 0.02 },
    },
    usage: { input_tokens: 900, output_tokens: 20 },
  });

/** Stub the network: count TypeSafe calls, fail anything else fast. */
function withStubs<T>(fn: (calls: { typesafe: number }) => Promise<T>): Promise<T> {
  const calls = { typesafe: 0 };
  const realFetch = globalThis.fetch;
  process.env["TYPESAFE_API_KEY"] = "test-key";
  process.env["OFFICE_ROUTER"] = "typesafe";
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("api.typesafe.ai")) {
      calls.typesafe++;
      return new Response(jevBody("format"), { status: 200 });
    }
    return new Response("{}", { status: 500 });
  }) as typeof fetch;
  return fn(calls).finally(() => {
    globalThis.fetch = realFetch;
    delete process.env["TYPESAFE_API_KEY"];
    delete process.env["OFFICE_ROUTER"];
  });
}

test("jevRouterEligible: text-only turns in a non-default mode only", () => {
  assert.equal(jevRouterEligible("typesafe", true, false), true);
  assert.equal(jevRouterEligible("shadow", true, false), true);
  assert.equal(jevRouterEligible("typesafe", true, true), false, "image turn");
  assert.equal(jevRouterEligible("shadow", true, true), false, "no shadow verdict on an image turn either");
  assert.equal(jevRouterEligible("bedrock", true, false), false);
  assert.equal(jevRouterEligible("typesafe", false, false), false, "no key");
});

test("an image-bearing office turn bypasses Jev and lands on a vision-capable tier", () =>
  withStubs(async (calls) => {
    let bedrockCalls = 0;
    const messages: AgentMessage[] = [{ role: "user", text: `${INSTRUCTION} (image A)`, images: [PNG] }];
    const decision = await routeTurn({
      app: "writer",
      profile: "standard",
      messages,
      // vision-capable Bedrock router stands in; it classes the turn as format
      bedrockRouter: async () => {
        bedrockCalls++;
        return "format";
      },
    });
    assert.equal(calls.typesafe, 0, "Jev never saw the image turn");
    assert.equal(bedrockCalls, 0, "neither text-only routing payload can assess the image");
    assert.equal(decision.taskClass, null);
    assert.match(decision.model, /claude/i);
    assert.equal(decision.tier, "main");
  }));

test("a text-only office turn still goes through Jev", () =>
  withStubs(async (calls) => {
    let bedrockCalls = 0;
    const messages: AgentMessage[] = [{ role: "user", text: `${INSTRUCTION} (text B)` }];
    const decision = await routeTurn({
      app: "writer",
      profile: "standard",
      messages,
      bedrockRouter: async () => {
        bedrockCalls++;
        return "inspect";
      },
    });
    assert.equal(calls.typesafe, 1, "Jev classed the text-only turn");
    assert.equal(bedrockCalls, 0, "no Bedrock router round trip when Jev has an opinion");
    assert.equal(decision.taskClass, "format");
  }));

test("images arriving through a tool result also bypass Jev", () =>
  withStubs(async (calls) => {
    const cls = await classifyTask("slides", `${INSTRUCTION} (tool image C)`, undefined, {
      hasImages: true,
      bedrockRouter: async () => "short_edit",
    });
    assert.equal(calls.typesafe, 0);
    assert.equal(cls, null);
  }));

test("legal questions and a heavy later line cannot use the old first-line down-route", () => withStubs(async calls => {
  assert.equal(await classifyTask("writer", "Which of these cases still supports our position?"), "analyze");
  assert.equal(await classifyTask("writer", "Bold the selection.\nThen assess the preemption argument."), "analyze");
  assert.equal(calls.typesafe, 0, "a conservative promotion needs no inference");
}));

test("exact formatting only skips inference for the entire request", () => withStubs(async calls => {
  assert.equal(await classifyTask("writer", "Bold the selection"), "format");
  assert.equal(calls.typesafe, 0);
  await classifyTask("writer", "Bold the selection and rewrite this conclusion", undefined, { contextKey: "exact-test" });
  assert.equal(calls.typesafe, 1);
}));

test("cache separates context, mode, model, image presence and the complete request", () => withStubs(async calls => {
  const instruction = `${INSTRUCTION} cache context`;
  await classifyTask("writer", instruction, undefined, { contextKey: "revision1" });
  await classifyTask("writer", instruction, undefined, { contextKey: "revision1" });
  assert.equal(calls.typesafe, 1);
  await classifyTask("writer", instruction, undefined, { contextKey: "revision2" });
  assert.equal(calls.typesafe, 2);
  assert.equal(await classifyTask("writer", instruction, undefined, { contextKey: "revision1", hasImages: true }), null);
  process.env.TYPESAFE_MODEL = "jev-latest";
  try { await classifyTask("writer", instruction, undefined, { contextKey: "revision1" }); } finally { delete process.env.TYPESAFE_MODEL; }
  assert.equal(calls.typesafe, 3);
  process.env.OFFICE_ROUTER = "bedrock";
  assert.equal(await classifyTask("writer", instruction, undefined, { contextKey: "revision1", bedrockRouter: async () => "draft" }), "draft");
  process.env.OFFICE_ROUTER = "typesafe";
  const prefix = `${INSTRUCTION}\n${"x".repeat(4_100)}`;
  await classifyTask("writer", `${prefix} suffix A`);
  await classifyTask("writer", `${prefix} suffix B`);
  assert.equal(calls.typesafe, 5, "different tails cannot collide in the cache");
  assert.equal(await classifyTask("writer", "x".repeat(12_001)), null);
  assert.equal(await classifyTask("writer", instruction, AbortSignal.abort()), null);
}));

test("expired routing decisions are classified again", () => withStubs(async calls => {
  const now = Date.now;
  try {
    const first = now(); Date.now = () => first;
    await classifyTask("writer", `${INSTRUCTION} ttl`);
    Date.now = () => first + 300_001;
    await classifyTask("writer", `${INSTRUCTION} ttl`);
    assert.equal(calls.typesafe, 2);
  } finally { Date.now = now; }
}));

test("Jev failure goes directly to main without a second model call", () => withStubs(async () => {
  globalThis.fetch = (async () => new Response("{}", { status: 503 })) as typeof fetch;
  let fallback = 0;
  const taskClass = await classifyTask("pdf", "Review the exhibit annotations", undefined, {
    bedrockRouter: async () => { fallback++; return "inspect"; },
  });
  assert.equal(taskClass, null); assert.equal(fallback, 0);
}));

test("failed tools promote later rounds to main and prevent repeating a weak tier", () => withStubs(async calls => {
  const decision = await routeTurn({ app: "writer", profile: "standard", messages: [
    { role: "user", text: "Bold the selection" },
    { role: "tool", results: [{ id: "t1", name: "apply_ops", output: "Stale revision", isError: true }] },
  ] });
  assert.equal(decision.tier, "main"); assert.equal(calls.typesafe, 0);
}));
