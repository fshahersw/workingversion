// One-off: generate cached AI briefings for intel rows that never got one.
//
//   CORPUS_SERVICE_KEY=... LOVABLE_API_KEY=... bun scripts/backfill-intel-analysis.ts
//
// Idempotent: only touches rows where analysis_lead is null.
import { CORPUS_URL } from "@/lib/corpus";
import { analyzeItems, type AnalysisInput } from "@/lib/intel-analyze.server";

const KEY = process.env["CORPUS_SERVICE_KEY"];
if (!KEY) throw new Error("CORPUS_SERVICE_KEY is not configured");

const headers = {
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
  "content-type": "application/json",
};

type Row = {
  intel_id: string;
  title: string;
  summary: string | null;
  source_name: string | null;
  source_domain: string | null;

};

async function fetchPending(limit: number): Promise<Row[]> {
  const qs = new URLSearchParams({
    select: "intel_id,title,summary,source_name,source_domain",
    analysis_lead: "is.null",
    order: "published_at.desc.nullslast",
    limit: String(limit),
  });
  const res = await fetch(`${CORPUS_URL}/rest/v1/corpus_intel_items?${qs}`, { headers });
  if (!res.ok) throw new Error(`fetch pending: ${res.status} ${await res.text()}`);
  return (await res.json()) as Row[];
}

async function writeAnalysis(
  id: string,
  a: { lead: string | null; bullets: string[]; impact: string | null },
): Promise<void> {
  const res = await fetch(
    `${CORPUS_URL}/rest/v1/corpus_intel_items?intel_id=eq.${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: { ...headers, Prefer: "return=minimal" },
      body: JSON.stringify({
        analysis_lead: a.lead,
        analysis_bullets: a.bullets,
        analysis_impact: a.impact,
      }),
    },
  );
  if (!res.ok) throw new Error(`patch ${id}: ${res.status} ${await res.text()}`);
}

async function main() {
  let total = 0;
  let written = 0;
  for (let pass = 0; pass < 12; pass++) {
    const rows = await fetchPending(40);
    if (rows.length === 0) break;
    total += rows.length;

    const inputs: AnalysisInput[] = rows.map((r) => ({
      key: r.intel_id,
      title: r.title,
      source: r.source_name ?? r.source_domain,
      text: [r.summary].filter(Boolean).join("\n\n") || null,
    }));

    const { analyses, errors } = await analyzeItems(inputs, {
      cap: inputs.length,
      batchSize: 4,
      concurrency: 5,
    });
    for (const err of errors.slice(0, 3)) console.warn("analysis error:", err);

    let passWrites = 0;
    for (const row of rows) {
      const a = analyses.get(row.intel_id);
      if (!a || (!a.lead && a.bullets.length === 0)) continue;
      await writeAnalysis(row.intel_id, a);
      passWrites++;
    }
    written += passWrites;
    console.log(`pass ${pass + 1}: ${rows.length} pending, ${passWrites} analyzed`);
    if (passWrites === 0) break; // avoid looping over permanently unanalyzable rows
  }
  console.log(`done: ${written}/${total} rows backfilled`);
}

await main();
