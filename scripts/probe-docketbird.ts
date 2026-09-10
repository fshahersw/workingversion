// One-off DocketBird diagnostic (read-only): which query SHAPES recover a case.
// Never prints the key. Run: bun scripts/probe-docketbird.ts
const KEY = process.env["DOCKETBIRD_API_KEY"];
const BASE = process.env["DOCKETBIRD_API_BASE"] || "https://api.docketbird.com";
if (!KEY) {
  console.error("DOCKETBIRD_API_KEY not found in env (.env should hold it).");
  process.exit(1);
}
const H = { Authorization: `Bearer ${KEY}`, Accept: "application/json" };

async function cases(q: string): Promise<void> {
  try {
    const res = await fetch(`${BASE}/cases/search?q=${encodeURIComponent(q)}&size=3`, { headers: H });
    const j = (await res.json()) as { data?: { cases?: Record<string, unknown>[]; found?: number } };
    const list = j.data?.cases ?? [];
    const first = list[0];
    console.log(
      `q="${q}"\n   -> ${res.status} found=${j.data?.found ?? "?"} returned=${list.length}` +
        (first ? ` | top: ${String(first["id"])} — ${String(first["title"]).slice(0, 70)}` : " | (none)"),
    );
  } catch (e) {
    console.log(`q="${q}" ERR`, e instanceof Error ? e.message : e);
  }
}

console.log("--- Meta social-media MDL (caption is 'In re: Social Media Adolescent Addiction...') ---");
await cases("Meta Platforms Inc. social media addiction litigation"); // the failing screenshot query
await cases("Meta Platforms social media addiction"); // cleanCaseQuery output (party kept)
await cases("social media addiction"); // party dropped, filler dropped
await cases("social media adolescent addiction"); // exact caption words
console.log("\n--- Roundup (caption 'In re: Roundup Products Liability Litigation') ---");
await cases("Bayer Monsanto Inc. Roundup glyphosate cancer litigation"); // over-specified
await cases("Roundup products liability"); // caption words
console.log("\n--- number formats for the social-media MDL (real id cand-4:2022-md-03047) ---");
await cases("2022-md-03047");
await cases("MDL 3047");
