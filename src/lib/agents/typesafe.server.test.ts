import assert from "node:assert/strict";
import { test } from "node:test";

import { choice, noul, noulAnswer, choiceAnswer, systemOne, TYPESAFE_DEFAULT_MODEL, typesafeConfigured } from "./typesafe.server.ts";

const okBody = (answers: Record<string, unknown>, model = "jev-1.13.0") =>
  JSON.stringify({ model, answers, usage: { input_tokens: 120, output_tokens: 12 } });

function withKey<T>(fn: () => Promise<T>): Promise<T> {
  process.env["TYPESAFE_API_KEY"] = "test-key";
  return fn().finally(() => {
    delete process.env["TYPESAFE_API_KEY"];
  });
}

test("no key: never calls the network and reports not configured", async () => {
  delete process.env["TYPESAFE_API_KEY"];
  assert.equal(typesafeConfigured(), false);
  let calls = 0;
  const r = await systemOne({
    purpose: "t",
    state: "x",
    questions: { q: noul("is it?") },
    fetchImpl: (async () => {
      calls++;
      return new Response("{}");
    }) as typeof fetch,
  });
  assert.equal(r, null);
  assert.equal(calls, 0);
});

test("sends the documented request shape and parses typed answers", async () =>
  withKey(async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const r = await systemOne({
      purpose: "t",
      state: { request: { text: "hello" } },
      questions: {
        cls: choice("which?", { a: "A", b: null }),
        flag: noul("is it?"),
      },
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        seen.push({ url: String(url), init: init! });
        return new Response(
          okBody({
            cls: { type: "choice", choice: "a", probabilities: { a: 0.8, b: 0.2 }, confidence: 0.7 },
            flag: { type: "noul", noul: 0.12 },
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.url, "https://api.typesafe.ai/v1/systemone");
    const headers = seen[0]!.init.headers as Record<string, string>;
    assert.equal(headers["Authorization"], "Bearer test-key");
    const body = JSON.parse(String(seen[0]!.init.body)) as Record<string, unknown>;
    assert.equal(body["model"], TYPESAFE_DEFAULT_MODEL);
    assert.deepEqual(body["state"], { request: { text: "hello" } });
    assert.deepEqual((body["questions"] as Record<string, unknown>)["cls"], { type: "choice", instructions: "which?", criteria: { a: "A", b: null } });
    assert.ok(r);
    assert.equal(choiceAnswer(r, "cls")?.choice, "a");
    assert.equal(noulAnswer(r, "flag"), 0.12);
    assert.equal(r.usage.inputTokens, 120);
    assert.equal(r.model, "jev-1.13.0");
  }));

test("hard budget: a slow upstream yields null inside the cap, no retry", async () =>
  withKey(async () => {
    const t0 = Date.now();
    const r = await systemOne({
      purpose: "t",
      state: "x",
      questions: { q: noul("?") },
      timeoutMs: 120,
      fetchImpl: ((_u: unknown, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        })) as typeof fetch,
    });
    assert.equal(r, null);
    assert.ok(Date.now() - t0 < 1_000);
  }));

test("HTTP errors fail open; retries only when asked and only for retryable statuses", async () =>
  withKey(async () => {
    let calls = 0;
    const r429 = await systemOne({
      purpose: "t",
      state: "x",
      questions: { q: noul("?") },
      fetchImpl: (async () => {
        calls++;
        return new Response("{}", { status: 429 });
      }) as typeof fetch,
    });
    assert.equal(r429, null);
    assert.equal(calls, 1, "routers do not retry");
    calls = 0;
    const retried = await systemOne({
      purpose: "t",
      state: "x",
      questions: { q: noul("?") },
      retries: 2,
      timeoutMs: 5_000,
      fetchImpl: (async () => {
        calls++;
        return calls < 3 ? new Response("{}", { status: 503 }) : new Response(okBody({ q: { type: "noul", noul: 0.5 } }));
      }) as typeof fetch,
    });
    assert.equal(calls, 3);
    assert.equal(noulAnswer(retried, "q"), 0.5);
    calls = 0;
    const r401 = await systemOne({
      purpose: "t",
      state: "x",
      questions: { q: noul("?") },
      retries: 2,
      fetchImpl: (async () => {
        calls++;
        return new Response("{}", { status: 401 });
      }) as typeof fetch,
    });
    assert.equal(r401, null);
    assert.equal(calls, 1, "auth errors are not retried");
  }));

test("a response missing a question or with the wrong shape is rejected whole", async () =>
  withKey(async () => {
    const r = await systemOne({
      purpose: "t",
      state: "x",
      questions: { a: noul("?"), b: noul("?") },
      fetchImpl: (async () => new Response(okBody({ a: { type: "noul", noul: 0.9 } }))) as typeof fetch,
    });
    assert.equal(r, null);
    const wrong = await systemOne({
      purpose: "t",
      state: "x",
      questions: { a: choice("?", { x: null }) },
      fetchImpl: (async () => new Response(okBody({ a: { type: "choice", choice: 5 } }))) as typeof fetch,
    });
    assert.equal(wrong, null);
  }));
