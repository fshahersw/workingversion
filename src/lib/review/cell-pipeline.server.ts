// ============================================================================
// Review cell pipeline (server-only): extract → check citations → verify.
//
// Retrieval is NOT done here. The browser's Pile index (BM25 + embeddings)
// already picks the relevant pages per document per question and sends them
// up — that is the RAG layer, and it costs no tokens. This module takes those
// pages and runs two cheap model passes on top of a deterministic check:
//
//   1. EXTRACT  nemotron-nano → gemma
//              One strict-JSON answer with page-cited verbatim quotes.
//   2. CHECK    no model. Every quote must literally appear on its page.
//              Rejected citations are dropped and noted in the rationale.
//   3. VERIFY   gemma → nemotron-nano
//              A *different* family reads the same pages and the answer and
//              says whether the surviving quotes actually support it.
//
// Any stage's model call falls through the chain on 400/403/404/429/5xx, so a
// region gap or Bedrock's first-use subscription window degrades instead of
// failing. Heavy synthesis (table insights, prompt rewriting) goes to Kimi.
//
// One Bedrock transport: Converse on bedrock-runtime for every model
// (Nemotron, Gemma, Kimi), SigV4-signed via the default credential chain (see
// bedrock-sign.server.ts) — no static bearer token, no mantle endpoint.
// ============================================================================

import {
  BEDROCK_PILE_WRITER_MODEL,
  bedrockClaudeEnabled,
  streamWriter,
} from "@/lib/agents/bedrock-claude.server";
import { signedBedrockFetch, bedrockCredsReady } from "@/lib/agents/bedrock-sign.server";
import { parseRetryAfterMs, sleep } from "@/lib/pile/async";

import {
  EXTRACT_CHAIN,
  HEAVY_CHAIN,
  VERIFY_CHAIN,
  VISION_CHAIN,
  backoffMs,
  checkCitations,
  constrainValue,
  createModelCircuit,
  firstJsonObject,
  isFallbackStatus,
  isRetryableStatus,
  needsNoThink,
  parseConfidence,
  type Confidence,
} from "./pipeline-core";
import { CELL_SYSTEM, buildCellUser } from "./prompt";
import {
  REVIEW_ESCALATE_LOW_CONFIDENCE,
  REVIEW_PIPELINE_VERSION,
  displayValue,
  type CellAnswer,
  type CellPageImage,
  type CellRequest,
} from "./types";

const REGION = process.env["BEDROCK_REGION"] ?? "us-east-1";

export class PipelineError extends Error {
  status: number;
  model: string;
  retryAfterMs?: number;
  constructor(status: number, model: string, message: string, retryAfterMs?: number) {
    super(message);
    this.status = status;
    this.model = model;
    this.retryAfterMs = retryAfterMs;
    this.name = "PipelineError";
  }
}

const circuit = createModelCircuit();
const CALL_TRIES = 3;
const EXTRACT_TIMEOUT_MS = 25_000;
const VERIFY_TIMEOUT_MS = 15_000;
const HEAVY_TIMEOUT_MS = 45_000;
const VISION_TIMEOUT_MS = 40_000;

export function pipelineEnabled(): boolean {
  return bedrockCredsReady();
}

/** Identity baked into cell cache keys; bump when prompts or chains change. */
export function pipelineModel(): string {
  return REVIEW_PIPELINE_VERSION;
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

type ModelCall = {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  temperature?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Page images placed before the text (Converse image blocks). */
  images?: CellPageImage[];
};

function converseImageFormat(mediaType: CellPageImage["mediaType"]): "jpeg" | "png" | "webp" {
  return mediaType === "image/png" ? "png" : mediaType === "image/webp" ? "webp" : "jpeg";
}

function childSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const ctrl = new AbortController();
  if (parent?.aborted) ctrl.abort();
  const onParent = () => ctrl.abort();
  parent?.addEventListener("abort", onParent, { once: true });
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  return {
    signal: ctrl.signal,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParent);
    },
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

