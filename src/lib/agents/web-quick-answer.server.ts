// ============================================================================
// Fast web "quick answer" (server-only).
//
// The research agent's fast tier wants ONE accurate, source-grounded sentence
// or two BEFORE it decides whether a full loop is even needed. This module
// synthesizes that quick answer from the web_search results the agent already
// ranked — no extra search, no new source. It is:
//
//   * OFF by default. Enabled only when WEB_QUICK_ANSWER=on (or =1). An unset
//     environment is byte-for-byte unaffected: quickWebAnswer() returns null and
//     the search outcome is exactly what it was before.
//   * FAIL-OPEN. No model creds, a generation error, an empty/ungrounded answer,
//     or the tight time budget all resolve to null. A quick answer is a bonus on
//     top of the ranked results, never a gate in front of them.
//   * GROUNDED. The model is handed ONLY the ranked snippets and must cite them
//     with the run's own [S#] refs. An answer that cites nothing in the pool is
//     discarded — we never surface an ungrounded claim as a "quick answer".
//
// The generation call is injected (`generate`) so the synthesis logic — prompt
// assembly, citation mapping, grounding guard, fallback — is pure and unit
// tested without a live model. The default binds to the fast Bedrock agent
// model with a small token budget.
// ============================================================================
import { BEDROCK_AGENT_MODEL, bedrockChat, bedrockEnabled, userText } from "./bedrock.server";

/** A single ranked web result, normalized for synthesis. */
export type QuickAnswerSource = {
  /** The run's stable SourceBook ref, e.g. "S3" (no brackets). */
  ref: string;
  title: string;
  url: string;
  /** The query-focused evidence excerpt already selected by the ranker. */
  evidence: string;
  /** Best-known publication/effective date, when the ranker resolved one. */
  date?: string;
};

/** A synthesized quick answer plus the refs it actually cites. */
export type QuickAnswer = {
  /** 1-3 sentences, each claim carrying a [S#] citation from `citations`. */
  text: string;
  /** The distinct source refs (e.g. ["S1","S3"]) cited by `text`, in order. */
  citations: string[];
};

/** Injectable one-shot text generator. Returns the model's raw text. */
export type QuickAnswerGenerate = (args: {
  system: string;
  user: string;
  maxTokens: number;
  signal?: AbortSignal;
}) => Promise<string>;

/** How many top sources the model is shown. More adds latency without lift. */
const MAX_SOURCES = 6;
/** Per-source evidence budget (chars) — enough to ground a sentence, no more. */
const EVIDENCE_BUDGET = 600;
/** Output token cap: a quick answer is a sentence or two, never a memo. */
const MAX_OUTPUT_TOKENS = 320;
/** Wall-clock budget for the synthesis call. The fast tier cannot wait long. */
const DEFAULT_TIMEOUT_MS = 2_500;

/** True only when the quick-answer synthesis is explicitly turned on. */
export function quickAnswerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env["WEB_QUICK_ANSWER"] ?? "").trim().toLowerCase();
  return v === "on" || v === "1" || v === "true";
}

const trunc = (v: string, n: number) => (v.length > n ? `${v.slice(0, n - 1)}…` : v);

const SYSTEM_PROMPT =
  "You are the fast-answer step of a legal research agent. Using ONLY the numbered SOURCES, " +
  "write the single most useful direct answer to the QUESTION in at most three sentences. " +
  "Cite every factual claim inline with its source tag in square brackets, e.g. [S2]. " +
  "Use only the [S#] tags shown; never invent a tag or a fact not in the sources. " +
  "If the sources do not actually answer the question, reply with exactly: INSUFFICIENT. " +
  "No preamble, no headings, no bullet points — just the answer.";

