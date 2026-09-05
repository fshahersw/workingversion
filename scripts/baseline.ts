// In-process single-agent baseline runner (with variance support).
//
// Replays the gold EVAL_SET through runResearchAgent() DIRECTLY (no HTTP), so it
// bypasses the /api/* auth gate and needs no browser session — just live AWS
// creds + the .env tool keys (bun auto-loads .env). Each case is scored with the
// SAME scoreResult() the live /eval harness uses, so these numbers are directly
// comparable to later multi-agent runs. Writes one CSV row per (case, run) and
// prints per-case distribution stats plus an aggregate.
//
//   AWS_REGION=us-east-1 bun run scripts/baseline.ts [idFilter] [runs]
//
// idFilter (optional): only run cases whose id includes this substring
//   (e.g. "deep" for the multi-entity set, or a single id for a smoke test).
// runs (optional, default 1): repeat each case N times. Live retrieval is noisy,
//   so N>=3 is what makes a quality change attributable rather than lost in noise.
import { writeFileSync } from "node:fs";
import { EVAL_SET, type EvalCase } from "../src/lib/eval-set";
import { emptyResult, scoreResult, summarize, type EvalResult } from "../src/lib/eval-runner";
import { runResearchAgent } from "../src/lib/agents/research-agent.server";
import type { Source } from "../src/lib/chat-types";

async function runOne(c: EvalCase): Promise<EvalResult> {
  const r = emptyResult(c);
  r.status = "running";
  const started = performance.now();
  let answer = "";
  let sources: Source[] = [];

  const emit = (event: string, data: unknown) => {
    const d = (data ?? {}) as Record<string, unknown>;
    if (event === "sources") {
      sources = (d.sources as Source[] | undefined) ?? sources;
    } else if (event === "delta") {
      if (!r.firstTokenMs) r.firstTokenMs = Math.round(performance.now() - started);
      answer += (d.text as string) ?? "";
    } else if (event === "error") {
      r.status = "error";
      r.error = (d.message as string) ?? "stream error";
    }
  };

  try {
    await runResearchAgent({ query: c.question }, emit);
  } catch (err) {
    r.status = "error";
    r.error = err instanceof Error ? err.message : String(err);
  }

  r.latencyMs = Math.round(performance.now() - started);
  return scoreResult(r, c, answer, sources);
}

type Stat = { mean: number; min: number; max: number; sd: number };
function stats(nums: number[]): Stat {
  const n = nums.length || 1;
  const mean = nums.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(nums.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  return { mean, min: Math.min(...nums), max: Math.max(...nums), sd };
}

type Row = { case: EvalCase; run: number; r: EvalResult };

function csv(rows: Row[]): string {
  const head = [
    "id",
    "run",
    "category",
    "status",
    "score",
    "latency_ms",
    "first_token_ms",
    "answer_chars",
    "sources",
    "tier1",
    "tier2",
    "tier3",
    "term_hits",
    "terms_total",
    "claims_verified",
    "claims_checked",
    "error",
  ].join(",");
  const body = rows.map(({ case: c, run, r }) =>
    [
      c.id,
      run,
      c.category,
      r.status,
      r.score,
      r.latencyMs,
      r.firstTokenMs,
      r.answerChars,
      r.sourceCount,
      r.tier1,
      r.tier2,
      r.tier3,
      r.termHits.length,
      r.termHits.length + r.termMisses.length,
      r.claimsVerified,
      r.claimsChecked,
      `"${(r.error ?? "").replace(/"/g, "'")}"`,
    ].join(","),
  );
  return [head, ...body].join("\n");
}

async function main(): Promise<void> {
  const filters = (process.argv[2] ?? "")
    .toLowerCase()
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const runs = Math.max(1, parseInt(process.argv[3] ?? "1", 10) || 1);
  const cases = filters.length
    ? EVAL_SET.filter((c) => filters.some((f) => c.id.toLowerCase().includes(f)))
    : EVAL_SET;
  if (!cases.length) {
    console.error(`No eval cases match filter "${process.argv[2]}".`);
    process.exit(1);
  }

  console.log(
    `Single-agent baseline — ${cases.length} case(s) x ${runs} run(s), in-process (no HTTP, no auth).\n`,
  );
  const rows: Row[] = [];
  const byCase = new Map<string, EvalResult[]>();
  for (const c of cases) {
    const rs: EvalResult[] = [];
    for (let run = 1; run <= runs; run++) {
      process.stdout.write(`- ${c.id} run ${run}/${runs} ... `);
      const r = await runOne(c);
      rs.push(r);
      rows.push({ case: c, run, r });
      console.log(
        `${r.status} | score ${r.score} | ${(r.latencyMs / 1000).toFixed(1)}s ` +
          `(ttfa ${(r.firstTokenMs / 1000).toFixed(1)}s) | ${r.sourceCount} src ` +
          `(T1 ${r.tier1}/T2 ${r.tier2}/T3 ${r.tier3}) | terms ` +
          `${r.termHits.length}/${r.termHits.length + r.termMisses.length}` +
          `${r.error ? ` | ERR ${r.error}` : ""}`,
      );
    }
    byCase.set(c.id, rs);
  }

  if (runs > 1) {
    console.log(
      "\n=== PER-CASE VARIANCE (score mean [min-max] sd | latency | sources | fails) ===",
    );
    for (const [id, rs] of byCase) {
      const sc = stats(rs.map((r) => r.score));
      const lat = stats(rs.map((r) => r.latencyMs / 1000));
      const src = stats(rs.map((r) => r.sourceCount));
      const fails = rs.filter((r) => r.status === "error").length;
      console.log(
        `${id}: score ${sc.mean.toFixed(0)} [${sc.min}-${sc.max}] sd ${sc.sd.toFixed(1)} | ` +
          `${lat.mean.toFixed(1)}s [${lat.min.toFixed(1)}-${lat.max.toFixed(1)}] | ` +
          `src ${src.mean.toFixed(1)} | fails ${fails}/${rs.length}`,
      );
    }
  }

  const summary = summarize(rows.map((x) => x.r));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = `eval-baseline-${stamp}.csv`;
  writeFileSync(outPath, csv(rows));

  console.log("\n=== AGGREGATE (all runs, done cases only) ===");
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\nCSV (${rows.length} rows) written to ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
