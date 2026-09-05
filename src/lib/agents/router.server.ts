// ============================================================================
// Stage 2 — ROUTE. One small model call over the page map (never the text).
//
// Returns the document type, a priority tier per section, and the concrete
// questions this document must answer. Everything downstream is driven by that
// output, which is what makes the parallel read targeted rather than uniform.
// The call is best-effort: on any failure the local tiers from SCAN stand.
// ============================================================================
import { parseJsonBlock } from "./json-extract";
import { docRouterPrompt } from "./prompts";
import type { SectionSignals, Tier } from "./doc-scan";
import { MAX_ROUTED_QUESTIONS } from "@/lib/summarizer-config";

export type RouteResult = {
  docType: string;
  questions: string[];
  tiers: Map<number, Tier>;
  routed: boolean;
};

const TIERS: Tier[] = ["critical", "normal", "skim"];

export async function routeDocument(opts: {
  title: string;
  matterLabel?: string;
  instructions?: string;
  map: string;
  sections: SectionSignals[];
  call: (system: string, user: string, maxTokens: number) => Promise<string>;
}): Promise<RouteResult> {
  const fallback: RouteResult = {
    docType: "",
    questions: [],
    tiers: new Map(opts.sections.map((s) => [s.index, s.tier])),
    routed: false,
  };

  try {
    const text = await opts.call(
      docRouterPrompt(opts.title, opts.matterLabel, opts.instructions),
      `SECTION MAP (${opts.sections.length} sections):\n${opts.map}`,
      2_000,
    );
    const parsed = parseJsonBlock(text, "questions") ?? parseJsonBlock(text, "doc_type");
    if (!parsed) return fallback;

    const docType = String(parsed["doc_type"] ?? "").slice(0, 80);
    const questions = (Array.isArray(parsed["questions"]) ? parsed["questions"] : [])
      .map((q) => String(q ?? "").trim())
      .filter((q) => q.length > 8)
      .slice(0, MAX_ROUTED_QUESTIONS);

    const tiers = new Map(fallback.tiers);
    const rawTiers = parsed["tiers"];
    if (Array.isArray(rawTiers)) {
      for (const item of rawTiers) {
        if (!item || typeof item !== "object") continue;
        const o = item as Record<string, unknown>;
        const idx = Number(o["section"]);
        const tier = String(o["tier"] ?? "").toLowerCase() as Tier;
        if (Number.isFinite(idx) && TIERS.includes(tier) && tiers.has(idx)) tiers.set(idx, tier);
      }
    }

    // Never let the router skim the whole document.
    const critical = [...tiers.values()].filter((t) => t === "critical").length;
    if (!critical) {
      for (const s of [...opts.sections].sort((a, b) => b.score - a.score).slice(0, 2)) {
        tiers.set(s.index, "critical");
      }
    }

    return { docType, questions, tiers, routed: questions.length > 0 };
  } catch {
    return fallback;
  }
}