async function converseOnce(req: ModelCall): Promise<string> {
  const system = needsNoThink(req.model) ? `/no_think\n\n${req.system}` : req.system;
  const res = await signedBedrockFetch(
    `https://bedrock-runtime.${REGION}.amazonaws.com/model/${encodeURIComponent(req.model)}/converse`,
    {
      body: JSON.stringify({
        system: [{ text: system }],
        messages: [
          {
            role: "user",
            content: [
              ...(req.images ?? []).map((image) => ({
                image: {
                  format: converseImageFormat(image.mediaType),
                  source: { bytes: image.data },
                },
              })),
              { text: req.user },
            ],
          },
        ],
        inferenceConfig: { maxTokens: req.maxTokens, temperature: req.temperature ?? 0 },
      }),
      ...(req.signal ? { signal: req.signal } : {}),
    },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new PipelineError(
      res.status,
      req.model,
      `Converse ${req.model} failed [${res.status}]: ${detail.slice(0, 300)}`,
      parseRetryAfterMs(res.headers.get("retry-after")),
    );
  }
  const json = (await res.json()) as {
    output?: { message?: { content?: { text?: string }[] } };
  };
  const text = (json.output?.message?.content ?? []).map((c) => c.text ?? "").join("");
  if (!text.trim()) throw new PipelineError(502, req.model, `${req.model} returned no text`);
  return text;
}

/** Every model (Nemotron, Gemma, Kimi) runs through Bedrock Converse, SigV4-signed. */
function callModel(req: ModelCall): Promise<string> {
  return converseOnce(req);
}

function statusOf(err: unknown): number {
  return err instanceof PipelineError ? err.status : 500;
}

function isUserAbort(err: unknown, parent?: AbortSignal): boolean {
  return (
    parent?.aborted === true ||
    (err instanceof DOMException && err.name === "AbortError" && !!parent?.aborted)
  );
}

/**
 * One model, up to CALL_TRIES, with timeout + exponential backoff. User abort
 * is never retried. A per-call timeout becomes 408 and is retried, then the
 * chain moves on.
 */
