import assert from "node:assert/strict";
import { test } from "node:test";

import { callFingerprint, canonicalJson } from "./frontier-fingerprint.server.ts";

test("canonicalJson is stable across object key order", () => {
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
  assert.equal(
    canonicalJson({ query: "x", type: "r" }),
    canonicalJson({ type: "r", query: "x" }),
  );
});

test("canonicalJson sorts nested keys but preserves array order", () => {
  assert.equal(
    canonicalJson({ z: { b: 1, a: 2 }, list: [3, 1, 2] }),
    '{"list":[3,1,2],"z":{"a":2,"b":1}}',
  );
});

test("canonicalJson drops undefined keys and normalizes non-finite numbers", () => {
  assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
  assert.equal(canonicalJson({ n: NaN }), '{"n":null}');
  assert.equal(canonicalJson(undefined), "null");
  assert.equal(canonicalJson(null), "null");
});

test("callFingerprint is a 64-char hex sha256, deterministic and order-insensitive", () => {
  const fp = callFingerprint("courtlistener.search", { query: "x", type: "r" });
  assert.match(fp, /^[0-9a-f]{64}$/);
  assert.equal(fp, callFingerprint("courtlistener.search", { type: "r", query: "x" }));
});

test("callFingerprint differs on tool name or args", () => {
  const base = callFingerprint("web.search", { query: "a" });
  assert.notEqual(base, callFingerprint("web.fetch", { query: "a" }));
  assert.notEqual(base, callFingerprint("web.search", { query: "b" }));
});
