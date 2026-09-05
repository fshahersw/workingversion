import assert from "node:assert/strict";
import { test } from "node:test";

import {
  allStale,
  extractEvidence,
  normalizeUrl,
  queryTerms,
  rankResults,
  wantsRecency,
} from "./web-rank.ts";

const day = 86_400_000;
const NOW = Date.parse("2026-08-31T00:00:00Z");
const iso = (daysAgo: number) => new Date(NOW - daysAgo * day).toISOString().slice(0, 10);
const body = (n: number) =>
  `Item ${n}. The court entered an order in the insulin pricing MDL addressing standing.`;

test("queryTerms drops stopwords and short tokens", () => {
  assert.deepEqual(queryTerms("what is the latest MDL 3080 ruling"), [
    "latest",
    "mdl",
    "3080",
    "ruling",
  ]);
});

test("wantsRecency detects recency intent", () => {
  assert.equal(wantsRecency("what is the current posture"), true);
  assert.equal(wantsRecency("elements of a design defect claim"), false);
});

test("extractEvidence keeps only query-matching sentences", () => {
  const text =
    "This page uses cookies for analytics purposes and nothing else at all here. " +
    "The court granted the motion to dismiss the insulin pricing claims on standing grounds. " +
    "Subscribe to our newsletter for weekly updates from our editorial team today.";
  const out = extractEvidence(text, queryTerms("insulin pricing motion to dismiss"));
  assert.ok(out.includes("insulin pricing"));
  assert.ok(!out.includes("newsletter"));
});

test("extractEvidence returns empty for an off-topic result", () => {
  const out = extractEvidence(
    "A long page about unrelated municipal parking regulations and zoning appeals boards.",
    queryTerms("insulin pricing MDL 3080 settlement"),
  );
  assert.equal(out, "");
});

test("extractEvidence respects the char budget", () => {
  const sentence = "The insulin pricing order addresses standing and preemption issues. ";
  const out = extractEvidence(sentence.repeat(40), queryTerms("insulin pricing order"), 300);
  assert.ok(out.length <= 340, `length ${out.length}`);
});

test("normalizeUrl normalizes scheme, www, slash and tracking params", () => {
  assert.equal(
    normalizeUrl("https://www.Law360.com/articles/123/?utm_source=x"),
    "law360.com/articles/123",
  );
  assert.equal(normalizeUrl("http://law360.com/articles/123"), "law360.com/articles/123");
});

test("rankResults prefers the newer of two equally relevant hits", () => {
  const ranked = rankResults(
    [
      { title: "Old insulin order", url: "https://a.com/old", text: body(1), published: iso(900) },
      { title: "New insulin order", url: "https://b.com/new", text: body(2), published: iso(10) },
    ],
    { query: "insulin pricing order standing", keep: 2, recency: true, now: NOW },
  );
  assert.equal(ranked[0]?.result.url, "https://b.com/new");
});

test("rankResults caps results per domain", () => {
  const results = [1, 2, 3, 4].map((n) => ({
    title: `insulin order ${n}`,
    url: `https://same.com/p${n}`,
    text: body(n),
    published: iso(n),
  }));
  const ranked = rankResults(results, {
    query: "insulin pricing order standing",
    keep: 4,
    recency: true,
    perDomain: 2,
    now: NOW,
  });
  assert.equal(ranked.length, 2);
});

test("rankResults skips URLs already seen in the run", () => {
  const seen = new Set<string>();
  const results = [
    { title: "insulin order", url: "https://a.com/x", text: body(1), published: iso(5) },
    { title: "insulin order two", url: "https://b.com/y", text: body(2), published: iso(6) },
  ];
  const opts = { query: "insulin pricing order standing", keep: 2, recency: true, seen, now: NOW };
  assert.equal(rankResults(results, opts).length, 2);
  assert.equal(rankResults(results, opts).length, 0);
});

