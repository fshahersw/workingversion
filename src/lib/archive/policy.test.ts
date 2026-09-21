import assert from "node:assert/strict";
import { test } from "node:test";

import { buildUpstreamUrl, isAllowedArchivePath, isAllowedWorkbenchPath, isClosedLayer, provenanceOf } from "./policy.ts";

test("archive allow-list: named endpoints and their segment children pass, anything else is refused", () => {
  for (const ok of ["/api/summary", "/api/documents", "/api/law-outline/children", "/api/area/limitation-periods", "/api/area/courts/item", "/api/regulations/search", "/supplement-files/court_documents/abc.pdf", "/api/mdls/for-judge"]) {
    assert.equal(isAllowedArchivePath(ok), true, ok);
  }
  for (const bad of ["/", "/index.html", "/app.js", "/api", "/api/unknown", "/api/summaryx", "/api/../etc", "/api//documents", "api/documents", "/api/documents ", "/supplement-files"]) {
    assert.equal(isAllowedArchivePath(bad), false, bad);
  }
});

test("workbench allow-list covers search, versions, compare and citations only", () => {
  assert.equal(isAllowedWorkbenchPath("/api/search"), true);
  assert.equal(isAllowedWorkbenchPath("/api/compare"), true);
  assert.equal(isAllowedWorkbenchPath("/api/handoff"), false, "handoff is a server-function concern, not a proxy path");
  assert.equal(isAllowedWorkbenchPath("/index.html"), false);
});

test("upstream url: prefix, path and query preserved; platform-owned keys dropped", () => {
  const url = buildUpstreamUrl("https://testing.seegerweiss.com", "/archive-api", "/api/documents", new URLSearchParams({ q: "limitation AND period", state: "TX", app_key: "x" }));
  assert.equal(url, "https://testing.seegerweiss.com/archive-api/api/documents?q=limitation+AND+period&state=TX");
  assert.equal(buildUpstreamUrl("https://host/", "/workbench-api", "/api/search", { q: "daubert" }), "https://host/workbench-api/api/search?q=daubert");
});

test("provenance is extracted, never invented", () => {
  const p = provenanceOf({ id: "oul:tx-cprc-16.003", source_url: "https://statutes.capitol.texas.gov/…", metadata: { qualification: "publisher snapshot" }, layer: "open_us_law" });
  assert.deepEqual(p, { recordId: "oul:tx-cprc-16.003", layer: "open_us_law", sourceUrl: "https://statutes.capitol.texas.gov/…", capturedAt: null, qualification: "publisher snapshot" });
  assert.deepEqual(provenanceOf(null), { recordId: null, layer: null, sourceUrl: null, capturedAt: null, qualification: null });
});

test("closed layers are recognized by the archive's available:false shape", () => {
  assert.equal(isClosedLayer({ available: false, reason: "hash mismatch" }), true);
  assert.equal(isClosedLayer({ available: true, total: 3 }), false);
  assert.equal(isClosedLayer("nope"), false);
});
