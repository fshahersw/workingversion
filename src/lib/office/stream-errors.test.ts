import assert from "node:assert/strict";
import { test } from "node:test";
import { officeStreamFailure } from "./stream-errors";

test("only transient transport failures are eligible for bounded stream retry", () => {
  for (const status of [400, 401, 403, 413, 422]) assert.equal(officeStreamFailure({ status }).errorCode, undefined);
  for (const status of [500, 502, 503]) assert.equal(officeStreamFailure({ status }).errorCode, "network");
  assert.equal(officeStreamFailure(new TypeError("fetch failed")).errorCode, "network");
  assert.equal(officeStreamFailure(new TypeError("invalid tool schema")).errorCode, undefined);
  assert.equal(officeStreamFailure({ status: 429 }).errorCode, "overloaded");
  assert.equal(officeStreamFailure({ status: 529 }).errorCode, "overloaded");
  assert.equal(officeStreamFailure(new Error("sensitive upstream data"), true).errorCode, "timeout");
});

test("failure text neither echoes secrets nor asserts a document rollback or save", () => {
  for (const failure of [officeStreamFailure(new Error("secret")), officeStreamFailure({ status: 503 })]) {
    assert.doesNotMatch(failure.error, /secret|edits remain|rolled back|saved/i);
  }
});

test("exhausted local provider credits have an actionable non-retryable message", () => {
  const result = officeStreamFailure({ status: 400, diagnostic: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API. secret" } });
  assert.equal(result.errorCode, undefined);
  assert.match(result.error, /insufficient API credits/);
  assert.doesNotMatch(result.error, /secret|Anthropic|rolled back|saved/);
});
