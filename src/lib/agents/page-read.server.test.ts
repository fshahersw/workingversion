import assert from "node:assert/strict";
import { test } from "node:test";

import { firecrawlScrape, readPage, resetReadPageBreakers, type ScrapeResult } from "./page-read.server.ts";

const body = "The court held that ".repeat(80);

/** A fetch stub that returns one HTML response for any host (DNS resolver stubbed to a public IP). */
function fetchStub(status: number, html: string, headers: Record<string, string> = {}) {
  return async () =>
    new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } });
}
const resolver = async () => [{ address: "93.184.216.34", family: 4 }];

test("a readable page is served directly without touching any fallback", async () => {
  let scraperCalls = 0;
  const scraper = async (): Promise<ScrapeResult | null> => {
    scraperCalls++;
    return { title: "x", text: body };
  };
  const r = await readPage("https://example.com/opinion", {
    fetchImpl: fetchStub(200, `<html><head><title>Opinion</title></head><body><p>${body}</p></body></html>`) as typeof fetch,
    resolver,
    firecrawl: scraper,
    tavily: scraper,
  });
  assert.equal(r.via, "direct");
  assert.equal(r.blocked, null);
  assert.equal(r.title, "Opinion");
  assert.equal(scraperCalls, 0);
});

test("a 403 escalates to Firecrawl, then Tavily, and reports how it read the page", async () => {
  const calls: string[] = [];
  const r = await readPage("https://example.com/blocked", {
    fetchImpl: fetchStub(403, "<html><body>Access denied</body></html>") as typeof fetch,
    resolver,
    firecrawl: async () => {
      calls.push("firecrawl");
      return null;
    },
    tavily: async () => {
      calls.push("tavily");
      return { title: "Rendered", text: body, finalUrl: "https://example.com/blocked" };
    },
  });
  assert.deepEqual(calls, ["firecrawl", "tavily"]);
  assert.equal(r.via, "tavily");
  assert.equal(r.title, "Rendered");
  assert.ok(r.blocked?.blocked && r.blocked.reason === "http-status");
  assert.match(r.note ?? "", /extraction service.*HTTP 403/);
  assert.ok(r.text.startsWith("The court held"));
});

test("a scraper that hits the same wall is skipped; exhausted fallbacks leave a precise note", async () => {
  const r = await readPage("https://example.com/challenge", {
    fetchImpl: fetchStub(200, "<html><head><title>Just a moment...</title></head><body>Checking your browser before accessing</body></html>") as typeof fetch,
    resolver,
    firecrawl: async () => ({ title: "Just a moment...", text: "Verify you are human" }),
    tavily: async () => null,
  });
  assert.equal(r.via, "direct");
  assert.ok(r.blocked?.blocked && r.blocked.reason === "challenge");
  assert.match(r.note ?? "", /could not be read .*bot challenge/);
});

test("login and paywall pages are never retried", async () => {
  let calls = 0;
  const r = await readPage("https://example.com/paywall", {
    fetchImpl: fetchStub(200, "<html><body>Subscribe to continue reading. Already a subscriber? Sign in.</body></html>") as typeof fetch,
    resolver,
    firecrawl: async () => {
      calls++;
      return { title: "x", text: body };
    },
    tavily: async () => {
      calls++;
      return { title: "x", text: body };
    },
  });
  assert.equal(calls, 0);
  assert.ok(r.blocked?.blocked && r.blocked.reason === "login" && !r.blocked.retryable);
});

test("fallbacks can be switched off", async () => {
  let calls = 0;
  const r = await readPage("https://example.com/blocked", {
    fetchImpl: fetchStub(429, "") as typeof fetch,
    resolver,
    fallbacks: false,
    firecrawl: async () => {
      calls++;
      return { title: "x", text: body };
    },
  });
  assert.equal(calls, 0);
  assert.ok(r.blocked);
});

test("SSRF refusals still throw instead of being scraped", async () => {
  await assert.rejects(
    readPage("http://169.254.169.254/latest/meta-data/", { firecrawl: async () => ({ title: "", text: body }) }),
    /Blocked|private|metadata|link-local/i,
  );
});

test("registry crawl policy: a never-crawl host is not handed to any scraper", async () => {
  let calls = 0;
  const r = await readPage("https://www.law.cornell.edu/uscode/text/28/1407", {
    fetchImpl: fetchStub(403, "<html><body>Access denied</body></html>") as typeof fetch,
    resolver,
    firecrawl: async () => {
      calls++;
      return { title: "x", text: body };
    },
    tavily: async () => {
      calls++;
      return { title: "x", text: body };
    },
  });
  assert.equal(calls, 0);
  assert.equal(r.via, "direct");
  assert.ok(r.blocked?.blocked);
  assert.equal(r.source.policy, "never");
  assert.match(r.note ?? "", /crawl policy \(never\)/);
});

test("results carry source-registry provenance without any fetch", async () => {
  const r = await readPage("https://www.fda.gov/advisory-committees", {
    fetchImpl: fetchStub(200, `<html><head><title>FDA</title></head><body><p>${body}</p></body></html>`) as typeof fetch,
    resolver,
  });
  assert.equal(r.via, "direct");
  assert.ok(r.source.known && r.source.official && r.source.domain === "fda.gov");
  const u = await readPage("https://unknown-host.example/page", {
    fetchImpl: fetchStub(200, `<html><body><p>${body}</p></body></html>`) as typeof fetch,
    resolver,
  });
  assert.equal(u.source.known, false);
});

test("provider breaker: three auth/quota failures pause a scraper rung; success resets it", async () => {
  resetReadPageBreakers();
  process.env["FIRECRAWL_API_KEY"] = "test-key";
  const realFetch = globalThis.fetch;
  let hits = 0;
  globalThis.fetch = (async () => {
    hits++;
    return new Response("{}", { status: 402 });
  }) as typeof fetch;
  try {
    for (let i = 0; i < 3; i++) assert.equal(await firecrawlScrape("https://example.com/a", 1000), null);
    assert.equal(hits, 3);
    // The rung is now paused: readPage skips Firecrawl and goes straight to Tavily.
    let tavilyCalls = 0;
    const r = await readPage("https://example.com/blocked", {
      fetchImpl: fetchStub(403, "<html><body>Access denied</body></html>") as typeof fetch,
      resolver,
      // firecrawl seam deliberately NOT injected: the real rung must be skipped by the breaker
      tavily: async () => {
        tavilyCalls++;
        return { title: "Rendered", text: body };
      },
    });
    assert.equal(hits, 3, "paused rung made no network call");
    assert.equal(tavilyCalls, 1);
    assert.equal(r.via, "tavily");
  } finally {
    globalThis.fetch = realFetch;
    delete process.env["FIRECRAWL_API_KEY"];
    resetReadPageBreakers();
  }
});
