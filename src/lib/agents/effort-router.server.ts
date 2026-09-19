// ============================================================================
// Research effort router (server-only): conversational / fast / think.
//
// The heuristic (research-intent.classifyEffort) is free and safe but coarse:
// anything ambiguous defaults to THINK (confidence 0.5), so a large share of
// single-lookup questions pay for the full loop (live: research runs p50 45 s,
// p90 99 s). Jev answers the same three-way question, plus whether a
// deliverable is wanted and whether the subject is legal, in one ~150-300 ms
// call with a calibrated confidence. RESEARCH_EFFORT_ROUTER:
//   heuristic (default) unchanged.
//   shadow    heuristic decides; Jev is asked in parallel and both verdicts are
//             logged (effort_router_shadow) for threshold tuning.
//   typesafe  Jev decides when it has an opinion; the heuristic's legal-signal
//             regex still vetoes any conversational down-route; no opinion or
//             failure falls back to the heuristic. Never slower than the
//             TYPESAFE_TIMEOUT_MS budget, since the heuristic runs in parallel.
// ============================================================================
import { classifyEffort, hasLegalSignal, stripClarification, stripQueryFrame, type EffortDecision } from "@/lib/research-intent";

import { agentLog } from "./log.server";
import { decideResearchEffort, researchEffortQuestions, researchEffortState } from "./typesafe-questions";
import { systemOne, typesafeConfigured } from "./typesafe.server";

export type EffortRouterMode = "heuristic" | "shadow" | "typesafe";

export function effortRouterMode(): EffortRouterMode {
  const v = (process.env["RESEARCH_EFFORT_ROUTER"] ?? "").trim().toLowerCase();
  return v === "typesafe" || v === "shadow" ? v : "heuristic";
}

async function jevEffort(
  query: string,
  historyTurns: number,
  signal?: AbortSignal,
): Promise<{ decision: EffortDecision | null; ms: number; wantsDeliverable: boolean }> {
  const started = Date.now();
  const clean = stripClarification(stripQueryFrame(query));
  const res = await systemOne({
    purpose: "research_effort",
    state: researchEffortState(clean, historyTurns),
    questions: researchEffortQuestions(),
    ...(signal ? { signal } : {}),
  });
  const d = decideResearchEffort(res, { legalSignal: hasLegalSignal(query), historyTurns });
  return {
    decision: d ? { mode: d.mode, confidence: d.confidence, reason: d.reason } : null,
    ms: Date.now() - started,
    wantsDeliverable: d?.wantsDeliverable ?? false,
  };
}

/** Drop-in for classifyEffort with the router mode applied. */
export async function routeEffort(query: string, historyTurns: number, signal?: AbortSignal): Promise<EffortDecision> {
  const heuristic = classifyEffort(query, historyTurns);
  const mode = effortRouterMode();
  if (mode === "heuristic" || !typesafeConfigured()) return heuristic;
  const jev = await jevEffort(query, historyTurns, signal);
  if (mode === "shadow") {
    agentLog("effort_router_shadow", {
      heuristic: heuristic.mode,
      jev: jev.decision?.mode ?? "none",
      agree: jev.decision !== null && jev.decision.mode === heuristic.mode,
      jev_ms: jev.ms,
      confidence: jev.decision ? Math.round(jev.decision.confidence * 100) / 100 : -1,
      heuristic_confidence: heuristic.confidence,
      deliverable: jev.wantsDeliverable,
    });
    return heuristic;
  }
  if (jev.decision) {
    agentLog("effort_router", { via: "typesafe", mode: jev.decision.mode, heuristic: heuristic.mode, ms: jev.ms });
    return jev.decision;
  }
  agentLog("effort_router", { via: "heuristic_fallback", mode: heuristic.mode, jev_ms: jev.ms });
  return heuristic;
}
