// End-to-end test of the CourtListener RECAP client: search -> docket entries
// -> read a filing's extracted text. Proves the free "pull the actual filing"
// capability. Run: bun run scripts/test-courtlistener.ts
import { recapSearch, getDocketEntries, readRecapDocument, courtlistenerConfigured } from "../src/lib/agents/courtlistener.server";

async function main() {
  console.log("configured:", courtlistenerConfigured(), "\n");

  const hits = await recapSearch("Aqueous Film-Forming Foams", { type: "r", orderBy: "dateFiled desc" });
  console.log(`recapSearch -> ${hits.length} dockets`);
  const withDocket = hits.find((h) => h.docketId);
  if (!withDocket?.docketId) throw new Error("no docket with id in search results");
  console.log(`  using: "${withDocket.caseName.slice(0, 50)}" (${withDocket.docketNumber}, ${withDocket.court}) docket_id=${withDocket.docketId}`);

  const entries = await getDocketEntries(withDocket.docketId, { pageSize: 100 });
  console.log(`\ngetDocketEntries -> ${entries.length} entries`);
  const entryWithDoc = entries.find((e) => e.documents.some((d) => d.isAvailable && (d.pageCount ?? 0) > 0));
  const target = entryWithDoc?.documents.find((d) => d.isAvailable && (d.pageCount ?? 0) > 0)
    ?? entries.flatMap((e) => e.documents).find((d) => d.isAvailable);
  if (!target) {
    console.log("  (no available document in the first page of entries — search/entries still OK)");
    console.log("\nCOURTLISTENER SEARCH+ENTRIES OK.");
    return;
  }
  console.log(`  reading doc id=${target.id} (#${target.documentNumber}, ${target.pageCount}pp): ${target.description.slice(0, 50)}`);

  const doc = await readRecapDocument(target.id);
  console.log(`\nreadRecapDocument -> available=${doc.isAvailable} pages=${doc.pageCount} ocr=${doc.ocrStatus} textChars=${doc.plainText.length}`);
  console.log("  pdf:", doc.pdfUrl?.slice(0, 90));
  console.log("  text[0:220]:", doc.plainText.replace(/\s+/g, " ").slice(0, 220));

  if (!doc.plainText.length && !doc.pdfUrl) throw new Error("document had neither text nor PDF");
  console.log("\nCOURTLISTENER RECAP FULL CHAIN OK (search -> entries -> document text/PDF).");
}
main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
