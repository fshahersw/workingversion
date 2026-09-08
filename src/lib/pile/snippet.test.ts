import assert from "node:assert/strict";
import { test } from "node:test";

import { SNIPPET_CHARS, snippet } from "./pile-index.ts";

const filler = (n: number) =>
  Array.from(
    { length: n },
    (_, i) => `Routine sentence number ${i} about nothing in particular.`,
  ).join(" ");

test("snippet centres on the window that covers the most query terms", () => {
  const text = `${filler(12)} The plaintiff first reported the defect to Acme in March 2015. ${filler(
    12,
  )} Acme issued a recall notice after the second complaint about the defect. ${filler(12)}`;
  const out = snippet(text, "recall notice defect complaint");
  assert.match(out, /recall notice/);
  assert.match(out, /second complaint/);
  assert.ok(out.length <= SNIPPET_CHARS + 60, `snippet too long: ${out.length}`);
  assert.doesNotMatch(out, /^[a-z]/, "snippet should start at a sentence, not mid-word");
});

test("snippet is longer than the old fixed cut and ends on a sentence when it can", () => {
  const text = `${filler(30)}`;
  const out = snippet(text, "sentence number");
  assert.ok(out.length > 220);
  assert.ok(/[.]$/.test(out), `expected a sentence end, got: …${out.slice(-40)}`);
});

test("short pages are returned whole; no-match pages show their opening", () => {
  assert.equal(snippet("Exhibit 4. Short page.", "anything"), "Exhibit 4. Short page.");
  const out = snippet(filler(40), "zzz");
  assert.ok(out.startsWith("Routine sentence number 0"));
  assert.ok(out.length <= SNIPPET_CHARS);
});