test("rankResults drops off-topic results instead of padding context", () => {
  const ranked = rankResults(
    [
      {
        title: "Parking rules",
        url: "https://c.com/parking",
        text: "Municipal parking zoning appeals board hours of operation.",
        published: iso(3),
      },
      { title: "insulin order", url: "https://d.com/order", text: body(9), published: iso(3) },
    ],
    { query: "insulin pricing order standing", keep: 5, recency: true, now: NOW },
  );
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]?.result.url, "https://d.com/order");
});

test("allStale is true when nothing is inside the window", () => {
  const ranked = rankResults(
    [
      {
        title: "insulin order",
        url: "https://a.com/x",
        text: "The insulin pricing order issued in that matter.",
        published: iso(800),
      },
    ],
    { query: "insulin pricing order", keep: 2, recency: true, now: NOW },
  );
  assert.equal(allStale(ranked), true);
});

test("recency cutoff drops stale dated hits when a fresh one exists", () => {
  const ranked = rankResults(
    [
      { title: "insulin order", url: "https://a.com/old", text: body(1), published: iso(800) },
      { title: "insulin order", url: "https://b.com/new", text: body(2), published: iso(30) },
    ],
    { query: "insulin pricing order standing", keep: 5, recency: true, now: NOW },
  );
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]?.result.url, "https://b.com/new");
});

test("recency cutoff is waived when every dated hit is old", () => {
  const ranked = rankResults(
    [{ title: "insulin order", url: "https://a.com/old", text: body(1), published: iso(800) }],
    { query: "insulin pricing order standing", keep: 5, recency: true, now: NOW },
  );
  assert.equal(ranked.length, 1);
});

test("recency cutoff never drops undated results", () => {
  const ranked = rankResults(
    [
      { title: "insulin order undated", url: "https://a.com/u", text: body(1) },
      { title: "insulin order", url: "https://b.com/new", text: body(2), published: iso(30) },
    ],
    { query: "insulin pricing order standing", keep: 5, recency: true, now: NOW },
  );
  assert.equal(ranked.length, 2);
});

test("relevance floor drops weak term overlap", () => {
  const ranked = rankResults(
    [
      {
        title: "Civil procedure notes",
        url: "https://a.com/procedure",
        text: "This overview discusses standing doctrine, pleading standards, and appellate review broadly.",
        published: iso(5),
      },
      { title: "insulin pricing order on standing", url: "https://b.com/x", text: body(2), published: iso(5) },
    ],
    { query: "insulin pricing order standing", keep: 5, recency: true, now: NOW },
  );
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]?.result.url, "https://b.com/x");
});

test("markSuperseded flags the older of two same-subject hits", () => {
  const ranked = rankResults(
    [
      {
        title: "Court denies summary judgment in insulin pricing MDL",
        url: "https://a.com/denial-jan",
        text: "The court denied summary judgment in the insulin pricing MDL on standing grounds.",
        published: iso(200),
      },
      {
        title: "Court denies summary judgment in insulin pricing MDL, appeal follows",
        url: "https://b.com/denial-aug",
        text: "The court denied summary judgment in the insulin pricing MDL; defendants noticed an appeal.",
        published: iso(5),
      },
    ],
    { query: "insulin pricing MDL summary judgment denied", keep: 5, recency: true, now: NOW },
  );
  assert.equal(ranked.length, 2);
  const older = ranked.find((r) => r.result.url.includes("denial-jan"));
  const newer = ranked.find((r) => r.result.url.includes("denial-aug"));
  assert.equal(older?.superseded, true);
  assert.equal(newer?.superseded, false);
});

test("same-subject dedupe keeps one copy of a near-duplicate URL", () => {
  const ranked = rankResults(
    [
      { title: "insulin order", url: "https://a.com/x?utm_source=n", text: body(1), published: iso(5) },
      { title: "insulin order", url: "https://www.a.com/x/", text: body(2), published: iso(6) },
    ],
    { query: "insulin pricing order standing", keep: 5, recency: true, now: NOW },
  );
  assert.equal(ranked.length, 1);
});
