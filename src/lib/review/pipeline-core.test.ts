import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EXTRACT_CHAIN,
  MODELS,
  VERIFY_CHAIN,
  backoffMs,
  checkCitations,
  createModelCircuit,
  firstJsonObject,
  isFallbackStatus,
  isRetryableStatus,
  needsNoThink,
  normalizeForMatch,
  normalizeValue,
  parseConfidence,
  quoteOnPage,
  stripThinking,
  transportFor,
} from "./pipeline-core.ts";

test("stripThinking drops Nemotron think blocks and fences", () => {
  const raw = `<think>let me look</think>\n\`\`\`json\n{"status":"answered"}\n\`\`\``;
  assert.equal(stripThinking(raw), '{"status":"answered"}');
});

test("firstJsonObject survives thinking tokens and prose around JSON", () => {
  const raw = `<think>reasoning</think>\nHere you go:\n{"status":"answered","value":"Yes"}\nThanks.`;
  const parsed = firstJsonObject(raw);
  assert.ok(parsed);
  assert.equal(parsed["status"], "answered");
  assert.equal(parsed["value"], "Yes");
});

test("firstJsonObject tracks braces inside strings", () => {
  const parsed = firstJsonObject(`{"value":"a {nested} brace","status":"answered"}`);
  assert.ok(parsed);
  assert.equal(parsed["value"], "a {nested} brace");
});

test("quoteOnPage matches exact, normalized, and fuzzy OCR quotes", () => {
  const page = "The Agreement may be terminated by either Party on thirty (30) days' notice.";
  assert.equal(
    quoteOnPage("The Agreement may be terminated by either Party on thirty (30) days' notice.", page),
    "exact",
  );
  assert.equal(
    quoteOnPage("the agreement may be terminated by either party on thirty (30) days’ notice.", page),
    "normalized",
  );
  assert.equal(
    quoteOnPage("The Agreement may be tterminated by either Party on thirty (30) days' notice.", page),
    "fuzzy",
  );
  assert.equal(quoteOnPage("This contract is governed by Delaware law.", page), "none");
  assert.equal(quoteOnPage("Yes", page), "none");
});

test("checkCitations keeps quotes that appear and drops invented ones", () => {
  const pages = [
    { page: 3, text: "Governing Law. This Agreement is governed by the laws of New York." },
    { page: 7, text: "Notice. Notices shall be sent by certified mail." },
  ];
  const { verified, rejected } = checkCitations(
    [
      { page: 3, quote: "This Agreement is governed by the laws of New York." },
      { page: 7, quote: "the parties hereby waive a jury trial" },
      { page: 99, quote: "Governing Law." },
    ],
    pages,
    "spa.pdf",
  );
  assert.equal(verified.length, 1);
  assert.equal(verified[0]?.page, 3);
  assert.equal(verified[0]?.fileName, "spa.pdf");
  assert.equal(rejected.length, 2);
  assert.ok(rejected.some((r) => r.reason.includes("not found")));
  assert.ok(rejected.some((r) => r.reason.includes("not provided")));
});

test("normalizeValue maps yes/no, numbers, and select options", () => {
  assert.equal(normalizeValue({ value: "yep" }, "yes_no", []), "Yes");
  assert.equal(normalizeValue({ value: "nope" }, "yes_no", []), "No");
  assert.equal(normalizeValue({ value: "maybe" }, "yes_no", []), "Unclear");
  assert.equal(normalizeValue({ value: "$1,250", unit: "USD" }, "number", []), "1250 USD");
  assert.equal(normalizeValue({ value: "new york" }, "select", ["New York", "Delaware"]), "New York");
  assert.deepEqual(normalizeValue({ value: "A; B; A" }, "list", []), ["A", "B", "A"]);
  assert.deepEqual(
    normalizeValue({ value: ["A", "B", "A"] }, "multi_select", ["A", "B"]),
    ["A", "B"],
  );
});

test("fallback classifier covers Bedrock first-use and region errors", () => {
  for (const status of [400, 403, 404, 408, 429, 500, 503]) {
    assert.equal(isFallbackStatus(status), true, `status ${status}`);
  }
  assert.equal(isFallbackStatus(401), false);
  assert.equal(isFallbackStatus(422), false);
});

test("transport and no-think routing match the Bedrock model families", () => {
  assert.equal(transportFor("nvidia.nemotron-super-3-120b"), "converse");
  assert.equal(transportFor(MODELS.gemma), "converse");
  assert.equal(transportFor(MODELS.kimi), "converse");
  assert.equal(needsNoThink("nvidia.nemotron-nano-3-30b"), true);
  assert.equal(needsNoThink(MODELS.gemma), false);
});

test("parseConfidence defaults unknown values to medium", () => {
  assert.equal(parseConfidence("HIGH"), "high");
  assert.equal(parseConfidence("low"), "low");
  assert.equal(parseConfidence("whatever"), "medium");
});

test("normalizeForMatch folds curly quotes and whitespace", () => {
  assert.equal(normalizeForMatch("  “Hello”\u00a0world  "), '"hello" world');
});

test("extract and verify chains skip Super and start on Nano / Gemma", () => {
  assert.deepEqual([...EXTRACT_CHAIN], [MODELS.nemotronNano, MODELS.gemma]);
  assert.deepEqual([...VERIFY_CHAIN], [MODELS.gemma, MODELS.nemotronNano]);
  assert.ok(!EXTRACT_CHAIN.includes(MODELS.nemotronSuper));
});

test("retryable statuses are the transient ones", () => {
  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(503), true);
  assert.equal(isRetryableStatus(408), true);
  assert.equal(isRetryableStatus(400), false);
  assert.equal(isRetryableStatus(403), false);
});

test("backoffMs honors retry-after and stays inside the cap", () => {
  assert.equal(backoffMs(0, 400, 8_000, 1_500), 1_500);
  assert.equal(backoffMs(9, 400, 8_000, 99_000), 8_000);
  const n = backoffMs(0, 400, 8_000);
  assert.ok(n >= 400 && n <= 600);
});

test("circuit opens on access errors and cools down on 429", () => {
  let t = 1_000;
  const c = createModelCircuit(() => t);
  const model = MODELS.nemotronSuper;
  assert.equal(c.isOpen(model), false);
  c.recordFailure(model, 400);
  assert.equal(c.isOpen(model), true);
  t += 9 * 60_000;
  assert.equal(c.isOpen(model), true);
  t += 2 * 60_000;
  assert.equal(c.isOpen(model), false);

  const nano = MODELS.nemotronNano;
  c.recordFailure(nano, 429);
  assert.equal(c.isOpen(nano), true);
  t += 9_000;
  assert.equal(c.isOpen(nano), false);
  c.recordFailure(nano, 502);
  c.recordFailure(nano, 502);
  assert.equal(c.isOpen(nano), false);
  c.recordFailure(nano, 502);
  assert.equal(c.isOpen(nano), true);
  c.recordSuccess(nano);
  assert.equal(c.isOpen(nano), false);
});
