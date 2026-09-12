// ============================================================================
// Speculative recency sweep: the deterministic first search (pure, tested).
//
// The research loop's first model turn costs a TTFT plus a tool-use
// generation before any search starts, and whether the model anchors that
// search to the current month is up to it. This plan is built from the
// question alone, in microseconds, so the server can fire it the instant the
// request arrives and have fresh results waiting when the model's own first
// web_search executes. It is always a LAST-30-DAYS sweep on the matter's most
// distinctive terms: the single most reliable fix for "the agent missed the
// newest order / ruling / news".
// ============================================================================
import type { GatewayKey } from "./agentcore-search.server.ts";
import { distinctiveTerms } from "./web-rank.ts";
import {
  classifyEffort,
  classifyIntent,
  stripQueryFrame,
  type ResearchIntent,
} from "../research-intent.ts";

export type PrefetchPlan = {
  query: string;
  queries: string[];
  categories: GatewayKey[];
};

/** Which curated domain sets a recency sweep should hit, by detected intent. */
const CATEGORIES_BY_INTENT: Record<ResearchIntent, GatewayKey[]> = {
  docket: ["mdl_class_action", "legal_news", "state_case_law"],
  causation_science: ["scientific_medical", "legal_news"],
  regulatory: ["fda_drug_device", "agency_enforcement", "legal_news"],
  case_law: ["federal_case_law", "legal_news"],
  class_cert: ["federal_case_law", "legal_news"],
  settlement: ["mdl_class_action", "legal_news"],
  intake_strategy: ["mdl_class_action", "legal_news", "state_case_law"],
  general: ["legal_news", "mdl_class_action"],
};

/**
 * Build the sweep for a question, or null when a sweep would be noise: a
 * conversational turn, or a question with fewer than two distinctive terms
 * (a bare-topic query returns every matter and helps nothing).
 */
export function buildPrefetchPlan(rawQuery: string): PrefetchPlan | null {
  const bare = stripQueryFrame(rawQuery);
  if (!bare) return null;
  if (classifyEffort(bare, 0).mode === "conversational") return null;

  const primaryTerms = distinctiveTerms(bare, 4);
  if (primaryTerms.length < 2) return null;
  const primary = primaryTerms.join(" ");

  const queries: string[] = [];
  const relaxed = distinctiveTerms(bare, 3, { dropYears: true }).join(" ");
  if (relaxed && relaxed.toLowerCase() !== primary.toLowerCase()) queries.push(relaxed);

  const intent = classifyIntent(bare).intent;
  return { query: primary, queries, categories: CATEGORIES_BY_INTENT[intent] };
}
