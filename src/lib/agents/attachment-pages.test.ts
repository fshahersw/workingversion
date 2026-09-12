import { test } from "node:test";
import assert from "node:assert/strict";
import { splitExtraction, joinExtraction } from "./attachment-pages.ts";
test("large extraction retains its tail and Unicode at page boundaries", () => {
  const text = "x".repeat(63_999) + "🙂" + "a".repeat(2_100_000) + "LAST EXHIBIT";
  const pages = splitExtraction(text);
  assert.ok(pages.length > 30);
  assert.equal(joinExtraction(pages, text.length, pages.length), text);
  for (const p of pages) assert.equal(Buffer.from(p).toString("utf8"), p);
});
test("missing or truncated text is rejected", () => {
  assert.throws(() => joinExtraction(["one"], 10, 2), /incomplete/);
  assert.throws(() => joinExtraction(["short"], 20, 1), /incomplete/);
});
