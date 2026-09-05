/**
 * Evaluation harness runner (research quality item 11).
 *
 * Replays gold-standard questions through the live orchestrate stream and
 * scores each answer deterministically: term coverage, authority coverage,
 * source tier mix, fact-check verification rate, and latency. No backend
 * changes — it uses the same SSE contract the chat UI uses.
 */
import { streamOrchestrate, type SSEEvent } from "./orchestrate";
import type { Source } from "./chat-types";
import { factCheck } from "./fact-check";
import { gradeSource } from "./source-tiering";
import type { EvalCase } from "./eval-set";

export type EvalResult = {
  id: string;
  question: string;
  category: EvalCase["category"];
  status: "pending" | "running" | "done" | "error";
  error?: string;
  /** wall clock, ms */
  latencyMs: number;
  /** ms until the writer started producing text */
  firstTokenMs: number;
  answerChars: number;
  sourceCount: number;
  tier1: number;
  tier2: number;
  tier3: number;
  staleSources: number;
  termHits: string[];
  termMisses: string[];
  authorityHits: string[];
  authorityMisses: string[];
  claimsChecked: number;
  claimsVerified: number;
  tierSatisfied: boolean;
  /** 0-100 composite */
  score: number;
};

export function emptyResult(c: EvalCase): EvalResult {
  return {
    id: c.id,
    question: c.question,
    category: c.category,
    status: "pending",
    latencyMs: 0,
    firstTokenMs: 0,
    answerChars: 0,
    sourceCount: 0,
    tier1: 0,
    tier2: 0,
    tier3: 0,
    staleSources: 0,
    termHits: [],
    termMisses: [],
    authorityHits: [],
    authorityMisses: [],
    claimsChecked: 0,
    claimsVerified: 0,
    tierSatisfied: false,
    score: 0,
  };
}

function score(r: EvalResult, c: EvalCase): number {
  const terms = c.expectTerms.length
    ? r.termHits.length / c.expectTerms.length
    : 1;
  const auth = c.expectAuthorities.length
    ? r.authorityHits.length / c.expectAuthorities.length
    : 1;
  const verify = r.claimsChecked ? r.claimsVerified / r.claimsChecked : 1;
  const tier = r.tierSatisfied ? 1 : 0;
  const grounded = r.sourceCount >= 3 ? 1 : r.sourceCount / 3;
  const composite =
    terms * 0.3 + auth * 0.2 + verify * 0.25 + tier * 0.15 + grounded * 0.1;
  return Math.round(composite * 100);
}

export async function runEvalCase(
  c: EvalCase,
  onProgress: (r: EvalResult) => void,
  signal?: AbortSignal,
): Promise<EvalResult> {
  const r = emptyResult(c);
  r.status = "running";
  onProgress({ ...r });

  const started = performance.now();
  let answer = "";
  let sources: Source[] = [];

  const onEvent = (e: SSEEvent) => {
    const d = (e.data ?? {}) as Record<string, unknown>;
    if (e.event === "sources") {
      sources = (d.sources as Source[] | undefined) ?? [];
    } else if (e.event === "delta") {
      if (!r.firstTokenMs) r.firstTokenMs = Math.round(performance.now() - started);
      answer += (d.text as string) ?? "";
    } else if (e.event === "error") {
      r.status = "error";
      r.error = (d.message as string) ?? "stream error";
    }
  };

  try {
    await streamOrchestrate(
      { query: c.question, session_id: `eval-${c.id}-${Date.now()}`, stream: true },
      onEvent,
      signal,
    );
  } catch (err) {
    r.status = "error";
    r.error = err instanceof Error ? err.message : String(err);
  }

  r.latencyMs = Math.round(performance.now() - started);
  scoreResult(r, c, answer, sources);
  onProgress({ ...r });
  return r;
}

