import assert from "node:assert/strict";
import { test } from "node:test";

import { parseFirecrawlNews, toIsoDate } from "./firecrawl-search.server.ts";

const NOW = Date.parse("2026-09-12T12:00:00Z");

test("parses v2 news results with tolerant field names", () => {
  const items = parseFirecrawlNews(
    {
      success: true,
      data: {
        news: [
          {
            title: "Court sets 2027 bellwether in Depo-Provera MDL",
            url: "https://www.law360.com/articles/1?utm_source=x",
            snippet: "The transferee court set...",
            date: "2026-09-10T08:00:00Z",
            imageUrl: "https://cdn.law360.com/a.jpg",
            position: 1,
          },
          {
            title: "Older item with description field",
            url: "https://reuters.com/legal/b",
            description: "Reuters summary",
            publishedDate: "3 days ago",
            image: "http://insecure.example/img.png",
          },
          { title: "no url" },
          { url: "ftp://bad", title: "bad scheme" },
        ],
      },
    },
    10,
    NOW,
  );
  assert.equal(items.length, 2);
  assert.equal(items[0]!.backend, "firecrawl");
  assert.equal(items[0]!.rank, 1);
  assert.equal(items[0]!.imageUrl, "https://cdn.law360.com/a.jpg");
  assert.equal(items[0]!.published, "2026-09-10T08:00:00.000Z");
  assert.equal(items[1]!.rank, 2);
  assert.equal(items[1]!.snippet, "Reuters summary");
  assert.equal(items[1]!.published, "2026-09-09T12:00:00.000Z");
  assert.equal(items[1]!.imageUrl, undefined, "http images are dropped");
});

test("accepts data as a bare array, rejects failures and junk", () => {
  assert.equal(parseFirecrawlNews({ success: true, data: [{ title: "t", url: "https://a.b/c" }] }).length, 1);
  assert.deepEqual(parseFirecrawlNews({ success: false, data: { news: [{ title: "t", url: "https://a.b" }] } }), []);
  assert.deepEqual(parseFirecrawlNews(null), []);
  assert.deepEqual(parseFirecrawlNews("nope"), []);
  assert.equal(parseFirecrawlNews({ data: { news: Array.from({ length: 12 }, (_, i) => ({ title: `t${i}`, url: `https://a.b/${i}` })) } }, 5).length, 5);
});

test("toIsoDate handles absolute, relative, and garbage", () => {
  assert.equal(toIsoDate("2026-09-01", NOW), "2026-09-01T00:00:00.000Z");
  assert.equal(toIsoDate("2 hours ago", NOW), "2026-09-12T10:00:00.000Z");
  assert.equal(toIsoDate("last Tuesday", NOW), undefined);
  assert.equal(toIsoDate("", NOW), undefined);
});
