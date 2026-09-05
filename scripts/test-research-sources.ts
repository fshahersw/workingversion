// Validates the two new research data-source credentials from .env (bun
// auto-loads .env; values stay hidden). No AWS needed — both are token/key APIs.
//   bun run scripts/test-research-sources.ts
import { searchCases, docketbirdConfigured } from "../src/lib/agents/docketbird.server";

async function courtlistener() {
  const token = process.env["COURTLISTENER_API_TOKEN"];
  console.log("\n=== CourtListener RECAP ===");
  if (!token) { console.log("COURTLISTENER_API_TOKEN: MISSING from env"); return false; }
  const res = await fetch(
    "https://www.courtlistener.com/api/rest/v4/search/?q=AFFF+MDL&type=r&order_by=dateFiled+desc",
    { headers: { Authorization: `Token ${token}` } },
  );
  const txt = await res.text();
  let j: Record<string, unknown> = {};
  try { j = JSON.parse(txt); } catch { /* non-json */ }
  const results = Array.isArray(j["results"]) ? (j["results"] as Record<string, unknown>[]) : [];
  console.log("HTTP", res.status, "| count:", j["count"], "| results:", results.length);
  for (const r of results.slice(0, 3)) {
    console.log(`  - ${String(r["caseName"] ?? "").slice(0, 60)} | ${r["docketNumber"]} | ${r["court"]} | docket_id=${r["docket_id"]}`);
  }
  if (res.status !== 200) console.log("  body:", txt.slice(0, 200));
  return res.status === 200;
}

async function docketbird() {
  console.log("\n=== DocketBird REST ===");
  console.log("configured:", docketbirdConfigured());
  if (!docketbirdConfigured()) return false;
  try {
    const hits = await searchCases({ q: "In re Aqueous Film-Forming Foams Products Liability", size: 3 });
    console.log("searchCases hits:", hits.length);
    for (const h of hits.slice(0, 3)) console.log(`  - ${h.title?.slice(0, 60)} | ${h.court_id} | ${h.case_number ?? ""} | id=${h.id}`);
    return true;
  } catch (e) {
    console.log("ERROR:", e instanceof Error ? e.message : String(e));
    return false;
  }
}

async function main() {
  const cl = await courtlistener();
  const db = await docketbird();
  console.log(`\nCourtListener: ${cl ? "OK" : "FAIL"} | DocketBird: ${db ? "OK" : "FAIL"}`);
  if (!cl || !db) process.exit(1);
  console.log("Both research sources authenticated and returning data.");
}
main().catch((e) => { console.error(e); process.exit(1); });