async function callWithRetry(req: ModelCall): Promise<string> {
  const timeoutMs = req.timeoutMs ?? EXTRACT_TIMEOUT_MS;
  let last: unknown;
  for (let attempt = 0; attempt < CALL_TRIES; attempt++) {
    throwIfAborted(req.signal);
    const scoped = childSignal(req.signal, timeoutMs);
    try {
      const text = await callModel({ ...req, signal: scoped.signal });
      circuit.recordSuccess(req.model);
      return text;
    } catch (err) {
      scoped.cleanup();
      if (isUserAbort(err, req.signal)) throw new DOMException("Aborted", "AbortError");

      const timedOut = scoped.signal.aborted && !req.signal?.aborted;
      const wrapped = timedOut
        ? new PipelineError(408, req.model, `${req.model} timed out after ${timeoutMs}ms`)
        : err;
      last = wrapped;
      const status = statusOf(wrapped);
      circuit.recordFailure(req.model, status);
      const retryable = timedOut || isRetryableStatus(status);
      if (!retryable || attempt === CALL_TRIES - 1)
        throw wrapped instanceof Error ? wrapped : new Error(String(wrapped));
      const wait = backoffMs(
        attempt,
        status === 429 ? 800 : 400,
        8_000,
        wrapped instanceof PipelineError ? wrapped.retryAfterMs : undefined,
      );
      await sleep(wait, req.signal);
      continue;
    } finally {
      scoped.cleanup();
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/**
 * Walk the chain. Skip models the circuit has opened (wrong region, no
 * access, repeated 5xx). Retry the same model on 429/5xx/timeout before
 * falling through.
 */
async function callChain(
  chain: readonly string[],
  req: Omit<ModelCall, "model">,
): Promise<{ text: string; model: string; attempts: string[] }> {
  const attempts: string[] = [];
  let last: unknown;
  for (const model of chain) {
    throwIfAborted(req.signal);
    if (circuit.isOpen(model)) {
      attempts.push(`${model}:skipped`);
      continue;
    }
    try {
      const text = await callWithRetry({ ...req, model });
      return { text, model, attempts };
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      last = err;
      attempts.push(model);
      if (!isFallbackStatus(statusOf(err))) throw err;
    }
  }
  throw last instanceof Error ? last : new Error("All models in the chain failed");
}

// ---------------------------------------------------------------------------
// Stage 1 — extract
// ---------------------------------------------------------------------------

type Extracted = CellAnswer & {
  model: string;
  rejectedCitations: { page: number; quote: string; reason: string }[];
};

function parseExtracted(
  text: string,
  model: string,
  req: CellRequest,
  opts: { imagePages?: Set<number> } = {},
): Extracted {
  const parsed = firstJsonObject(text);
  if (!parsed) throw new PipelineError(502, model, `${model} did not return a JSON object`);

  const rawStatus = String(parsed["status"] ?? "").toLowerCase();
  const checked = checkCitations(parsed["citations"], req.pages, req.fileName);
  // A quote read from a page image cannot be expected to appear in a text
  // layer the OCR got wrong. Keep it, on a page we actually sent, and mark it
  // so the reviewer knows to check the image rather than search the text.
  const verified = [...checked.verified];
  const rejected: typeof checked.rejected = [];
  for (const r of checked.rejected) {
    if (opts.imagePages?.has(r.page) && r.reason === "quote not found on that page") {
      verified.push({ page: r.page, quote: r.quote, fileName: req.fileName, fromImage: true });
    } else {
      rejected.push(r);
    }
  }
  const { value, unmatched } = constrainValue(parsed, req.kind, req.options);
  const rationale = String(parsed["rationale"] ?? "")
    .trim()
    .slice(0, 600);
  const confidence = parseConfidence(parsed["confidence"]);
  const pagesSearched = req.pages.map((p) => p.page);

  if (rawStatus === "not_found" || value === null || value === "") {
    return {
      value: null,
      display: "",
      status: "not_found",
      confidence,
      citations: [],
      rationale: rationale || `Not addressed on pages ${pagesSearched.join(", ")}.`,
      model,
      rejectedCitations: rejected,
    };
  }

  // A constrained column never stores a spelling that is not one of its
  // options; the near-miss is kept visible and the cell flagged for a human.
  const status =
    rawStatus === "needs_review" ||
    verified.length === 0 ||
    confidence === "low" ||
    unmatched.length
      ? "needs_review"
      : "answered";

  const notes = [
    rejected.length && verified.length === 0
      ? `${rejected.length} citation${rejected.length > 1 ? "s" : ""} could not be located on the cited page${rejected.length > 1 ? "s" : ""}`
      : "",
    unmatched.length
      ? `not one of the allowed options: ${unmatched.map((u) => `"${u}"`).join(", ")}`
      : "",
  ].filter(Boolean);

  return {
    value,
    display: displayValue(value),
    status,
    confidence: unmatched.length && confidence === "high" ? "medium" : confidence,
    citations: verified,
    rationale: `${rationale}${notes.length ? ` (${notes.join("; ")})` : ""}`.trim(),
    model,
    rejectedCitations: rejected,
  };
}

async function extract(req: CellRequest, signal?: AbortSignal): Promise<Extracted> {
  const { text, model } = await callChain(EXTRACT_CHAIN, {
    system: CELL_SYSTEM,
    user: buildCellUser(req),
    maxTokens: 1600,
    temperature: 0,
    signal,
    timeoutMs: EXTRACT_TIMEOUT_MS,
  });
  return parseExtracted(text, model, req);
}

/** Escalation judge — same pages, stronger model. */
async function extractWithSonnet(req: CellRequest, signal?: AbortSignal): Promise<Extracted> {
  if (!bedrockClaudeEnabled()) {
    throw new PipelineError(401, BEDROCK_PILE_WRITER_MODEL, "Bedrock Claude is not configured");
  }
  const res = await streamWriter({
    model: BEDROCK_PILE_WRITER_MODEL,
    system: CELL_SYSTEM,
    messages: [{ role: "user", content: buildCellUser(req) }],
    maxTokens: 4000,
    effort: "low",
    ...(signal ? { signal } : {}),
  });
  return parseExtracted(res.text, BEDROCK_PILE_WRITER_MODEL, req);
}

const VISION_PREAMBLE = `Page images are attached for the pages listed below. Their text layer came
from OCR and may be wrong or incomplete: read the images directly and treat them as the
source of truth wherever the text disagrees. Quote what the page image says, character for
character as printed.`;

/**
 * Vision re-read: the same question, answered from page images. Cheap VL
 * models first (Nemotron Nano 2 VL, then Qwen3-VL) through Converse; the
 * Anthropic judge is the last resort when the whole chain is unavailable.
 * Used for cells that came back flagged on scanned pages.
 */
async function extractFromImages(req: CellRequest, signal?: AbortSignal): Promise<Extracted> {
  const images = (req.images ?? []).slice(0, 4);
  const pageList = images.map((image) => image.page).join(", ");
  const user = `${VISION_PREAMBLE}\nAttached page images: ${pageList}\n\n${buildCellUser(req)}`;
  const imagePages = new Set(images.map((image) => image.page));
  try {
    const { text, model } = await callChain(VISION_CHAIN, {
      system: CELL_SYSTEM,
      user,
      images,
      maxTokens: 1600,
      temperature: 0,
      signal,
      timeoutMs: VISION_TIMEOUT_MS,
    });
    return parseExtracted(text, model, req, { imagePages });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    if (!bedrockClaudeEnabled()) throw err;
  }
  const res = await streamWriter({
    model: BEDROCK_PILE_WRITER_MODEL,
    system: CELL_SYSTEM,
    messages: [
      {
        role: "user",
        content: user,
        images: images.map((image) => ({ mediaType: image.mediaType, data: image.data })),
      },
    ],
    maxTokens: 4000,
    effort: "medium",
    ...(signal ? { signal } : {}),
  });
  return parseExtracted(res.text, BEDROCK_PILE_WRITER_MODEL, req, { imagePages });
}

function shouldEscalate(answer: PipelineAnswer): boolean {
  if (!REVIEW_ESCALATE_LOW_CONFIDENCE) return false;
  if (answer.confidence === "low") return true;
  if (answer.status === "needs_review") return true;
  if (answer.verified === false) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Stage 3 — verify (independent model)
// ---------------------------------------------------------------------------

const VERIFY_SYSTEM = `You audit one extracted answer against the source pages it claims to rest on.

Rules:
1. Judge only from the pages given. Do not use outside knowledge.
2. "supported" is true only when the cited quotes, read in context on their
   pages, establish the answer. Partial or tangential support is false.
3. Look for text on any page that contradicts the answer. If found, quote it.
4. Return one JSON object and nothing else — no markdown fence, no prose.`;

function buildVerifyUser(input: {
  question: string;
  kind: string;
  answer: string;
  citations: { page: number; quote: string }[];
  pages: { page: number; text: string }[];
}): string {
  const cites = input.citations.map((c) => `- page ${c.page}: "${c.quote}"`).join("\n");
  const pages = input.pages.map((p) => `--- page ${p.page} ---\n${p.text.trim()}`).join("\n\n");
  return `Question: ${input.question}
Answer type: ${input.kind}
Extracted answer: ${input.answer}

Citations the extractor relied on:
${cites}

Return exactly:
{
  "supported": true | false,
  "contradiction": null | "<page N>: <verbatim contradicting text>",
  "confidence": "high" | "medium" | "low",
  "note": "<one sentence, only when supported is false or a contradiction exists>"
}

Pages:

${pages}`;
}

type Verified = {
  supported: boolean;
  contradiction: string | null;
  confidence: Confidence;
  note: string;
  model: string;
};

async function verify(
  req: CellRequest,
  answer: Extracted,
  signal?: AbortSignal,
): Promise<Verified> {
  const { text, model } = await callChain(VERIFY_CHAIN, {
    system: VERIFY_SYSTEM,
    user: buildVerifyUser({
      question: req.question,
      kind: req.kind,
      answer: answer.display,
      citations: answer.citations,
      pages: req.pages,
    }),
    maxTokens: 1200,
    temperature: 0,
    signal,
    timeoutMs: VERIFY_TIMEOUT_MS,
  });

  const parsed = firstJsonObject(text);
  if (!parsed) {
    return {
      supported: false,
      contradiction: null,
      confidence: "low",
      note: "verifier returned no parseable judgment",
      model,
    };
  }
  const contradiction = parsed["contradiction"];
  return {
    supported: parsed["supported"] === true,
    contradiction:
      typeof contradiction === "string" && contradiction.trim() ? contradiction.trim() : null,
    confidence: parseConfidence(parsed["confidence"]),
    note: String(parsed["note"] ?? "")
      .trim()
      .slice(0, 300),
    model,
  };
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export type PipelineAnswer = CellAnswer & {
  /** Model that produced the answer (after any fallback). */
  extractModel: string;
  /** Model that audited it, when verification ran. */
  verifyModel: string | null;
  /** null = verification skipped (not_found / needs_review / disabled). */
  verified: boolean | null;
};

export type PipelineOptions = {
  /** Skip the verify pass — faster, less safe. */
  skipVerify?: boolean;
  /** Skip Sonnet 5 escalation on low-confidence / needs_review cells. */
  skipEscalate?: boolean;
  signal?: AbortSignal;
};

/**
 * Extract → deterministic citation check → independent verify.
 *
 * Verification only runs on cells the extractor called "answered" with at
 * least one surviving citation; everything else is already flagged. A failed
 * verification downgrades the cell to needs_review and explains why, so the
 * human sees the disagreement rather than a silently confident wrong answer.
 */
export async function runCellPipeline(
  req: CellRequest,
  opts: PipelineOptions = {},
): Promise<PipelineAnswer> {
  if (!req.pages.length && !req.images?.length) {
    return {
      value: null,
      display: "",
      status: "needs_review",
      confidence: "low",
      citations: [],
      rationale: "No source pages were available. Document-wide absence cannot be inferred.",
      extractModel: "none",
      verifyModel: null,
      verified: null,
    };
  }

  // Vision re-read: page images from a scanned document whose text layer let
  // the first pass down. A VL model reads the images; the text verifier cannot,
  // so the answer is capped at medium confidence and labelled for the reviewer.
  if (req.images?.length) {
    const seen = await extractFromImages(req, opts.signal);
    const fromImage = seen.citations.some((c) => c.fromImage);
    return {
      value: seen.value,
      display: seen.display,
      status: seen.status,
      confidence:
        seen.status === "answered" && seen.confidence === "high" ? "medium" : seen.confidence,
      citations: seen.citations,
      rationale: `${seen.rationale} [read from page image${
        req.images.length === 1 ? "" : "s"
      }${fromImage ? "; quotes taken from the image, not the text layer" : ""}]`.trim(),
      extractModel: `${seen.model}+vision`,
      verifyModel: null,
      verified: null,
    };
  }

  const extracted = await extract(req, opts.signal);
  const base: PipelineAnswer = {
    value: extracted.value,
    display: extracted.display,
    status: extracted.status,
    confidence: extracted.confidence,
    citations: extracted.citations,
    rationale: extracted.rationale,
    extractModel: extracted.model,
    verifyModel: null,
    verified: null,
  };

  if (opts.skipVerify || extracted.status !== "answered" || !extracted.citations.length) {
    return escalateIfNeeded(req, base, opts);
  }

  let audit: Verified;
  try {
    audit = await verify(req, extracted, opts.signal);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    // The answer stands on its verified quotes; we just couldn't get a second
    // opinion. Say so rather than fail the cell.
    return escalateIfNeeded(
      req,
      {
        ...base,
        status: "needs_review",
        confidence: "low",
        rationale: `${base.rationale} [verification unavailable; review required]`.trim(),
      },
      opts,
    );
  }

  const passed = audit.supported && !audit.contradiction && audit.confidence !== "low";
  const afterVerify: PipelineAnswer = passed
    ? {
        ...base,
        confidence:
          audit.confidence === "high" && base.confidence !== "low" ? "high" : base.confidence,
        verifyModel: audit.model,
        verified: true,
      }
    : {
        ...base,
        status: "needs_review",
        confidence: "low",
        rationale: `${base.rationale} [Verification: ${[
          !audit.supported ? "verifier found the quotes do not establish the answer" : null,
          audit.contradiction ? `contradiction: ${audit.contradiction}` : null,
          audit.confidence === "low" && audit.supported ? "verifier confidence low" : null,
          audit.note || null,
        ]
          .filter(Boolean)
          .join("; ")}]`.trim(),
        verifyModel: audit.model,
        verified: false,
      };

  return escalateIfNeeded(req, afterVerify, opts);
}

async function escalateIfNeeded(
  req: CellRequest,
  current: PipelineAnswer,
  opts: PipelineOptions,
): Promise<PipelineAnswer> {
  if (opts.skipEscalate || !shouldEscalate(current) || !bedrockClaudeEnabled()) return current;
  try {
    const sonnet = await extractWithSonnet(req, opts.signal);
    if (sonnet.status === "answered" && sonnet.citations.length) {
      // A replacement answer needs its own audit. Never inherit the previous
      // candidate's verification result or bypass a contradiction by escalation.
      const audit = opts.skipVerify
        ? null
        : await verify(req, sonnet, opts.signal).catch((error) => {
            if (opts.signal?.aborted) throw error;
            return null;
          });
      const passed =
        !!audit && audit.supported && !audit.contradiction && audit.confidence !== "low";
      return {
        value: sonnet.value,
        display: sonnet.display,
        status: passed ? "answered" : "needs_review",
        confidence: passed
          ? sonnet.confidence === "high" && audit.confidence === "high"
            ? "high"
            : "medium"
          : "low",
        citations: sonnet.citations,
        rationale:
          `${sonnet.rationale} [escalated to Sonnet 5; ${passed ? "replacement independently verified" : `review required: ${audit?.contradiction || audit?.note || "verification unavailable or unsupported"}`} ]`.trim(),
        extractModel: `${current.extractModel}+${sonnet.model}`,
        verifyModel: audit?.model ?? null,
        verified: passed,
      };
    }
    return {
      ...current,
      rationale: `${current.rationale} [Sonnet 5 review: ${sonnet.status}]`.trim(),
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    return {
      ...current,
      rationale: `${current.rationale} [Sonnet 5 escalation unavailable]`.trim(),
    };
  }
}

// ---------------------------------------------------------------------------
// Heavy synthesis — Kimi K2.5 for table-level work, not per-cell
// ---------------------------------------------------------------------------

/**
 * One call per table, not per cell: cross-document insights, column prompt
 * rewriting, conditional-column reasoning. Falls back to Nemotron Super.
 */
export async function runHeavyAnalysis(opts: {
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}): Promise<{ text: string; model: string }> {
  const { text, model } = await callChain(HEAVY_CHAIN, {
    system: opts.system,
    user: opts.user,
    maxTokens: opts.maxTokens ?? 2400,
    temperature: opts.temperature ?? 0.1,
    signal: opts.signal,
    timeoutMs: HEAVY_TIMEOUT_MS,
  });
  return { text, model };
}
