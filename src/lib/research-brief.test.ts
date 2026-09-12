import assert from "node:assert/strict";
import { test } from "node:test";

import { headlinePrompt, hostOfUrl, topicsFromTitles } from "./research-brief.ts";

test("topics skip greetings and empty titles, keep distinctive matter terms", () => {
  const topics = topicsFromTitles([
    "hello",
    "New research",
    "When is the next trial in the Depo-Provera litigation?",
    "Paraquat MDL 3004 bellwether schedule",
    "Depo-Provera next trial date",
  ]);
  assert.equal(topics.length, 2);
  assert.match(topics[0]!, /Depo-Provera/i);
  assert.match(topics[1]!, /Paraquat/i);
  assert.match(topics[1]!, /3004/);
});

test("topics strip emails and cap at three", () => {
  const topics = topicsFromTitles([
    "talc ovarian cancer 702 a@b.com",
    "Roundup NHL Daubert",
    "AFFF settlement matrix",
    "Zantac MDL remand",
  ]);
  assert.equal(topics.length, 3);
  assert.ok(!topics.join(" ").includes("@"));
});

test("topics name the matter, never the question's opening verb", () => {
  // Conversation titles are the attorney's question truncated, so they almost
  // always open on a capitalized verb or question word. Those used to become the
  // topic — and then the news query.
  const cases: [string, RegExp][] = [
    ["Compare Rule 702 rulings across the hernia mesh MDLs", /hernia mesh/i],
    ["Summarize the latest CMO in the Bard PowerPort MDL", /^Bard PowerPort$/],
    ["What is the next bellwether trial date in Depo-Provera MDL 3140", /^Depo-Provera MDL 3140$/],
    ["Draft a memo on Ozempic gastroparesis causation science", /Ozempic/],
    ["Is the Suboxone dental decay MDL still accepting cases", /Suboxone/],
    ["Explain the discovery rule for talc claims in New Jersey", /talc/i],
    ["Tepezza hearing loss litigation status", /^Tepezza$/],
    ["Camp Lejeune water contamination deadlines", /^Camp Lejeune$/],
    ["What did Judge Rodgers hold on general causation", /causation/i],
    ["Give me the trial schedule for the AFFF litigation", /^AFFF$/],
  ];
  for (const [title, expected] of cases) {
    const topic = topicsFromTitles([title], 1)[0];
    assert.ok(topic, title);
    assert.match(topic, expected, title);
    assert.ok(
      !/^(Compare|Summarize|Draft|Explain|Give|Judge|Rule|Statute|What|When|New)\b/.test(topic),
      `${title} -> ${topic}`,
    );
  }
});

test("a title with nothing distinctive yields no topic at all", () => {
  // One generic term is a worse news query than no card.
  assert.deepEqual(topicsFromTitles(["status"]), []);
  assert.deepEqual(topicsFromTitles(["What is the latest?"]), []);
  assert.deepEqual(topicsFromTitles(["New research", "hello", ""]), []);
});

test("headline prompt asks about the development without inventing facts", () => {
  const prompt = headlinePrompt("Paraquat MDL", "Court sets 2027 bellwether");
  assert.match(prompt, /Paraquat MDL/);
  assert.match(prompt, /primary source/);
  assert.equal(hostOfUrl("https://www.law360.com/articles/x"), "law360.com");
});

import {
  canonicalHeadlineUrl,
  headlineAgeDays,
  headlineHostRank,
  matchesTopic,
  mergeHeadlineCandidates,
  selectHeadlines,
  type HeadlineCandidate,
} from "./research-brief.ts";

const NOW = Date.parse("2026-09-12T12:00:00Z");
const c = (
  backend: HeadlineCandidate["backend"],
  rank: number,
  url: string,
  extra: Partial<HeadlineCandidate> = {},
): HeadlineCandidate => ({ backend, rank, url, title: `${backend} ${rank}`, snippet: "", ...extra });

test("canonical URL ignores tracking noise, www, hash, and trailing slash", () => {
  const a = canonicalHeadlineUrl("https://www.Law360.com/articles/1/?utm_source=x&fbclid=y#top");
  const b = canonicalHeadlineUrl("http://law360.com/articles/1");
  assert.equal(a, b);
  assert.equal(a, "https://law360.com/articles/1");
  assert.equal(headlineAgeDays("2026-09-10T12:00:00Z", NOW), 2);
  assert.equal(headlineAgeDays(undefined, NOW), null);
  assert.equal(headlineAgeDays("not a date", NOW), null);
});

test("merge dedupes the same story across backends and fills the image gap", () => {
  const merged = mergeHeadlineCandidates(
    [
      [c("tavily", 1, "https://www.reuters.com/legal/a?utm_campaign=z", { snippet: "Tavily summary", published: "2026-09-11" })],
      [c("firecrawl", 1, "https://reuters.com/legal/a", { imageUrl: "https://img/a.jpg" })],
    ],
    { now: NOW },
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.backend, "tavily", "first-seen copy wins the identity");
  assert.equal(merged[0]!.snippet, "Tavily summary");
  assert.equal(merged[0]!.imageUrl, "https://img/a.jpg", "image borrowed from the other backend");
  assert.equal(merged[0]!.published, "2026-09-11");
});

