import assert from "node:assert/strict";
import { test } from "node:test";
import { evidenceDigest, sameReviewDocument } from "./document-identity.ts";
import { documentRowFingerprint, cellCacheKey } from "./types.ts";

test("same filename and page count cannot reuse cells after testimony changes", async () => {
  const a = documentRowFingerprint(
    "smith.pdf",
    1,
    await evidenceDigest([{ page: 1, text: "I reviewed the label." }]),
  );
  const b = documentRowFingerprint(
    "smith.pdf",
    1,
    await evidenceDigest([{ page: 1, text: "I did not review the label." }]),
  );
  assert.notEqual(a, b);
  assert.equal(sameReviewDocument({ fingerprint: a, docId: "old" }, b), false);
  const key = (rowFingerprint: string) =>
    cellCacheKey({ rowFingerprint, columnId: "c", columnVersion: 1, model: "m" });
  assert.notEqual(key(a), key(b));
});
test("legacy fingerprints are not accepted as proof for new uploads", () => {
  assert.equal(
    sameReviewDocument({ fingerprint: "smith.pdf|1", docId: null }, "smith.pdf|1|sha256:abc"),
    false,
  );
  assert.equal(
    sameReviewDocument({ fingerprint: "smith.pdf|1", docId: "owned-doc" }, "new-key", "owned-doc"),
    true,
  );
});
test("both ingest paths hash the same ordered evidence consistently", async () => {
  assert.equal(
    await evidenceDigest([
      { page: 2, text: "b" },
      { page: 1, text: " a\r\n" },
    ]),
    await evidenceDigest([
      { page: 1, text: "a" },
      { page: 2, text: "b" },
    ]),
  );
});
