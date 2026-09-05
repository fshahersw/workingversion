// ============================================================================
// Document summarizer — scan / route / read / verify / write.
//
// Text arrives already extracted (in the browser, with page numbers), so this
// module never parses a PDF.
//
//   1. SCAN    local page map: density, headings, risk terms, boilerplate
//   2. ROUTE   one small call over the map -> doc type, tiers, question list
//   3. READ    parallel section digests, effort budgeted by tier
//   4. VERIFY  every fact re-checked against the page it cites
//   5. WRITE   hierarchical reduce, then the streamed memo
//
// Short documents skip the map/reduce pipeline entirely.
// ============================================================================
import { createHash } from "node:crypto";

import {
  AnthropicError,
  streamMessage,
  SUBAGENT_MODEL,
  WRITER_MODEL,
  type Effort,
  type StreamHandlers,
  type StreamRequest,
} from "./anthropic.server";
import {
  conflictPrompt,
  consolidatePrompt,
  sectionDigestPrompt,
  singlePassWriterPrompt,
  summaryWriterPrompt,
  targetedSweepPrompt,
} from "./prompts";
import {
  fireworksComplete,
  fireworksEnabled,
  FIREWORKS_DIGEST_MODEL,
  FIREWORKS_PRECISE_MODEL,
} from "./fireworks.server";
import { parseJsonBlock, stripJsonBlock } from "./json-extract";
import { renderPageMap, scanPages, scoreSections, type Tier } from "./doc-scan";
import { routeDocument } from "./router.server";
import { verifyFacts } from "./verify.server";
import {
  CHARS_PER_TOKEN,
  CLAUDE_SECTION_CONCURRENCY,
  CRITICAL_FACT_KINDS,
  dualPassFor,
  FACT_KINDS,
  FIREWORKS_SECTION_CONCURRENCY,
  PRECISE_SECTION_CONCURRENCY,
  SKIM_MAX_TOKENS,
  type SummarizeMode,
  fitsSinglePass,
  LEDGER_MAX_FACTS,
  REDUCE_LIMIT,
  RISK_LEXICON,
  SECTION_CHARS,
  SECTION_OVERLAP_CHARS,
  SINGLE_PASS_PROMPT_RESERVE,
  SWEEP_MAX_CALLS,
  SWEEP_MAX_CHARS,
  SWEEP_MAX_PAGES,
  VERIFY_CONCURRENCY,
  verificationFor,
  type FactKind,
  type LedgerFact,
} from "@/lib/summarizer-config";


export type PageText = { page: number; text: string };

export type SummarizeInput = {
  title: string;
  pages: PageText[];
  instructions?: string;
  matterLabel?: string;
  mode?: "fast" | "standard" | "thorough";
  signal?: AbortSignal;
};

export type SectionDigest = {
  index: number;
  from_page: number;
  to_page: number;
  digest: string;
};

export type Conflict = { issue: string; detail?: string; pages: number[] };

export type Emit = (event: string, data: unknown) => void;

/** Base parallel digest calls in flight. */
const BASE_CONCURRENCY = 6;

export type Section = { index: number; from: number; to: number; text: string };

type ModeConfig = {
  sectionMaxTokens: (textLen: number) => number;
  reduceMaxTokens: (textLen: number) => number;
  writerModel: string;
  writerMaxTokens: number;
  writerEffort: Effort;
  singlePassModel: string;
  singlePassMaxTokens: number;
  sweep: boolean;
  conflicts: boolean;
  sweepModel: string;
};

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function modeConfig(mode: "fast" | "standard" | "thorough" = "standard"): ModeConfig {
  if (mode === "fast") {
    return {
      sectionMaxTokens: (n) => clamp(Math.round(n / 16), 600, 2_500),
      reduceMaxTokens: (n) => clamp(Math.round(n / 12), 1_000, 4_000),
      writerModel: SUBAGENT_MODEL,
      writerMaxTokens: 6_000,
      writerEffort: "medium",
      singlePassModel: SUBAGENT_MODEL,
      singlePassMaxTokens: 6_000,
      sweep: false,
      conflicts: false,
      sweepModel: SUBAGENT_MODEL,
    };
  }
  if (mode === "thorough") {
    return {
      sectionMaxTokens: (n) => clamp(Math.round(n / 10), 1_200, 6_000),
      reduceMaxTokens: (n) => clamp(Math.round(n / 10), 1_500, 8_000),
      writerModel: WRITER_MODEL,
      writerMaxTokens: 16_000,
      writerEffort: "high",
      singlePassModel: WRITER_MODEL,
      singlePassMaxTokens: 12_000,
      sweep: true,
      conflicts: true,
      sweepModel: WRITER_MODEL,
    };
  }
  // standard: optimized pipeline, Sonnet final
  return {
    sectionMaxTokens: (n) => clamp(Math.round(n / 12), 800, 4_000),
    reduceMaxTokens: (n) => clamp(Math.round(n / 10), 1_200, 6_000),
    writerModel: SUBAGENT_MODEL,
    writerMaxTokens: 12_000,
    writerEffort: "high",
    singlePassModel: SUBAGENT_MODEL,
    singlePassMaxTokens: 8_000,
    sweep: true,
    conflicts: true,
    sweepModel: SUBAGENT_MODEL,
  };
}

