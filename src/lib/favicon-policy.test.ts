import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import {
  faviconProxyUrl,
  isInstitutionalHost,
  rememberFaviconMiss,
  resetFaviconMisses,
  shouldSkipFaviconFetch,
} from "./favicon-policy.ts";

beforeEach(() => resetFaviconMisses());

test("known-no-favicon hosts and their subdomains are never fetched", () => {
  assert.equal(shouldSkipFaviconFetch("uscourts.gov"), true);
  assert.equal(shouldSkipFaviconFetch("www.uscourts.gov"), true);
  assert.equal(shouldSkipFaviconFetch("njd.uscourts.gov"), true);
  assert.equal(shouldSkipFaviconFetch("ecf.cand.uscourts.gov"), true);
  assert.equal(shouldSkipFaviconFetch("law.cornell.edu"), true);
  assert.equal(shouldSkipFaviconFetch("nytimes.com"), false);
  assert.equal(shouldSkipFaviconFetch("notuscourts.gov"), false, "suffix match is on a label boundary");
});

test("a host that failed once is not requested again this session", () => {
  assert.equal(shouldSkipFaviconFetch("example-news.com"), false);
  rememberFaviconMiss("www.Example-News.com");
  assert.equal(shouldSkipFaviconFetch("example-news.com"), true, "normalized: case and www. stripped");
  assert.equal(shouldSkipFaviconFetch("other.com"), false);
});

test("institutional hosts get the landmark glyph", () => {
  assert.equal(isInstitutionalHost("www.fda.gov"), true);
  assert.equal(isInstitutionalHost("army.mil"), true);
  assert.equal(isInstitutionalHost("canada.gc.ca"), true);
  assert.equal(isInstitutionalHost("gov.uk"), true);
  assert.equal(isInstitutionalHost("law.cornell.edu"), true);
  assert.equal(isInstitutionalHost("reuters.com"), false);
});

test("the proxy url is host-normalized and encoded", () => {
  assert.equal(faviconProxyUrl("WWW.Reuters.com"), "https://icons.duckduckgo.com/ip3/reuters.com.ico");
});
