import { test } from "node:test";
import assert from "node:assert/strict";
import { asksForRecentSources, searchWindow } from "./search-window.ts";
test("historical authority searches have no publication-date floor", () => {
  for (const query of [
    "Daubert v. Merrell Dow 1993 holding",
    "Erie Railroad v Tompkins",
    "Rule 702 legislative history",
  ]) {
    assert.equal(asksForRecentSources(query), false);
    assert.equal(searchWindow({ unrestricted: !asksForRecentSources(query) }), undefined);
  }
});
test("current-news queries and other research preserve freshness policy and explicit dates", () => {
  const now = Date.parse("2026-09-12T00:00:00Z");
  assert.equal(asksForRecentSources("latest MDL orders this week"), true);
  assert.equal(searchWindow({ now }), "2026-08-13");
  assert.equal(searchWindow({ unrestricted: true, publishedAfter: "1960-01-01" }), "1960-01-01");
});
