import assert from "node:assert/strict";
import { test } from "node:test";

import { buildIndex, search } from "./bm25.ts";
import { collapsePassageHits, chunkText, pagesToPassageDocs } from "./passages.ts";

test("chunkText overlaps so a split sentence is not lost", () => {
  const text = "A".repeat(50) + " holding on Daubert " + "B".repeat(50);
  const chunks = chunkText(text, 80, 20);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.some((c) => c.includes("Daubert")));
});

test("passage search still resolves to the source page", () => {
  const docs = pagesToPassageDocs([
    { fileId: "f1", fileName: "motion.pdf", page: 1, text: "Certificate of service." },
    {
      fileId: "f1",
      fileName: "motion.pdf",
      page: 12,
      text: `${"x ".repeat(200)} The court excludes the expert under Daubert. ${"y ".repeat(200)}`,
    },
  ]);
  const hits = search(buildIndex(docs), "Daubert excludes expert", 8);
  const pages = collapsePassageHits(hits);
  assert.equal(pages[0]?.pageId, "f1:12");
});