/** Build the (system, user) prompt for the synthesis call. Pure. */
export function buildQuickAnswerPrompt(
  query: string,
  sources: readonly QuickAnswerSource[],
): { system: string; user: string } {
  const shown = sources.slice(0, MAX_SOURCES);
  const block = shown
    .map((s) => {
      const stamp = s.date ? `, ${s.date}` : "";
      const head = `[${s.ref}] ${s.title || s.url || "source"}${stamp}`;
      return `${head}\n${trunc(s.evidence || "", EVIDENCE_BUDGET)}`;
    })
    .join("\n\n");
  const user = `QUESTION: ${query.trim()}\n\nSOURCES:\n${block}\n\nANSWER:`;
  return { system: SYSTEM_PROMPT, user };
}

const CITATION_RE = /\[(S\d+)\]/g;

/**
 * Validate and normalize the model's text into a grounded QuickAnswer, or null.
 * Rejects empty output, the explicit INSUFFICIENT sentinel, and answers whose
 * citations do not resolve to a source in the pool (ungrounded). Pure.
 */
export function formatQuickAnswer(
  modelText: string,
  sources: readonly QuickAnswerSource[],
): QuickAnswer | null {
  const text = (modelText || "").trim();
  if (!text) return null;
  if (/^insufficient\b/i.test(text)) return null;

  const known = new Set(sources.map((s) => s.ref));
  const cited: string[] = [];
  for (const m of text.matchAll(CITATION_RE)) {
    const ref = m[1]!;
    if (known.has(ref) && !cited.includes(ref)) cited.push(ref);
  }
  // A quick answer with no resolvable citation is an ungrounded claim — drop it.
  if (!cited.length) return null;

  // Strip any hallucinated tags that do not resolve, but keep the prose.
  const cleaned = text.replace(CITATION_RE, (whole, ref: string) =>
    known.has(ref) ? whole : "",
  );
  const normalized = cleaned.replace(/[ \t]{2,}/g, " ").replace(/\s+([.,;:])/g, "$1").trim();
  if (!normalized) return null;

  return { text: normalized, citations: cited };
}

/** Default generator: one non-streaming call on the fast Bedrock agent model. */
const defaultGenerate: QuickAnswerGenerate = async ({ system, user, maxTokens, signal }) => {
  const res = await bedrockChat({
    model: BEDROCK_AGENT_MODEL,
    system,
    messages: [userText(user)],
    maxTokens,
    temperature: 0,
    ...(signal ? { signal } : {}),
  });
  return res.text;
};

/**
 * Synthesize a fast, grounded quick answer from already-ranked web sources.
 * Returns null (never throws) whenever it is disabled, has nothing to work
 * with, cannot reach a model, exceeds its time budget, or the model declines /
 * produces an ungrounded answer. Safe to call on every research web_search.
 */
export async function quickWebAnswer(opts: {
  query: string;
  sources: readonly QuickAnswerSource[];
  generate?: QuickAnswerGenerate;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Require at least this many sources before spending a model call (default 2). */
  minSources?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<QuickAnswer | null> {
  const env = opts.env ?? process.env;
  if (!quickAnswerEnabled(env)) return null;

  const query = (opts.query || "").trim();
  if (query.length < 3) return null;

  const sources = opts.sources.filter((s) => s.ref && (s.evidence || s.title));
  const minSources = opts.minSources ?? 2;
  if (sources.length < minSources) return null;

  const generate = opts.generate ?? defaultGenerate;
  // The default generator needs Bedrock creds; skip the round-trip when absent.
  if (!opts.generate && !bedrockEnabled()) return null;

  const { system, user } = buildQuickAnswerPrompt(query, sources);

  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  try {
    const raw = await generate({
      system,
      user,
      maxTokens: MAX_OUTPUT_TOKENS,
      signal: controller.signal,
    });
    return formatQuickAnswer(raw, sources);
  } catch {
    // Timeout, abort, model error, or credential failure: fail open to null.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Render a quick answer as the leading block of a tool outcome's text. */
export function renderQuickAnswerBlock(answer: QuickAnswer): string {
  return `**Quick answer:** ${answer.text}`;
}
