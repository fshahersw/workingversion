import assert from "node:assert/strict";
import { test } from "node:test";

import {
  allStale,
  cosineSim,
  distinctiveTerms,
  extractEvidence,
  fuseRankings,
  normalizeUrl,
  queryTerms,
  rankResults,
  semanticOrder,
  wantsRecency,
} from "./web-rank.ts";

test("fuseRankings: an item ranked well by both lists beats one ranked well by only one", () => {
  const items = new Map([
    ["a", "A"],
    ["b", "B"],
    ["c", "C"],
    ["d", "D"],
  ]);
  // Lexical says a > b > c > d; semantic says b > c > a (d unscored).
  const fused = fuseRankings(items, [["a", "b", "c", "d"], ["b", "c", "a"]]);
  assert.deepEqual(
    fused.map((f) => f.item),
    ["B", "A", "C", "D"],
  );
  // Ranks are recorded per list; -1 marks "absent from that list".
  const d = fused.find((f) => f.item === "D")!;
  assert.deepEqual(d.ranks, [3, -1]);
});

test("fuseRankings with a single list is that list's order", () => {
  const items = new Map([
    ["x", 1],
    ["y", 2],
    ["z", 3],
  ]);
  assert.deepEqual(fuseRankings(items, [["z", "x", "y"]]).map((f) => f.item), [3, 1, 2]);
});

test("fuseRankings ignores keys that are not in the item set and breaks ties on the first list", () => {
  const items = new Map([
    ["a", "A"],
    ["b", "B"],
  ]);
  // Both lists rank a and b symmetrically opposite: fused scores tie; first list wins.
  const fused = fuseRankings(items, [["a", "b", "ghost"], ["b", "a"]]);
  assert.deepEqual(fused.map((f) => f.item), ["A", "B"]);
});

test("fuseRankings missingRank 'listLength': a partial semantic list does not halve the unscored items", () => {
  const items = new Map([
    ["a", "A"],
    ["b", "B"],
    ["c", "C"],
    ["d", "D"],
    ["e", "E"],
  ]);
  const lexical = ["a", "b", "c", "d", "e"];
  // Only two candidates embedded before the cap; a, b, c were never scored.
  const semantic = ["d", "e"];
  // Default RRF: the unscored trio forfeits the semantic axis and sinks to the
  // bottom purely for being unscored, below the two that happened to embed.
  assert.deepEqual(
    fuseRankings(items, [lexical, semantic]).map((f) => f.item),
    ["D", "E", "A", "B", "C"],
  );
  // listLength: an unscored item ranks as if just after the semantic list's
  // last entry. The lexical leader keeps its place; d still climbs above b on
  // genuine semantic evidence; e (last on both axes) stays last.
  const fused = fuseRankings(items, [lexical, semantic], { missingRank: "listLength" });
  assert.deepEqual(
    fused.map((f) => f.item),
    ["A", "D", "B", "C", "E"],
  );
  // Unscored items keep their relative lexical order among themselves.
  const pos = (v: string) => fused.findIndex((f) => f.item === v);
  assert.ok(pos("A") < pos("B") && pos("B") < pos("C"));
  // ranks still report the actual positions; -1 marks "absent from that list".
  assert.deepEqual(fused.find((f) => f.item === "A")!.ranks, [0, -1]);
  assert.deepEqual(fused.find((f) => f.item === "D")!.ranks, [3, 0]);
});

test("fuseRankings still accepts the positional k and the k option interchangeably", () => {
  const items = new Map([
    ["a", "A"],
    ["b", "B"],
    ["c", "C"],
  ]);
  const orders = [["a", "b", "c"], ["c", "b", "a"]];
  assert.deepEqual(
    fuseRankings(items, orders, 60).map((f) => f.fused),
    fuseRankings(items, orders, { k: 60 }).map((f) => f.fused),
  );
  assert.deepEqual(
    fuseRankings(items, orders, 60).map((f) => f.fused),
    fuseRankings(items, orders).map((f) => f.fused),
  );
  // A smaller k widens the score gap between adjacent ranks.
  const sharp = fuseRankings(items, [["a", "b", "c"]], 1);
  const smooth = fuseRankings(items, [["a", "b", "c"]], 60);
  assert.deepEqual(sharp.map((f) => f.item), ["A", "B", "C"]);
  assert.ok(sharp[0]!.fused - sharp[1]!.fused > smooth[0]!.fused - smooth[1]!.fused);
});

test("semanticOrder sorts by cosine similarity to the query vector and omits unscored items", () => {
  const q = [1, 0, 0];
  const vectors = new Map<string, number[]>([
    ["far", [0, 1, 0]],
    ["near", [0.9, 0.1, 0]],
    ["mid", [0.5, 0.5, 0]],
  ]);
  assert.deepEqual(semanticOrder(q, vectors), ["near", "mid", "far"]);
  assert.ok(cosineSim([1, 0], [1, 0]) > 0.999);
  assert.equal(cosineSim([], [1, 2]), 0);
});

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

test("distinctiveTerms returns a short query unchanged", () => {
  assert.deepEqual(distinctiveTerms("medroxyprogesterone meningioma EMA", 4), [
    "medroxyprogesterone",
    "meningioma",
    "ema",
  ]);
});

test("distinctiveTerms drops generic filler and month names, keeps identifiers + proper nouns", () => {
  // The exact failing screenshot query: 9 ANDed content words -> 1 result.
  const lean = distinctiveTerms(
    "JCCP bellwether trial October 2026 November 2026 schedule MDL 3047",
    4,
  );
  // "trial", "october", "november", "schedule" are generic/temporal filler and drop out.
  assert.ok(!lean.includes("trial"));
  assert.ok(!lean.includes("october"));
  assert.ok(!lean.includes("november"));
  assert.ok(!lean.includes("schedule"));
  // Identifiers (year, MDL number) and the distinctive proper noun survive.
  assert.ok(lean.includes("2026"));
  assert.ok(lean.includes("3047"));
  assert.ok(lean.includes("jccp") || lean.includes("bellwether"));
  assert.ok(lean.length <= 4);
});

test("distinctiveTerms dropYears produces a different, date-relaxed combo", () => {
  const q = "JCCP bellwether trial October 2026 November 2026 schedule MDL 3047";
  const a = distinctiveTerms(q, 4);
  const b = distinctiveTerms(q, 4, { dropYears: true });
  assert.ok(a.includes("2026")); // precise anchor keeps the year
  assert.ok(!b.includes("2026")); // relaxed angle drops the bare year
  assert.ok(b.includes("3047")); // ...but keeps the docket/MDL number
  assert.notDeepEqual(a, b); // the two parallel combos genuinely differ
});

test("distinctiveTerms preserves capitalized proper nouns over generic words", () => {
  const lean = distinctiveTerms("Meta YouTube bellwether trial status update Kuhl", 4);
  assert.ok(lean.includes("meta"));
  assert.ok(lean.includes("youtube"));
  assert.ok(lean.includes("kuhl"));
  assert.ok(!lean.includes("status"));
  assert.ok(!lean.includes("update"));
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