test("merge interleaves backends by rank and drops stale dated items", () => {
  const merged = mergeHeadlineCandidates(
    [
      [c("tavily", 1, "https://a/1"), c("tavily", 2, "https://a/2"), c("tavily", 3, "https://a/old", { published: "2026-07-01" })],
      [c("firecrawl", 1, "https://b/1"), c("firecrawl", 2, "https://b/2")],
    ],
    { now: NOW, maxAgeDays: 14 },
  );
  const urls = merged.map((m) => m.url);
  assert.deepEqual(urls.slice(0, 2), ["https://a/1", "https://b/1"], "both #1s outrank any #2");
  assert.deepEqual(urls.slice(2, 4), ["https://a/2", "https://b/2"]);
  assert.ok(!urls.includes("https://a/old"), "stale dated item removed");
  assert.equal(merged.length, 4);
});

test("an off-topic headline is dropped, however authoritative its source", () => {
  // Observed live: a narrow query returned an unrelated Law360 story, and an
  // authority-weighted sort put it first. Relevance gates the card.
  const topic = "Depo-Provera MDL 3140";
  const merged = [
    { title: "Atlas Energy Inks $17M Deal To End Investor Suit", url: "https://law360.com/a", snippet: "" },
    {
      title: "Depo Provera Lawsuit Settlement — September Litigation Update",
      url: "https://lawsuit-information-center.com/x",
      snippet: "",
    },
    { title: "Court sets first meningioma trial", url: "https://law.com/b", snippet: "In MDL 3140, the court…" },
  ];
  const picked = selectHeadlines(topic, merged, 3);
  assert.equal(picked.length, 2, "the unrelated story is gone");
  assert.ok(!picked.some((p) => p.url.includes("law360")));
  // The on-topic trade-press item outranks the on-topic marketing item even
  // though the marketing one came first out of the merge.
  assert.equal(picked[0]?.url, "https://law.com/b");
  assert.ok(matchesTopic(topic, { title: "Depo Provera settlement", snippet: "" }), "spaced spelling matches");
  assert.ok(!matchesTopic("702 hernia mesh", { title: "Litigation finance disclosure rule in Louisiana" }));
  assert.ok(matchesTopic("Bard PowerPort", { title: "Jury awards $40M in Bard PowerPort bellwether" }));
  // A topic made only of generic words cannot filter anything out.
  assert.equal(selectHeadlines("litigation update", merged, 3).length, 3);
});

test("a bare number in the topic cannot carry a match on its own", () => {
  // Live: topic "702 hernia mesh" matched "Code of Virginia" and an Ozempic
  // page purely on "702". The word has to be what matches.
  assert.ok(!matchesTopic("702 hernia mesh", { title: "Code of Virginia § 8.01-702", snippet: "" }));
  assert.ok(matchesTopic("702 hernia mesh", { title: "Hernia mesh verdict upheld", snippet: "" }));
  // A four-digit docket number identifies the matter as well as its name does,
  // so an order that cites only "MDL 3140" still counts.
  assert.ok(matchesTopic("Depo-Provera MDL 3140", { title: "Depo-Provera order", snippet: "" }));
  assert.ok(
    matchesTopic("Depo-Provera MDL 3140", { title: "Court sets first meningioma trial", snippet: "In MDL 3140, the court…" }),
  );
  assert.ok(matchesTopic("3140", { title: "In re MDL 3140 case management order", snippet: "" }));
});

test("a rule or section number never becomes the topic", () => {
  // "Rule 702" is a citation, not a matter; a 4-digit MDL number is a matter.
  assert.equal(topicsFromTitles(["Compare Rule 702 rulings across the hernia mesh MDLs"], 1)[0], "hernia mesh");
  assert.match(
    topicsFromTitles(["What is the next bellwether trial date in Depo-Provera MDL 3140"], 1)[0]!,
    /3140/,
  );
});

test("courts and trade press outrank intake-marketing sites", () => {
  // Live results for every mass-tort query were dominated by plaintiff-firm
  // marketing pages; they stay eligible but must sort last.
  const order = [
    "https://www.jpml.uscourts.gov/sites/jpml/files/order.pdf",
    "https://www.law360.com/articles/1",
    "https://www.law.com/nlj/2026/09/08/verdict/",
    "https://www.reuters.com/legal/x",
    "https://www.aboutlawsuits.com/bard-powerport/",
    "https://www.lawsuit-information-center.com/depo-provera.html",
    "https://www.drugwatch.com/x",
  ];
  const ranks = order.map(headlineHostRank);
  for (let i = 1; i < ranks.length; i++) {
    assert.ok(ranks[i]! >= ranks[i - 1]!, `${order[i]} should not outrank ${order[i - 1]}`);
  }
  assert.ok(headlineHostRank(order[0]!) < headlineHostRank(order[4]!));
  assert.ok(headlineHostRank("https://drugwatch.com/x") > headlineHostRank("https://example.org/x"));
  // Subdomains inherit their parent's tier.
  assert.equal(
    headlineHostRank("https://news.law360.com/a"),
    headlineHostRank("https://www.law360.com/a"),
  );
});

test("merge keeps undated items and gives a dated item a small edge at equal rank", () => {
  const merged = mergeHeadlineCandidates(
    [[c("tavily", 1, "https://a/undated")], [c("firecrawl", 1, "https://b/dated", { published: "2026-09-12" })]],
    { now: NOW },
  );
  assert.deepEqual(merged.map((m) => m.url), ["https://b/dated", "https://a/undated"]);
});
