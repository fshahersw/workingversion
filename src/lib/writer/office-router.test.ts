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
      task_class: { type: "choice", choice: cls, probabilities: { [cls]: 0.92, inspect: 0.08 }, confidence: 0.9 },
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
    assert.equal(bedrockCalls, 1, "the Bedrock router classed it");
    assert.equal(decision.taskClass, "format");
    // format -> fast tier; Haiku 4.5 is vision-capable, so the image turn may stay there
    assert.match(decision.model, /claude/i);
    assert.ok(decision.tier === "fast" || decision.tier === "main");
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
    assert.equal(cls, "short_edit");
  }));
