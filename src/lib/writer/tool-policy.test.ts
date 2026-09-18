import assert from "node:assert/strict";
import { test } from "node:test";

import { allowedTools } from "../../writer/shared/sw-policy.ts";
import { allowedToolNames } from "./inference.server.ts";

// The browser filters the tool list it sends (sw-policy.ts) and the server
// enforces its own copy (inference.server.ts). A tool present in one and not
// the other is either invisible to the model or rejected with a 403, so the
// two Writer lists must agree exactly.

const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();

test("Writer write-mode allow-lists match between browser policy and server", () => {
  assert.deepEqual(sorted(allowedTools("write")), sorted(allowedToolNames("write", "writer")));
});

test("Writer read-mode (ask/review) allow-lists match between browser policy and server", () => {
  assert.deepEqual(sorted(allowedTools("ask")), sorted(allowedToolNames("ask", "writer")));
  assert.deepEqual(sorted(allowedTools("review")), sorted(allowedToolNames("review", "writer")));
});

test("research mode is sources-only on both sides", () => {
  const client = sorted(allowedTools("research"));
  assert.deepEqual(client, sorted(allowedToolNames("research", "writer")));
  for (const name of client) assert.ok(!/^(insert_|replace_|apply_|set_|edit_)/.test(name), name);
});

test("the litigation tools are write-only except the Bluebook form check", () => {
  const write = new Set(allowedTools("write"));
  const read = new Set(allowedTools("ask"));
  for (const name of [
    "set_page_setup",
    "set_table_properties",
    "insert_footnote",
    "apply_court_style",
  ]) {
    assert.ok(write.has(name), `${name} missing from write`);
    assert.ok(!read.has(name), `${name} must not be readable-mode`);
  }
  assert.ok(read.has("check_bluebook_citations"));
  assert.ok(write.has("check_bluebook_citations"));
});
