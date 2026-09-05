// Shared summarizer configuration used by the server pipeline and the client UI.
// Keep this file free of server-only imports so it can be loaded in the browser.

export type SummarizeMode = "fast" | "standard" | "thorough";

export const MODE_DEFAULT: SummarizeMode = "standard";

/** Target characters per section handed to a digest call. */
export const SECTION_CHARS = 52_000;

/** Characters of digest text the writer can take in one pass. */
export const REDUCE_LIMIT = 120_000;

/** Approximate characters per token for quick budget checks. */
export const CHARS_PER_TOKEN = 4;

/** Tokens reserved for the system prompt and output when checking single-pass fit. */
export const SINGLE_PASS_PROMPT_RESERVE = 2_000;

/** Max tokens a single-pass or final writer is allowed to consume. */
export const SINGLE_PASS_BUDGET_TOKENS = 140_000;

export function estimateTokens(chars: number): number {
  return Math.max(1, Math.ceil(chars / CHARS_PER_TOKEN));
}

export function fitsSinglePass(charCount: number, outputTokens: number): boolean {
  return estimateTokens(charCount) + outputTokens + SINGLE_PASS_PROMPT_RESERVE <= SINGLE_PASS_BUDGET_TOKENS;
}

export function estimateSections(charCount: number): number {
  return Math.max(1, Math.ceil(charCount / SECTION_CHARS));
}

/** Crude estimate of how many digest-to-digest reduce calls are needed. */
export function estimateReduceGroups(charCount: number): number {
  // Digests are roughly 1/3 the raw character count; groups cap at REDUCE_LIMIT / 2.
  const digestChars = Math.max(0, charCount / 3);
  if (digestChars <= REDUCE_LIMIT) return 0;
  return Math.ceil(digestChars / (REDUCE_LIMIT / 2));
}

/** Estimated number of LLM calls for the chosen mode. */
export function estimateCalls(charCount: number): { sections: number; reduceGroups: number; writer: number; total: number } {
  const sections = estimateSections(charCount);
  const reduceGroups = estimateReduceGroups(charCount);
  return { sections, reduceGroups, writer: 1, total: sections + reduceGroups + 1 };
}

// ============================================================================
// Nuance / needle-in-a-haystack settings
// ============================================================================

/** Characters of the previous section repeated at the head of the next one. */
export const SECTION_OVERLAP_CHARS = 2_000;

/** Max pages handed to one targeted sweep call. */
export const SWEEP_MAX_PAGES = 40;

/** Max characters of raw page text per sweep call. */
export const SWEEP_MAX_CHARS = 90_000;

/** Max sweep calls per run. */
export const SWEEP_MAX_CALLS = 3;

/** Max facts carried into the writer. */
export const LEDGER_MAX_FACTS = 400;

export const FACT_KINDS = [
  "date",
  "amount",
  "party",
  "holding",
  "deadline",
  "obligation",
  "risk",
  "contradiction",
] as const;

export type FactKind = (typeof FACT_KINDS)[number];

export type LedgerFact = {
  claim: string;
  page: number;
  kind: FactKind;
  actors?: string;
  date?: string;
  amount?: string;
  quote?: string;
};

/** Terms that reliably mark high-value language in litigation documents. */
export const RISK_LEXICON = [
  "indemnif",
  "termination",
  "terminate",
  "exclusiv",
  "penalt",
  "liquidated damages",
  "waiv",
  "arbitrat",
  "change of control",
  "cap on liability",
  "limitation of liability",
  "deadline",
  "no later than",
  "shall not",
  "must be filed",
  "statute of limitations",
  "sanction",
  "privileg",
  "confidential",
  "settlement",
  "tolling",
  "governing law",
  "jurisdiction",
  "injunction",
  "breach",
  "default",
  "force majeure",
  "audit right",
  "most favored",
  "assignment",
  "survival",
];

/** Facts of these kinds must survive into the final memo. */
export const CRITICAL_FACT_KINDS: FactKind[] = ["date", "amount", "deadline"];

// ============================================================================
// Reading engine (Fireworks) settings
// ============================================================================

/** Max parallel digest calls when the reading passes run on Fireworks. */
export const FIREWORKS_SECTION_CONCURRENCY = 16;

/** Max parallel digest calls on Claude. */
export const CLAUDE_SECTION_CONCURRENCY = 8;

/**
 * Modes that run each section digest twice and cross-analyze the fact lists.
 * Only standard mode: fast is single-pass by design, and thorough already uses
 * the stricter (and much more consistent) reader, so a second pass adds little.
 */
export function dualPassFor(mode: SummarizeMode): boolean {
  return mode === "standard";
}

/** Max parallel digest calls on the slower, stricter thorough-mode reader. */
export const PRECISE_SECTION_CONCURRENCY = 12;

// ============================================================================
// Scan → Route → Read → Verify → Write
// ============================================================================

/** Max questions the router may set as the document's coverage target. */
export const MAX_ROUTED_QUESTIONS = 15;

/** Pages either side of a cited page shown to the verifier / used for dedupe. */
export const VERIFY_PAGE_WINDOW = 2;

/** Max claims checked in one verification call. */
export const VERIFY_MAX_CLAIMS_PER_CALL = 8;

/** Parallel verification calls in flight. */
export const VERIFY_CONCURRENCY = 12;

export type VerificationMode = "off" | "critical" | "full";

/** How much of the ledger gets re-checked against the source pages. */
export function verificationFor(mode: SummarizeMode): VerificationMode {
  if (mode === "fast") return "off";
  if (mode === "thorough") return "full";
  return "critical";
}

/** Max tokens for a skim-tier section read (one line, no fact extraction). */
export const SKIM_MAX_TOKENS = 300;
