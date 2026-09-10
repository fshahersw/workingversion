import assert from "node:assert/strict";
import { test } from "node:test";

import type { EvidenceItem, SourceType } from "./frontier-contracts.ts";
import {
  authorityLevelForSource,
  compareAuthority,
  dedupeEvidence,
  evidenceKey,
  isPrimarySource,
  outranks,
  rankEvidence,
} from "./frontier-authority.ts";

function ev(partial: Partial<EvidenceItem> & { id: string }): EvidenceItem {
  return {
    sourceType: "web",
    provider: "test",
    authorityLevel: 5,
    title: partial.id,
    url: `https://example.com/${partial.id}`,
    retrievedAt: "2026-09-10T00:00:00Z",
    supports: [],
    contradicts: [],
    primarySource: false,
    currentVerified: false,
    confidence: 0.5,
    ...partial,
  };
}

test("authorityLevelForSource encodes the §12 hierarchy", () => {
  const expected: Record<SourceType, number> = {
    court_filing: 1,
    court_opinion: 1,
    statute: 1,
    regulation: 1,
    agency: 1,
    government: 1,
    clinical_trial: 2,
    sec_filing: 3,
    news: 3,
    secondary: 4,
    web: 5,
  };
  for (const [source, level] of Object.entries(expected)) {
    assert.equal(authorityLevelForSource(source as SourceType), level, source);
  }
});

test("isPrimarySource: levels 1-2 are primary, 3-5 are not", () => {
  assert.equal(isPrimarySource(1), true);
  assert.equal(isPrimarySource(2), true);
  assert.equal(isPrimarySource(3), false);
  assert.equal(isPrimarySource(4), false);
  assert.equal(isPrimarySource(5), false);
});

test("authority dominates recency: a Level-1 older source outranks a Level-5 newer one", () => {
  const controlling = ev({
    id: "opinion",
    sourceType: "court_opinion",
    authorityLevel: 1,
    eventDate: "2019-01-01",
  });
  const blog = ev({ id: "blog", sourceType: "web", authorityLevel: 5, eventDate: "2026-09-01" });
  assert.equal(outranks(controlling, blog), true);
  assert.equal(compareAuthority(controlling, blog) < 0, true);
  assert.equal(compareAuthority(blog, controlling) > 0, true);
});

test("within a level, currently-verified then newer wins", () => {
  const verified = ev({ id: "a", authorityLevel: 3, currentVerified: true, eventDate: "2026-01-01" });
  const stale = ev({ id: "b", authorityLevel: 3, currentVerified: false, eventDate: "2026-09-01" });
  assert.equal(outranks(verified, stale), true); // verification beats a newer date

  const older = ev({ id: "c", authorityLevel: 3, currentVerified: true, eventDate: "2026-01-01" });
  const newer = ev({ id: "d", authorityLevel: 3, currentVerified: true, eventDate: "2026-09-01" });
  assert.equal(outranks(newer, older), true); // same verification -> newer wins
});

test("rankEvidence sorts strongest-first and does not mutate input", () => {
  const items = [
    ev({ id: "web", authorityLevel: 5 }),
    ev({ id: "opinion", authorityLevel: 1 }),
    ev({ id: "repo", authorityLevel: 2 }),
    ev({ id: "news", authorityLevel: 3 }),
  ];
  const ranked = rankEvidence(items);
  assert.deepEqual(
    ranked.map((r) => r.authorityLevel),
    [1, 2, 3, 5],
  );
  // input untouched
  assert.equal(items[0]!.id, "web");
});

test("evidenceKey prefers hash, then normalized URL, then id", () => {
  assert.equal(evidenceKey(ev({ id: "x", hash: "abc" })), "hash:abc");
  assert.equal(
    evidenceKey(ev({ id: "x", url: "https://www.Example.com/Doc/?utm_source=x" })),
    "url:example.com/doc",
  );
  assert.equal(evidenceKey(ev({ id: "x", url: "" })), "id:x");
});

test("dedupeEvidence collapses same-URL items, keeps higher authority, unions links", () => {
  const url = "https://court.gov/opinion/1";
  const weak = ev({ id: "weak", url, authorityLevel: 5, supports: ["p1"] });
  const strong = ev({
    id: "strong",
    url,
    authorityLevel: 1,
    sourceType: "court_opinion",
    supports: ["p2"],
    contradicts: ["p3"],
  });
  const out = dedupeEvidence([weak, strong]);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.authorityLevel, 1); // higher authority survived
  assert.deepEqual([...out[0]!.supports].sort(), ["p1", "p2"]);
  assert.deepEqual(out[0]!.contradicts, ["p3"]);
});

test("dedupeEvidence keeps distinct sources", () => {
  const a = ev({ id: "a", url: "https://a.gov/1" });
  const b = ev({ id: "b", url: "https://b.gov/1" });
  assert.equal(dedupeEvidence([a, b]).length, 2);
});
