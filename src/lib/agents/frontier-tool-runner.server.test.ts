import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ResearchToolRunner,
  mapSourceType,
  providerForTool,
  sourceToEvidence,
  type ResearchExecutor,
  type SourceLike,
} from "./frontier-tool-runner.server.ts";

/** Minimal stand-in for SourceBook: refs auto-increment S1, S2, ... */
class FakeBook {
  private sources: SourceLike[] = [];
  add(src: Omit<SourceLike, "ref">): SourceLike {
    const full: SourceLike = { ...src, ref: `S${this.sources.length + 1}` };
    this.sources.push(full);
    return full;
  }
  all(): SourceLike[] {
    return this.sources;
  }
}

const call = (tool: string, args: Record<string, unknown> = {}) => ({ id: `c-${tool}`, tool, args });

test("mapSourceType folds app source types into the frontier enum", () => {
  assert.equal(mapSourceType("opinion"), "court_opinion");
  assert.equal(mapSourceType("case_law"), "court_opinion");
  assert.equal(mapSourceType("filing"), "court_filing");
  assert.equal(mapSourceType("docket"), "court_filing");
  assert.equal(mapSourceType("regulatory"), "regulation");
  assert.equal(mapSourceType("science"), "secondary");
  assert.equal(mapSourceType("web"), "web");
  assert.equal(mapSourceType("mystery"), "web");
});

test("providerForTool identifies the retrieval provider", () => {
  assert.equal(providerForTool("recap_read"), "courtlistener");
  assert.equal(providerForTool("verify_citations"), "courtlistener");
  assert.equal(providerForTool("db_docket_sheet"), "docketbird");
  assert.equal(providerForTool("fda_search"), "openfda");
  assert.equal(providerForTool("search_pubmed"), "pubmed");
  assert.equal(providerForTool("search_authorities"), "web-search");
  assert.equal(providerForTool("fetch_page"), "web-fetch");
});

test("sourceToEvidence stamps authority level and carries dates/excerpt", () => {
  const ev = sourceToEvidence(
    {
      ref: "S3",
      citation: "In re Roundup",
      authority: "primary",
      source_type: "opinion",
      source_url: "https://court.gov/x",
      effective_date: "2016-10-03",
      content: "opinion text",
    },
    "recap_read",
  );
  assert.equal(ev.id, "S3");
  assert.equal(ev.sourceType, "court_opinion");
  assert.equal(ev.authorityLevel, 1);
  assert.equal(ev.primarySource, true);
  assert.equal(ev.provider, "courtlistener");
  assert.equal(ev.eventDate, "2016-10-03");
  assert.equal(ev.excerpt, "opinion text");
});

test("run maps only the sources THIS call produced (by refs)", async () => {
  const book = new FakeBook();
  book.add({ citation: "prior", authority: "web", source_type: "web", content: "old" }); // S1 pre-exists
  const execute: ResearchExecutor = async (_n, _i, b) => {
    const bk = b as FakeBook;
    const s = bk.add({ citation: "New Docket", authority: "registry", source_type: "docket", content: "x" });
    return { text: `[${s.ref}] found`, hits: 1, refs: [s.ref] };
  };
  const runner = new ResearchToolRunner({ book, execute });
  const res = await runner.run(call("recap_search"));
  assert.equal(res.ok, true);
  assert.equal(res.evidence.length, 1);
  assert.equal(res.evidence[0]!.id, "S2"); // not the pre-existing S1
  assert.equal(res.evidence[0]!.sourceType, "court_filing");
});

test("run classifies a tool failure as ok:false with the reason", async () => {
  const execute: ResearchExecutor = async () => ({
    text: "recap_search failed: upstream 500",
    hits: 0,
    refs: [],
  });
  const runner = new ResearchToolRunner({ book: new FakeBook(), execute });
  const res = await runner.run(call("recap_search"));
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /failed: upstream 500/);
  assert.equal(res.evidence.length, 0);
});

test("run treats a legitimate empty result as ok:true (orchestrator can move on)", async () => {
  const execute: ResearchExecutor = async () => ({
    text: 'No RECAP dockets for "obscure query".',
    hits: 0,
    refs: [],
  });
  const runner = new ResearchToolRunner({ book: new FakeBook(), execute });
  const res = await runner.run(call("recap_search"));
  assert.equal(res.ok, true);
  assert.equal(res.evidence.length, 0);
  assert.match(res.summary ?? "", /No RECAP dockets/);
});

test("run surfaces a thrown executor error as ok:false", async () => {
  const execute: ResearchExecutor = async () => {
    throw new Error("network reset");
  };
  const runner = new ResearchToolRunner({ book: new FakeBook(), execute });
  const res = await runner.run(call("db_docket_sheet"));
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /network reset/);
});
