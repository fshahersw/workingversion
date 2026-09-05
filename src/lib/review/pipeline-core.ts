// ============================================================================
// Review pipeline — pure, side-effect-free helpers.
//
// Everything here is deterministic and runs anywhere (server, worker, tests).
// No network, no env, no `@/` imports so the Node test runner can load it
// directly. The server module composes these into the extract → verify flow.
// ============================================================================
import type { CellCitation, ColumnKind, JsonValue } from "./types.ts";

import { displayValue } from "./types.ts";

// ---------------------------------------------------------------------------
// Model registry
// ---------------------------------------------------------------------------

/** How a model is reached on Bedrock. */
export type Transport = "converse" | "mantle";

export const MODELS = {
  /** Primary extractor — fast, instruction-following, 256K context. */
  nemotronSuper: "nvidia.nemotron-super-3-120b",
  /** Cheap verifier / first fallback. */
  nemotronNano: "nvidia.nemotron-nano-3-30b",
  /** Different model family for independent verification. On-demand Converse. */
  gemma: "google.gemma-3-27b-it",
  /** Heavy synthesis (table insights, prompt improvement). On-demand Converse. */
  kimi: "moonshotai.kimi-k2.5",
} as const;

export type ModelId = (typeof MODELS)[keyof typeof MODELS];

/**
 * All models now run through Bedrock Converse on bedrock-runtime (SigV4-signed
 * via the default credential chain). The old OpenAI-compatible mantle endpoint
 * and its static bearer token are no longer used.
 */
export function transportFor(_model: string): Transport {
  return "converse";
}

/** Nemotron 3 reasons by default; this directive turns it off. */
export function needsNoThink(model: string): boolean {
  return /^nvidia\./.test(model);
}

/**
 * Super (120B) is off the hot path — it was failing often enough that every
 * cell paid a timeout before Nano ran. Nano first; Gemma as a different
 * provider. Super stays in MODELS if we want it back behind a flag later.
 */
export const EXTRACT_CHAIN: readonly string[] = [MODELS.nemotronNano, MODELS.gemma];

/** Verify with a different family than extract when possible. */
export const VERIFY_CHAIN: readonly string[] = [MODELS.gemma, MODELS.nemotronNano];

export const HEAVY_CHAIN: readonly string[] = [MODELS.kimi, MODELS.nemotronNano];

/** Same model, same call — worth retrying before walking the chain. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 502 || status === 503 || status >= 500;
}

export function backoffMs(attempt: number, baseMs = 400, capMs = 8_000, retryAfterMs?: number): number {
  if (retryAfterMs && retryAfterMs > 0) return Math.min(capMs, retryAfterMs);
  const exp = Math.min(capMs, baseMs * 2 ** attempt);
  const jitter = Math.floor(Math.random() * 200);
  return exp + jitter;
}

/**
 * Per-process skip list. A 400/403/404 from Super (wrong region, no
 * subscription) should not be retried on every cell for the next 10 minutes.
 * 429 opens a short cool-down; three consecutive 5xx open a 60s skip.
 */
export type ModelCircuit = {
  isOpen: (model: string) => boolean;
  recordSuccess: (model: string) => void;
  recordFailure: (model: string, status: number) => void;
};

export function createModelCircuit(now: () => number = Date.now): ModelCircuit {
  const until = new Map<string, number>();
  const streak = new Map<string, number>();

  return {
    isOpen(model) {
      return now() < (until.get(model) ?? 0);
    },
    recordSuccess(model) {
      streak.delete(model);
      until.delete(model);
    },
    recordFailure(model, status) {
      if (status === 401) return;
      if (status === 400 || status === 403 || status === 404) {
        until.set(model, now() + 10 * 60_000);
        return;
      }
      if (status === 429 || status === 503) {
        until.set(model, now() + 8_000);
        return;
      }
      const n = (streak.get(model) ?? 0) + 1;
      streak.set(model, n);
      if (n >= 3) until.set(model, now() + 60_000);
    },
  };
}

/**
 * Statuses worth trying the next model on. 400/404 cover "this model rejects
 * that parameter / isn't in this region"; 403 covers the auto-subscription
 * window Bedrock opens on first use of a third-party model.
 */
export function isFallbackStatus(status: number): boolean {
  return (
    status === 400 ||
    status === 403 ||
    status === 404 ||
    status === 408 ||
    status === 429 ||
    status >= 500
  );
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/** Drop any reasoning block a model may emit ahead of its answer. */
export function stripThinking(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
}

/** First balanced JSON object in the text, tolerant of prose around it. */
export function firstJsonObject(raw: string): Record<string, unknown> | null {
  const text = stripThinking(raw);
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1)) as Record<string, unknown>;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Deterministic citation checking
//
// The model's quote must actually appear on the page it cites. This is the
// cheapest, highest-yield hallucination check in the pipeline: no tokens,
// no latency, and it catches the most common failure (a plausible quote
// that was paraphrased or invented).
// ---------------------------------------------------------------------------