// ---------------------------------------------------------------- helpers --

function buildFullText(title: string, pages: PageText[], matterLabel?: string, instructions?: string) {
  const parts = [`DOCUMENT: ${title}`];
  if (matterLabel) parts.push(`MATTER: ${matterLabel}`);
  if (instructions) parts.push(`ATTORNEY INSTRUCTIONS: ${instructions}`);
  parts.push("");
  for (const p of pages) {
    if ((p.text ?? "").trim()) {
      parts.push(`[p. ${p.page}]\n${p.text.trim()}`);
    }
  }
  return parts.join("\n\n");
}

const HEADING_RE =
  /^(?:[IVXLC]+\.\s|\d+(?:\.\d+)*\s|ARTICLE\b|SECTION\b|[A-Z][A-Z \u2019'\-]{6,}$)/;

/** Trailing slice of a section, cut at a clean boundary, used as overlap. */
function overlapTail(text: string, chars: number): string {
  if (text.length <= chars) return text;
  const tail = text.slice(-chars);
  const cut = tail.search(/\n\s*\n/);
  return (cut > 0 ? tail.slice(cut) : tail).trim();
}

/**
 * Drop pages whose text repeats verbatim across many pages (running headers,
 * exhibit covers, certificates of service) and pages with no real content.
 */
export function dropBoilerplatePages(pages: PageText[]): { kept: PageText[]; dropped: number } {
  const counts = new Map<string, number>();
  for (const p of pages) {
    const key = (p.text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const threshold = Math.max(3, Math.ceil(pages.length * 0.05));
  const kept: PageText[] = [];
  let dropped = 0;
  for (const p of pages) {
    const raw = (p.text ?? "").trim();
    const key = raw.replace(/\s+/g, " ").toLowerCase();
    if (!raw) {
      dropped += 1;
      continue;
    }
    // Only drop repeats that are short — a repeated long page is real content.
    if (raw.length < 400 && (counts.get(key) ?? 0) >= threshold) {
      dropped += 1;
      continue;
    }
    kept.push(p);
  }
  return { kept: kept.length ? kept : pages, dropped };
}

/** Split page text into page-aligned sections of roughly SECTION_CHARS, with overlap. */
export function buildSections(pages: PageText[]): Section[] {
  const sections: Section[] = [];
  let buf: string[] = [];
  let size = 0;
  let from = pages[0]?.page ?? 1;
  let last = from;
  let carry = "";

  const flush = () => {
    if (!buf.length) return;
    const body = buf.join("\n\n");
    const text = carry ? `[continued from earlier pages]\n${carry}\n\n${body}` : body;
    sections.push({ index: sections.length + 1, from, to: last, text });
    carry = overlapTail(body, SECTION_OVERLAP_CHARS);
    buf = [];
    size = 0;
  };

  for (const p of pages) {
    const text = (p.text ?? "").replace(/\u0000/g, "").trim();
    if (!text) continue;
    const block = `[p. ${p.page}]\n${text}`;
    const startsHeading = HEADING_RE.test(text.split("\n", 1)[0]?.trim() ?? "");
    const over = size + block.length > SECTION_CHARS;
    // Break early on a heading once we are within 15% of the target size.
    const nearTarget = size > SECTION_CHARS * 0.85;
    if (size && (over || (startsHeading && nearTarget))) {
      flush();
      from = p.page;
    }
    if (!buf.length) from = p.page;
    buf.push(block);
    size += block.length + 2;
    last = p.page;
  }
  flush();
  return sections;
}

async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ------------------------------------------------------- reading engine --

type Engine = { provider: "fireworks" | "anthropic"; model: string };

/** Which model reads the document. Falls back to Claude without a Fireworks key. */
function readingEngine(claudeModel: string, mode: SummarizeMode): Engine {
  if (!fireworksEnabled()) return { provider: "anthropic", model: claudeModel };
  return {
    provider: "fireworks",
    model: mode === "thorough" ? FIREWORKS_PRECISE_MODEL : FIREWORKS_DIGEST_MODEL,
  };
}

function concurrencyFor(sectionCount: number, engine?: Engine) {
  const cap =
    engine?.provider !== "fireworks"
      ? CLAUDE_SECTION_CONCURRENCY
      : engine.model === FIREWORKS_PRECISE_MODEL
        ? PRECISE_SECTION_CONCURRENCY
        : FIREWORKS_SECTION_CONCURRENCY;
  return Math.min(cap, Math.max(BASE_CONCURRENCY, Math.ceil(sectionCount / 4)));
}

/** One non-streaming reading call, routed to whichever engine is configured. */
async function readCall(opts: {
  engine: Engine;
  system: string;
  user: string;
  maxTokens: number;
  temperature?: number;
  signal?: AbortSignal;
}): Promise<string> {
  if (opts.engine.provider === "fireworks") {
    return fireworksComplete({
      model: opts.engine.model,
      system: opts.system,
      user: opts.user,
      maxTokens: opts.maxTokens,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  }
  const res = await retryableStreamMessage({
    model: opts.engine.model,
    system: opts.system,
    messages: [{ role: "user", content: opts.user }],
    maxTokens: opts.maxTokens,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  return res.text;
}

async function retryableStreamMessage(
  req: StreamRequest,
  handlers: StreamHandlers = {},
  retries = 3,
): Promise<ReturnType<typeof streamMessage>> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await streamMessage(req, handlers);
    } catch (err) {
      lastErr = err;
      if (err instanceof AnthropicError && (err.status === 429 || err.status >= 500 || err.status === 529)) {
        if (attempt < retries) {
          const delay = Math.min(2_000 * 2 ** attempt, 10_000);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
      }
      throw err;
    }
  }
  throw lastErr;
}

// ------------------------------------------------------------ fact ledger --


function coerceFacts(raw: unknown, minPage: number, maxPage: number): LedgerFact[] {
  if (!Array.isArray(raw)) return [];
  const out: LedgerFact[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const claim = String(o["claim"] ?? "").trim();
    if (!claim) continue;
    const page = Number(o["page"]);
    const kindRaw = String(o["kind"] ?? "").toLowerCase();
    const kind = (FACT_KINDS as readonly string[]).includes(kindRaw)
      ? (kindRaw as FactKind)
      : ("holding" as FactKind);
    const fact: LedgerFact = {
      claim: claim.slice(0, 600),
      page: Number.isFinite(page) ? clamp(Math.round(page), minPage, maxPage) : minPage,
      kind,
    };
    const actors = String(o["actors"] ?? "").trim();
    const date = String(o["date"] ?? "").trim();
    const amount = String(o["amount"] ?? "").trim();
    const quote = String(o["quote"] ?? "").trim();
    if (actors) fact.actors = actors.slice(0, 200);
    if (date) fact.date = date.slice(0, 60);
    if (amount) fact.amount = amount.slice(0, 60);
    if (quote) fact.quote = quote.slice(0, 300);
    out.push(fact);
  }
  return out;
}

function factKey(f: LedgerFact): string {
  return `${f.kind}|${f.page}|${f.claim.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 90)}`;
}

function mergeFacts(...lists: LedgerFact[][]): LedgerFact[] {
  const seen = new Map<string, LedgerFact>();
  for (const list of lists) {
    for (const f of list) {
      const k = factKey(f);
      const prev = seen.get(k);
      if (!prev || (f.quote && !prev.quote)) seen.set(k, f);
    }
  }
  const merged = [...seen.values()].sort((a, b) => a.page - b.page || a.kind.localeCompare(b.kind));
  if (merged.length <= LEDGER_MAX_FACTS) return merged;
  // Keep every critical fact, then fill with the rest in page order.
  const critical = merged.filter((f) => CRITICAL_FACT_KINDS.includes(f.kind));
  const rest = merged.filter((f) => !CRITICAL_FACT_KINDS.includes(f.kind));
  return [...critical, ...rest.slice(0, Math.max(0, LEDGER_MAX_FACTS - critical.length))].sort(
    (a, b) => a.page - b.page,
  );
}

function renderLedger(facts: LedgerFact[]): string {
  return facts
    .map((f) => {
      const bits = [`- (${f.kind}) ${f.claim} [p. ${f.page}]`];
      if (f.amount) bits.push(`  amount: ${f.amount}`);
      if (f.date) bits.push(`  date: ${f.date}`);
      if (f.quote) bits.push(`  quote: "${f.quote}"`);
      return bits.join("\n");
    })
    .join("\n");
}

// --------------------------------------------------------- digest caching --

type CacheEntry = { at: number; digest: string; facts: LedgerFact[] };
const digestCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 400;

function cacheKey(text: string, mode: string): string {
  return createHash("sha256").update(`${mode}\u0000${text}`).digest("hex");
}

function cacheGet(key: string): CacheEntry | null {
  const hit = digestCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    digestCache.delete(key);
    return null;
  }
  return hit;
}

function cacheSet(key: string, entry: Omit<CacheEntry, "at">) {
  if (digestCache.size >= CACHE_MAX) {
    const oldest = [...digestCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) digestCache.delete(oldest[0]);
  }
  digestCache.set(key, { ...entry, at: Date.now() });
}

// -------------------------------------------------------- targeted sweeps --

function focusTerms(instructions?: string): string[] {
  const extra = (instructions ?? "")
    .toLowerCase()
    .split(/[^a-z0-9$%.\-]+/)
    .filter((w) => w.length > 4 && !STOPWORDS.has(w));
  return [...new Set([...extra.slice(0, 12), ...RISK_LEXICON])];
}

const STOPWORDS = new Set([
  "about", "every", "please", "there", "these", "those", "which", "where", "their", "would",
  "should", "could", "document", "summary", "summarize", "include", "including", "focus",
]);

const NUMBER_RE = /\$\s?[\d,]+(?:\.\d+)?|\b\d{1,3}(?:,\d{3})+\b|\b(?:19|20)\d{2}\b/;

/** Score each page for likely needles and return the highest-value ones. */
export function pickSweepPages(pages: PageText[], terms: string[]): PageText[] {
  const scored = pages.map((p) => {
    const t = (p.text ?? "").toLowerCase();
    if (!t.trim()) return { p, score: 0 };
    let score = 0;
    for (const term of terms) if (t.includes(term)) score += 2;
    if (NUMBER_RE.test(p.text)) score += 1;
    if (/\b(?:shall|must|no later than|not exceed)\b/.test(t)) score += 1;
    return { p, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, SWEEP_MAX_PAGES * SWEEP_MAX_CALLS)
    .map((s) => s.p)
    .sort((a, b) => a.page - b.page);
}

function chunkSweepPages(pages: PageText[]): PageText[][] {
  const groups: PageText[][] = [];
  let cur: PageText[] = [];
  let size = 0;
  for (const p of pages) {
    const len = (p.text ?? "").length;
    if (cur.length && (cur.length >= SWEEP_MAX_PAGES || size + len > SWEEP_MAX_CHARS)) {
      groups.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(p);
    size += len;
  }
  if (cur.length) groups.push(cur);
  return groups.slice(0, SWEEP_MAX_CALLS);
}

// ----------------------------------------------------------------- checks --

function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[\s,]+/g, "");
}

/** Deterministic check that critical ledger facts survived into the memo. */
export function coverageReport(summary: string, facts: LedgerFact[], maxPage: number) {
  const hay = normalizeForMatch(summary);
  const critical = facts.filter((f) => CRITICAL_FACT_KINDS.includes(f.kind));
  const missing = critical.filter((f) => {
    const probe = f.amount || f.date || f.claim.split(/[.;]/)[0] || "";
    const needle = normalizeForMatch(probe).slice(0, 40);
    return needle.length >= 4 && !hay.includes(needle);
  });
  const anchors = [...summary.matchAll(/\[p\.\s*(\d+)\]/g)].map((m) => Number(m[1]));
  const badAnchors = anchors.filter((n) => !Number.isFinite(n) || n < 1 || n > maxPage);
  return {
    critical: critical.length,
    covered: critical.length - missing.length,
    missing: missing.slice(0, 20),
    anchors: anchors.length,
    bad_anchors: badAnchors.length,
  };
}

// --------------------------------------------------------------- pipeline --

/** Run the full summarization, streaming progress through `emit`. */
export async function runSummarize(input: SummarizeInput, emit: Emit): Promise<{
  summary: string;
  digests: SectionDigest[];
  sectionCount: number;
  facts: LedgerFact[];
  conflicts: Conflict[];
}> {
  const started = Date.now();
  const mode = input.mode ?? "standard";
  const cfg = modeConfig(mode);

  if (!input.pages.some((p) => (p.text ?? "").trim().length > 0)) {
    throw new AnthropicError(
      400,
      "No selectable text was found in these files — they may be scanned images.",
    );
  }

  const { kept: pages, dropped } = dropBoilerplatePages(input.pages);
  const pageCount = input.pages.length;
  const maxPage = input.pages[input.pages.length - 1]?.page ?? pageCount;
  const charCount = pages.reduce((n, p) => n + (p.text ?? "").length, 0);
  const terms = focusTerms(input.instructions);
  if (dropped > 0) {
    emit("prune", { dropped, note: `${dropped} boilerplate or blank page${dropped === 1 ? "" : "s"} skipped` });
  }

  let facts: LedgerFact[] = [];
  let conflicts: Conflict[] = [];
  let questions: string[] = [];
  let unsupported: LedgerFact[] = [];
  let docType = "";


  const sectionEngine = readingEngine(SUBAGENT_MODEL, mode);
  const sweepEngine: Engine =
    mode === "thorough"
      ? { provider: "anthropic", model: cfg.sweepModel }
      : readingEngine(cfg.sweepModel, mode);
  emit("engine", {
    sections: sectionEngine,
    sweep: sweepEngine,
    writer: { provider: "anthropic", model: cfg.writerModel },
    dual_pass: dualPassFor(mode) && sectionEngine.provider === "fireworks",
  });

  /** Short structured call on the fast reader — used by the router and verifier. */
  const plainCall = (system: string, user: string, maxTokens: number) =>
    readCall({
      engine: sectionEngine,
      system,
      user,
      maxTokens,
      temperature: 0,
      ...(input.signal ? { signal: input.signal } : {}),
    });

  const runVerify = async () => {
    const level = verificationFor(mode);
    if (level === "off" || !facts.length) return;
    const target =
      level === "full" ? facts : facts.filter((f) => CRITICAL_FACT_KINDS.includes(f.kind));
    if (!target.length) return;
    const skipped = facts.filter((f) => !target.includes(f));

    emit("verify", { status: "running", claims: target.length, level });
    const res = await verifyFacts({
      title: input.title,
      facts: target,
      pages,
      minPage: 1,
      maxPage,
      call: plainCall,
      concurrency: VERIFY_CONCURRENCY,
    });
    unsupported = res.unsupported;
    facts = mergeFacts(res.facts, skipped);
    emit("verify", {
      status: "done",
      level,
      checked: res.checked,
      confirmed: res.confirmed,
      reanchored: res.reanchored,
      unsupported: res.unsupported.length,
      total_facts: facts.length,
    });
    emit("facts", { facts });
    if (res.unsupported.length) {
      emit("gaps", {
        unsupported: res.unsupported.slice(0, 20).map((f) => ({ claim: f.claim, page: f.page })),
      });
    }
  };


  const runSweep = async (source: PageText[]) => {
    if (!cfg.sweep) return;
    const candidates = pickSweepPages(source, terms);
    const groups = chunkSweepPages(candidates);
    if (!groups.length) return;
    emit("sweep", {
      status: "running",
      groups: groups.length,
      pages: groups.reduce((n, g) => n + g.length, 0),
      engine: sweepEngine.provider,
    });
    const results = await mapWithLimit(groups, Math.min(3, groups.length), async (g) => {
      const body = g.map((p) => `[p. ${p.page}]\n${(p.text ?? "").trim()}`).join("\n\n");
      try {
        const text = await readCall({
          engine: sweepEngine,
          system: targetedSweepPrompt(input.title, terms.slice(0, 24), input.instructions),
          user: body,
          maxTokens: 4_000,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        const parsed = parseJsonBlock(text);
        return coerceFacts(parsed?.["facts"], 1, maxPage);
      } catch {
        return [] as LedgerFact[];
      }
    });
    const swept = results.flat();
    facts = mergeFacts(facts, swept);
    emit("sweep", { status: "done", found: swept.length, total_facts: facts.length });
    emit("facts", { facts });
  };

  const runConflicts = async () => {
    if (!cfg.conflicts || facts.length < 6) return;
    try {
      const res = await retryableStreamMessage({
        model: SUBAGENT_MODEL,
        system: conflictPrompt(input.title),
        messages: [{ role: "user", content: renderLedger(facts) }],
        maxTokens: 2_000,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const parsed = parseJsonBlock(res.text, "conflicts");
      const raw = parsed?.["conflicts"];
      if (Array.isArray(raw)) {
        conflicts = raw
          .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
          .map((c) => ({
            issue: String(c["issue"] ?? "").slice(0, 300),
            detail: String(c["detail"] ?? "").slice(0, 600) || undefined,
            pages: Array.isArray(c["pages"])
              ? (c["pages"] as unknown[]).map((n) => Number(n)).filter((n) => Number.isFinite(n))
              : [],
          }))
          .filter((c) => c.issue);
      }
    } catch {
      conflicts = [];
    }
    if (conflicts.length) emit("conflict", { conflicts });
  };

  const finish = (summary: string, sectionCount: number) => {
    const coverage = {
      ...coverageReport(summary, facts, maxPage),
      questions: questions.length,
      unsupported: unsupported.length,
    };
    emit("coverage", coverage);
    emit("done", {
      duration_ms: Date.now() - started,
      pages: pageCount,
      chars: charCount,
      sections: sectionCount,
      mode,
      facts: facts.length,
      conflicts: conflicts.length,
    });
  };

  const ledgerBlock = () =>
    facts.length
      ? `\n\nFACT LEDGER (authoritative — every date/amount/deadline below must appear in the memo):\n${renderLedger(facts)}`
      : "";

  const conflictBlock = () =>
    conflicts.length
      ? `\n\nCONFLICTS DETECTED:\n${conflicts
          .map((c) => `- ${c.issue}${c.detail ? ` — ${c.detail}` : ""} [pp. ${c.pages.join(", ")}]`)
          .join("\n")}`
      : "";

  const questionBlock = () =>
    questions.length
      ? `\n\nQUESTIONS THIS MEMO MUST ANSWER (answer each from the ledger, or state plainly that the document does not say):\n${questions
          .map((q, i) => `${i + 1}. ${q}`)
          .join("\n")}`
      : "";

  const gapBlock = () =>
    unsupported.length
      ? `\n\nUNVERIFIED CLAIMS (a reader extracted these but verification could not confirm them against the cited page — do NOT state them as fact; mention only as open items if material):\n${unsupported
          .slice(0, 15)
          .map((f) => `- ${f.claim} [p. ${f.page}]`)
          .join("\n")}`
      : "";


  // ---------------------------------------------------------------- fast path --
  if (fitsSinglePass(charCount, cfg.singlePassMaxTokens)) {
    emit("plan", {
      sections: 1,
      pages: pageCount,
      chars: charCount,
      note: "Single pass — the full document fits in one read.",
    });

    await runSweep(pages);
    await runConflicts();

    emit("writer_start", { model: cfg.singlePassModel, sections: 1 });
    let summary = "";
    await streamMessage(
      {
        model: cfg.singlePassModel,
        system: singlePassWriterPrompt(input.matterLabel, input.instructions),
        messages: [
          {
            role: "user",
            content:
              buildFullText(input.title, pages, input.matterLabel, input.instructions) +
              ledgerBlock() +
              conflictBlock() +
              gapBlock(),
          },
        ],
        maxTokens: cfg.singlePassMaxTokens,
        effort: cfg.writerEffort,
        ...(input.signal ? { signal: input.signal } : {}),
      },
      {
        onText: (delta) => {
          summary += delta;
          emit("delta", { text: delta });
        },
        onThinking: (delta) => emit("thinking", { text: delta }),
      },
    );

    finish(summary, 1);
    return { summary: summary.trim(), digests: [], sectionCount: 1, facts, conflicts };
  }

  // ------------------------------------------------------------ 1. scan --
  const sections = buildSections(pages);
  const meta = scanPages(pages);
  const signals = scoreSections(sections, meta);
  emit("scan", {
    sections: sections.length,
    pages: pages.length,
    skim: signals.filter((s) => s.tier === "skim").length,
    critical: signals.filter((s) => s.tier === "critical").length,
  });

  // ----------------------------------------------------------- 2. route --
  const route = await routeDocument({
    title: input.title,
    ...(input.matterLabel ? { matterLabel: input.matterLabel } : {}),
    ...(input.instructions ? { instructions: input.instructions } : {}),
    map: renderPageMap(signals, meta),
    sections: signals,
    call: plainCall,
  });
  questions = route.questions;
  docType = route.docType;
  const tiers = route.tiers;
  emit("route", {
    doc_type: docType,
    routed: route.routed,
    questions,
    tiers: {
      critical: [...tiers.values()].filter((t) => t === "critical").length,
      normal: [...tiers.values()].filter((t) => t === "normal").length,
      skim: [...tiers.values()].filter((t) => t === "skim").length,
    },
  });

  const tierCount = (t: Tier) => [...tiers.values()].filter((x) => x === t).length;
  emit("plan", {
    sections: sections.length,
    pages: pageCount,
    chars: charCount,
    note: `${docType ? `${docType}. ` : ""}Reading ${sections.length} sections — ${tierCount(
      "critical",
    )} in depth, ${tierCount("normal")} standard, ${tierCount("skim")} skimmed${
      questions.length ? `, against ${questions.length} routed questions` : ""
    }.`,
  });

  // ------------------------------------------------------------ 3. read --
  const dualPass = dualPassFor(mode) && sectionEngine.provider === "fireworks";
  const concurrency = concurrencyFor(sections.length, sectionEngine);
  const mapped = await mapWithLimit(sections, concurrency, async (s) => {
    const tier: Tier = tiers.get(s.index) ?? "normal";
    emit("section", { index: s.index, from_page: s.from, to_page: s.to, status: "running", tier });

    // Skim tier: one line, no fact extraction, cheapest engine.
    if (tier === "skim") {
      let digest = "";
      try {
        digest = await readCall({
          engine: sectionEngine,
          system:
            "Reply with ONE sentence describing what these pages are (caption, service list, index, exhibit cover, signature block, or similar). No JSON, no bullets.",
          user: s.text.slice(0, 12_000),
          maxTokens: SKIM_MAX_TOKENS,
          temperature: 0,
          ...(input.signal ? { signal: input.signal } : {}),
        });
      } catch {
        digest = "";
      }
      digest = (digest.trim() || "Non-substantive pages.") + ` [p. ${s.from}]`;
      emit("section_done", {
        index: s.index,
        from_page: s.from,
        to_page: s.to,
        status: "done",
        tier,
        preview: digest.slice(0, 240),
        facts: 0,
        passes: 1,
        engine: sectionEngine.provider,
      });
      return { digest: { index: s.index, from_page: s.from, to_page: s.to, digest }, facts: [] as LedgerFact[] };
    }

    const deep = tier === "critical";
    const engine: Engine =
      deep && sectionEngine.provider === "fireworks"
        ? { provider: "fireworks", model: FIREWORKS_PRECISE_MODEL }
        : sectionEngine;
    const passes = deep || dualPass ? 2 : 1;

    const key = cacheKey(s.text, `${mode}:${engine.model}:${tier}:x${passes}:q${questions.length}`);
    const cached = cacheGet(key);
    let digest: string;
    let sectionFacts: LedgerFact[];
    let agreed = 0;
    if (cached) {
      digest = cached.digest;
      sectionFacts = cached.facts;
    } else {
      const system = sectionDigestPrompt(input.title, input.matterLabel, questions);
      const user = `SECTION ${s.index} of ${sections.length} (pages ${s.from}-${s.to}) of "${input.title}".\n\n${s.text}`;
      const maxTokens = cfg.sectionMaxTokens(s.text.length) * (deep ? 1.5 : 1);
      const pass = (temperature: number) =>
        readCall({
          engine,
          system,
          user,
          maxTokens: Math.round(maxTokens),
          temperature,
          ...(input.signal ? { signal: input.signal } : {}),
        });

      // Cross-analysis: two independent reads of the same pages, merged.
      const texts = passes > 1 ? await Promise.all([pass(0.1), pass(0.6)]) : [await pass(0.2)];

      const factLists = texts.map((t) => coerceFacts(parseJsonBlock(t)?.["facts"], 1, maxPage));
      if (factLists.length > 1) {
        const first = new Set((factLists[0] ?? []).map(factKey));
        agreed = (factLists[1] ?? []).filter((f) => first.has(factKey(f))).length;
      }
      sectionFacts = mergeFacts(...factLists);
      digest = stripJsonBlock(texts[0] ?? "");
      cacheSet(key, { digest, facts: sectionFacts });
    }
    emit("section_done", {
      index: s.index,
      from_page: s.from,
      to_page: s.to,
      status: "done",
      tier,
      preview: digest.slice(0, 240),
      facts: sectionFacts.length,
      agreed,
      passes,
      engine: engine.provider,
      cached: !!cached,
    });
    return { digest: { index: s.index, from_page: s.from, to_page: s.to, digest }, facts: sectionFacts };
  });

  const digests = mapped.map((m) => m.digest);
  facts = mergeFacts(...mapped.map((m) => m.facts));
  emit("ledger", { total: facts.length });
  emit("facts", { facts });

  // --------------------------------------------------- targeted sweep pass --
  await runSweep(pages);

  // ---------------------------------------------------------- 4. verify --
  await runVerify();
  await runConflicts();


  // --------------------------------------------------------------- reduce --
  let material = digests;
  let level = 0;
  while (joinDigests(material).length > REDUCE_LIMIT && material.length > 1) {
    level += 1;
    const groups: SectionDigest[][] = [];
    let cur: SectionDigest[] = [];
    let size = 0;
    for (const d of material) {
      if (size && size + d.digest.length > REDUCE_LIMIT / 2) {
        groups.push(cur);
        cur = [];
        size = 0;
      }
      cur.push(d);
      size += d.digest.length;
    }
    if (cur.length) groups.push(cur);
    if (groups.length >= material.length) break;

    emit("reduce", { level, groups: groups.length, from: material.length });
    const groupConcurrency = concurrencyFor(groups.length);
    material = await mapWithLimit(groups, groupConcurrency, async (g, i) => {
      const groupText = joinDigests(g);
      const res = await retryableStreamMessage({
        model: SUBAGENT_MODEL,
        system: consolidatePrompt(input.title),
        messages: [{ role: "user", content: groupText }],
        maxTokens: cfg.reduceMaxTokens(groupText.length),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return {
        index: i + 1,
        from_page: g[0]!.from_page,
        to_page: g[g.length - 1]!.to_page,
        digest: res.text.trim(),
      };
    });
  }

  // ---------------------------------------------------------------- write --
  emit("writer_start", { model: cfg.writerModel, sections: sections.length });
  let summary = "";
  await streamMessage(
    {
      model: cfg.writerModel,
      system: summaryWriterPrompt(input.matterLabel, input.instructions),
      messages: [
        {
          role: "user",
          content: `DOCUMENT: ${input.title}\nPAGES: ${pageCount}\n${
            input.matterLabel ? `MATTER: ${input.matterLabel}\n` : ""
          }${input.instructions ? `ATTORNEY INSTRUCTIONS: ${input.instructions}\n` : ""}
Below are the ordered digests of the full document, each with page anchors, followed by the fact ledger. Write the summary.

${joinDigests(material)}${ledgerBlock()}${conflictBlock()}${questionBlock()}${gapBlock()}`,
        },
      ],
      maxTokens: cfg.writerMaxTokens,
      effort: cfg.writerEffort,
      ...(input.signal ? { signal: input.signal } : {}),
    },
    {
      onText: (delta) => {
        summary += delta;
        emit("delta", { text: delta });
      },
      onThinking: (delta) => emit("thinking", { text: delta }),
    },
  );

  finish(summary, sections.length);
  return { summary: summary.trim(), digests, sectionCount: sections.length, facts, conflicts };
}

function joinDigests(list: SectionDigest[]): string {
  return list
    .map((d) => `--- pages ${d.from_page}-${d.to_page} ---\n${d.digest}`)
    .join("\n\n");
}

// Keep the token math importable from one place.
export { CHARS_PER_TOKEN, SECTION_CHARS, SINGLE_PASS_PROMPT_RESERVE };