/**
 * Fill the deterministic quality fields on a result from its answer + sources,
 * then compute the composite score. Transport timing (latencyMs, firstTokenMs)
 * is set by the caller; everything here is pure given (answer, sources), so the
 * live HTTP harness (runEvalCase) and the in-process baseline runner share one
 * scoring path and stay directly comparable.
 */
export function scoreResult(
  r: EvalResult,
  c: EvalCase,
  answer: string,
  sources: Source[],
): EvalResult {
  r.answerChars = answer.length;
  r.sourceCount = sources.length;

  for (const s of sources) {
    const g = gradeSource(s);
    if (g.tier === 1) r.tier1 += 1;
    else if (g.tier === 2) r.tier2 += 1;
    else r.tier3 += 1;
    if (g.stale) r.staleSources += 1;
  }
  r.tierSatisfied =
    c.requireTier === 1
      ? r.tier1 > 0
      : c.requireTier === 2
        ? r.tier1 + r.tier2 > 0
        : r.sourceCount > 0;

  const hayAnswer = answer.toLowerCase();
  for (const t of c.expectTerms) {
    (hayAnswer.includes(t) ? r.termHits : r.termMisses).push(t);
  }
  const haySources = sources
    .map(
      (s) =>
        `${s.authority ?? ""} ${s.citation ?? ""} ${s.source_type ?? ""} ${s.source_url ?? ""}`,
    )
    .join(" ")
    .toLowerCase();
  for (const a of c.expectAuthorities) {
    (haySources.includes(a) ? r.authorityHits : r.authorityMisses).push(a);
  }

  const claims = factCheck(answer, sources);
  r.claimsChecked = claims.length;
  r.claimsVerified = claims.filter((x) => x.verified).length;

  if (r.status !== "error") r.status = "done";
  r.score = score(r, c);
  return r;
}

export type EvalSummary = {
  cases: number;
  avgScore: number;
  avgLatencyMs: number;
  avgFirstTokenMs: number;
  verificationRate: number;
  tierPassRate: number;
  termRecall: number;
};

export function summarize(results: EvalResult[]): EvalSummary {
  const done = results.filter((r) => r.status === "done");
  const n = done.length || 1;
  const checked = done.reduce((a, r) => a + r.claimsChecked, 0);
  const verified = done.reduce((a, r) => a + r.claimsVerified, 0);
  const terms = done.reduce((a, r) => a + r.termHits.length, 0);
  const termTotal =
    done.reduce((a, r) => a + r.termHits.length + r.termMisses.length, 0) || 1;
  return {
    cases: done.length,
    avgScore: Math.round(done.reduce((a, r) => a + r.score, 0) / n),
    avgLatencyMs: Math.round(done.reduce((a, r) => a + r.latencyMs, 0) / n),
    avgFirstTokenMs: Math.round(
      done.reduce((a, r) => a + r.firstTokenMs, 0) / n,
    ),
    verificationRate: checked ? Math.round((verified / checked) * 100) : 100,
    tierPassRate: Math.round(
      (done.filter((r) => r.tierSatisfied).length / n) * 100,
    ),
    termRecall: Math.round((terms / termTotal) * 100),
  };
}

export function toCSV(results: EvalResult[]): string {
  const head = [
    "id",
    "category",
    "score",
    "latency_ms",
    "first_token_ms",
    "answer_chars",
    "sources",
    "tier1",
    "tier2",
    "tier3",
    "stale",
    "claims_checked",
    "claims_verified",
    "term_misses",
    "authority_misses",
    "status",
  ].join(",");
  const rows = results.map((r) =>
    [
      r.id,
      r.category,
      r.score,
      r.latencyMs,
      r.firstTokenMs,
      r.answerChars,
      r.sourceCount,
      r.tier1,
      r.tier2,
      r.tier3,
      r.staleSources,
      r.claimsChecked,
      r.claimsVerified,
      `"${r.termMisses.join(" | ")}"`,
      `"${r.authorityMisses.join(" | ")}"`,
      r.status,
    ].join(","),
  );
  return [head, ...rows].join("\n");
}
