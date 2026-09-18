import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyPage, viaNote } from "./page-block.ts";

const article = "Lorem ipsum ".repeat(120);

test("ordinary pages are not blocked, even when they mention cookies in a long body", () => {
  assert.deepEqual(classifyPage({ status: 200, contentType: "text/html", title: "Opinion", text: article }), {
    blocked: false,
  });
  assert.deepEqual(
    classifyPage({
      status: 200,
      contentType: "text/html",
      title: "News",
      text: `${article} We use cookies to improve your experience. ${article}`,
    }),
    { blocked: false },
  );
  assert.deepEqual(classifyPage({ status: 200, contentType: "application/pdf", title: "opinion", text: article }), {
    blocked: false,
  });
});

test("HTTP statuses map to retryable and non-retryable blocks", () => {
  const forbidden = classifyPage({ status: 403, contentType: "text/html", title: "", text: "" });
  assert.ok(forbidden.blocked && forbidden.reason === "http-status" && forbidden.retryable);
  const rate = classifyPage({ status: 429, contentType: "text/html", title: "", text: "" });
  assert.ok(rate.blocked && rate.retryable);
  const gone = classifyPage({ status: 404, contentType: "text/html", title: "", text: article });
  assert.ok(gone.blocked && gone.reason === "not-found" && !gone.retryable);
  const auth = classifyPage({ status: 401, contentType: "text/html", title: "", text: "" });
  assert.ok(auth.blocked && auth.reason === "login" && !auth.retryable);
});

test("short interstitials are classified by kind", () => {
  const cf = classifyPage({ status: 200, contentType: "text/html", title: "Just a moment...", text: "Checking your browser before accessing the site." });
  assert.ok(cf.blocked && cf.reason === "challenge" && cf.retryable);
  const consent = classifyPage({ status: 200, contentType: "text/html", title: "", text: "We use cookies. Accept all cookies or manage your cookie preferences." });
  assert.ok(consent.blocked && consent.reason === "consent" && consent.retryable);
  const js = classifyPage({ status: 200, contentType: "text/html", title: "App", text: "You need to enable JavaScript to run this app." });
  assert.ok(js.blocked && js.reason === "javascript" && js.retryable);
  const wall = classifyPage({ status: 200, contentType: "text/html", title: "", text: "Subscribe to continue reading. Already a subscriber? Sign in." });
  assert.ok(wall.blocked && wall.reason === "login" && !wall.retryable);
  const empty = classifyPage({ status: 200, contentType: "text/html", title: "", text: "", html: "<html><script></script><script></script><script></script><body></body></html>" });
  assert.ok(empty.blocked && empty.reason === "empty" && empty.retryable);
});

test("viaNote explains a fallback and is silent for direct reads", () => {
  assert.equal(viaNote("direct", null), "");
  const v = classifyPage({ status: 403, contentType: "text/html", title: "", text: "" });
  assert.match(viaNote("firecrawl", v), /rendering scraper.*HTTP 403/);
  assert.match(viaNote("tavily", v), /extraction service/);
});