/** Collapse whitespace, fold quotes/dashes, lowercase. OCR-tolerant. */
export function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\u2018\u2019\u201a\u201b]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f]/g, '"')
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/\u00a0/g, " ")
    .replace(/[^\p{L}\p{N}\s.,;:'"()$%/-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type QuoteMatch = "exact" | "normalized" | "fuzzy" | "none";

/**
 * Does `quote` appear on `pageText`? Tries exact, then normalized, then a
 * token-window fuzzy match that tolerates a few OCR errors. Quotes under
 * ~4 words are too weak to fuzzy-match and must appear verbatim.
 */
export function quoteOnPage(quote: string, pageText: string): QuoteMatch {
  const q = quote.trim();
  if (!q || !pageText) return "none";
  if (pageText.includes(q)) return "exact";

  const nq = normalizeForMatch(q);
  const np = normalizeForMatch(pageText);
  if (!nq) return "none";
  if (np.includes(nq)) return "normalized";

  const qTokens = nq.split(" ").filter(Boolean);
  if (qTokens.length < 4) return "none";
  const pTokens = np.split(" ").filter(Boolean);
  if (pTokens.length < qTokens.length) return "none";

  // Slide a window the size of the quote across the page; accept when ≥85%
  // of tokens line up. Cheap enough for page-sized inputs.
  const need = Math.ceil(qTokens.length * 0.85);
  for (let i = 0; i + qTokens.length <= pTokens.length; i++) {
    let hits = 0;
    for (let j = 0; j < qTokens.length; j++) {
      if (pTokens[i + j] === qTokens[j]) hits++;
    }
    if (hits >= need) return "fuzzy";
  }
  return "none";
}

export type CitationCheck = {
  /** Citations whose quote was found on the cited page. */
  verified: CellCitation[];
  /** Citations dropped, with the reason — surfaced in the rationale. */
  rejected: { page: number; quote: string; reason: string }[];
};

/**
 * Validate model-returned citations against the pages the model was given.
 * Page must be one we sent; quote must be on that page.
 */
export function checkCitations(
  raw: unknown,
  pages: { page: number; text: string }[],
  fileName: string,
  max = 6,
): CitationCheck {
  const verified: CellCitation[] = [];
  const rejected: CitationCheck["rejected"] = [];
  if (!Array.isArray(raw)) return { verified, rejected };

  const byPage = new Map(pages.map((p) => [p.page, p.text]));
  for (const item of raw.slice(0, max)) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const page = Number(rec["page"]);
    const quote = String(rec["quote"] ?? "")
      .trim()
      .slice(0, 600);
    if (!Number.isFinite(page) || !quote) continue;

    const text = byPage.get(page);
    if (text === undefined) {
      rejected.push({ page, quote, reason: "cited a page that was not provided" });
      continue;
    }
    const match = quoteOnPage(quote, text);
    if (match === "none") {
      rejected.push({ page, quote, reason: "quote not found on that page" });
      continue;
    }
    verified.push({ page, quote, fileName });
  }
  return { verified, rejected };
}

// ---------------------------------------------------------------------------
// Value normalization by column kind
// ---------------------------------------------------------------------------

export function normalizeValue(
  parsed: Record<string, unknown>,
  kind: ColumnKind,
  options: string[],
): JsonValue {
  const value = parsed["value"];
  if (value === null || value === undefined) return null;
  if (kind === "yes_no") {
    const s = String(value).trim().toLowerCase();
    if (s.startsWith("y")) return "Yes";
    if (s.startsWith("n")) return "No";
    return "Unclear";
  }
  if (kind === "number") {
    const n =
      typeof value === "number" ? value : Number(String(value).replace(/[^0-9.-]/g, ""));
    if (!Number.isFinite(n)) return null;
    const unit = String(parsed["unit"] ?? "").trim();
    return unit ? `${n} ${unit}` : n;
  }
  if (kind === "select") {
    const s = String(value).trim();
    return options.find((o) => o.toLowerCase() === s.toLowerCase()) ?? s;
  }
  if (kind === "multi_select" || kind === "list") {
    const arr = Array.isArray(value) ? value : String(value).split(/[;,]/);
    const cleaned = arr.map((v) => String(v).trim()).filter(Boolean);
    if (kind === "multi_select") {
      return cleaned
        .map((v) => options.find((o) => o.toLowerCase() === v.toLowerCase()) ?? v)
        .filter((v, i, a) => a.indexOf(v) === i);
    }
    return cleaned.slice(0, 24);
  }
  return typeof value === "object" ? displayValue(value) : (value as JsonValue);
}

export type Confidence = "high" | "medium" | "low";

export function parseConfidence(raw: unknown): Confidence {
  const s = String(raw ?? "medium").toLowerCase();
  return s === "high" || s === "low" ? s : "medium";
}
