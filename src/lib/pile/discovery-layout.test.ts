import assert from "node:assert/strict";
import { test } from "node:test";

import { parseLayoutPreference } from "./discovery-layout.ts";

test("layout preferences preserve explicit collapsed and expanded states", () => {
  assert.equal(parseLayoutPreference("true", false), true);
  assert.equal(parseLayoutPreference("false", true), false);
});

test("layout preferences use the caller fallback for missing or invalid values", () => {
  assert.equal(parseLayoutPreference(null, false), false);
  assert.equal(parseLayoutPreference(undefined, true), true);
  assert.equal(parseLayoutPreference("1", false), false);
});
