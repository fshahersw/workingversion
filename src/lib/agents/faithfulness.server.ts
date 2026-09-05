// ============================================================================
// Citation-faithfulness check (research quality — accuracy lever) — server-only.
//
// V1: DECOMPOSED + PARALLEL. After synthesis we deterministically split the
// answer into (claim, [S#]) units, then run one FAST workhorse-model check per
// claim IN PARALLEL — "does THIS claim follow from ITS cited source(s)?". A
// narrow, focused judgment a cheap non-reasoning model (e.g. Nemotron Nano 3)
// does reliably, unlike a single holistic legal-reasoning pass.
//
// Three-way verdict per claim — SUPPORTED / NOT_ADDRESSED / CONTRADICTED — and we
// ONLY surface CONTRADICTED (overstated / mis-attributed / fabricated). Mere
// absence of a peripheral detail in a snippet is NOT_ADDRESSED and never flagged,
// which keeps precision high (a false alarm on a good answer erodes trust).
//
// Score-only — never blocks or edits the (already-streamed) answer. Flag-gated:
// BEDROCK_JUDGE_MODEL unset => no-op. Bounded concurrency + the shared full-jitter
// Bedrock backoff keep it safe under many concurrent users. Per-claim timeout and
// null-on-failure so it can never stall the turn. THINK/report modes only.
// ============================================================================
import type { Source } from "@/lib/chat-types";
import { bedrockChat, bedrockEnabled, userText } from "./bedrock.server";
import { parseJsonBlock } from "./json-extract";
import { agentError, agentLog, trunc } from "./log.server";

// Per-claim WORKHORSE model (cheap, fast, parallel) — a narrow supported/not/
// contradicted call, not holistic reasoning. Default off; set to e.g.
// nvidia.nemotron-nano-3-30b. Swap freely via env.
const JUDGE_MODEL = process.env["BEDROCK_JUDGE_MODEL"] ?? "";
const MAX_CLAIMS = Number(process.env["BEDROCK_JUDGE_MAX_CLAIMS"]) || 15;
const CONCURRENCY = Number(process.env["BEDROCK_JUDGE_CONCURRENCY"]) || 6;
const PER_CLAIM_TIMEOUT_MS = Number(process.env["BEDROCK_JUDGE_TIMEOUT_MS"]) || 12_000;
const SNIPPET_CHARS = 1400;

export type UnsupportedClaim = { claim: string; refs: string[] };
export type FaithfulnessResult = {
  /** Cited claims that returned a verdict. */
  checked: number;
  /** Of those, the ones NOT flagged (supported or source-not-addressed). */
  supported: number;
  /** Claims the cited source contradicts or the answer overstates — to review. */
  unsupported: UnsupportedClaim[];
};

/** True only when a judge model is configured (unset => feature is a no-op). */
export function judgeEnabled(): boolean {
  return Boolean(JUDGE_MODEL) && bedrockEnabled();
}

// --- Deterministic claim extraction ----------------------------------------
type ClaimUnit = { claim: string; refs: string[] };

// Tokens that end in "." but are NOT sentence boundaries — legal citations,
// reporters, courts, and honorifics. Guards the sentence splitter below.
const ABBREV =
  /(?:\b(?:No|Nos|v|vs|Inc|Corp|Co|Ltd|LLC|Cir|Fed|Supp|Ct|Rev|Ed|Dr|Mr|Ms|Mrs|Jr|Sr|St|Art|Sec|Civ|Crim|Proc|App|Evid|Const|Stat|pp|al|Cal|Ill|Pa|Ga|Tex|Fla|Dist|Ass'n|Bros)|U\.S|F\.\d|N\.D|S\.D|E\.D|W\.D|e\.g|i\.e)\.$/i;

/** Strip markdown scaffolding so only prose sentences remain. Fenced code /
 *  artifact blocks, emphasis / heading / quote marks, and leading list markers
 *  are removed; TABLE ROWS are DROPPED entirely. A table cell is not a sentence,
 *  and judging one as a claim produced false positives in calibration (a leaked
 *  cell, and the model's own hedge, were flagged). */
function toProse(answer: string): string {
  const body = answer
    .replace(/```[\s\S]*?```/g, " ") // fenced code / artifact blocks
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (!t) return true; // keep blanks as paragraph breaks
      if (t.startsWith("|")) return false; // markdown table row
      if ((t.match(/\|/g)?.length ?? 0) >= 2) return false; // inline table row
      return true;
    })
    .join("\n");
  return body
    .replace(/[*_`>#]/g, "") // emphasis / heading / quote marks
    .replace(/^\s*(?:[-+•]|\d+[.)])\s+/gm, ""); // leading list markers
}

/** Split prose into sentence spans, abbreviation-guarded so "U.S.", "No.", "v."
 *  etc. never trigger a false boundary. */
function splitSentences(text: string): string[] {
  const boundary = /[.?!]\s+(?=[A-Z(])/g;
  const out: string[] = [];
  let start = 0;
  for (let m = boundary.exec(text); m !== null; m = boundary.exec(text)) {
    const before = text.slice(0, m.index + 1); // through the terminator
    if (
      before.endsWith(".") &&
      (ABBREV.test(before.slice(-9)) || /(?:^|\s)[A-Z]\.$/.test(before.slice(-4)))
    )
      continue; // abbreviation, reporter, or single-letter initial — not a boundary
    out.push(text.slice(start, m.index + 1));
    start = m.index + m[0].length;
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

const CLAIM_RE = /\[S(\d+)\]/g;

/** A candidate claim must read as a whole sentence: long enough, enough words,
 *  and starting like a sentence (capital letter or number) — never a stray
 *  fragment, a leading ", and …" clause, or a bare label. */
function qualifies(claim: string): boolean {
  if (claim.length < 24) return false;
  if (claim.split(/\s+/).filter(Boolean).length < 5) return false;
  return /^[A-Z0-9(]/.test(claim); // starts like a sentence
}

/** Split the answer into (claim, [S#]) units. Each unit is ONE full sentence
 *  that carries one or more inline citations, with the [S#] markers removed and
 *  every cited ref attached (deduped). Sentence-level — NOT sliced between
 *  adjacent cites — so a sentence with two citations yields one clean claim, not
 *  a mid-sentence fragment. Markdown is stripped and table rows dropped first.
 *  No model call. Exported for the deterministic extractor test
 *  (scripts/test-faithfulness-extract.ts). */
export function extractClaims(answer: string): ClaimUnit[] {
  const units: ClaimUnit[] = [];
  const seen = new Set<string>();
  for (const sentence of splitSentences(toProse(answer))) {
    const refs = [...new Set([...sentence.matchAll(CLAIM_RE)].map((x) => `S${x[1]}`))];
    if (!refs.length) continue;
    let claim = sentence
      .replace(CLAIM_RE, " ")
      .replace(/\s+/g, " ")
      .replace(/\s+([.,;:)\]])/g, "$1") // tidy space left before punctuation by cite removal
      .replace(/^[^A-Za-z0-9(]+/, "") // drop leading punctuation / space
      .trim();
    if (claim.length > 400) claim = claim.slice(0, 400).trim(); // keep subject/verb head
    if (!qualifies(claim)) continue;
    const key = claim.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    units.push({ claim: trunc(claim, 400), refs });
    if (units.length >= MAX_CLAIMS) break;
  }
  return units;
}

// --- Bounded-concurrency map ------------------------------------------------
async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) {
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker),
  );
  return out;
}

// --- Per-claim workhorse check ----------------------------------------------
const SYSTEM = `You verify ONE claim from a legal research answer against the SOURCE(S) it cites. Judge only this claim against the excerpt provided; use no outside knowledge and do not judge whether the claim is true in the world.

Choose one verdict:
- SUPPORTED — the excerpt states or clearly implies the claim (a faithful paraphrase counts).
- NOT_ADDRESSED — the excerpt is the right kind of source but simply does not contain enough to confirm the specific claim (e.g. a peripheral date, figure, or holding not shown in this excerpt). This is acceptable and NOT a problem.
- CONTRADICTED — the excerpt contradicts the claim, OR the claim OVERSTATES it (e.g. says a court "held/ruled" X but the excerpt is a news/secondary/blog report, not the ruling itself), OR it attributes the claim to the wrong case, party, or court, OR states a specific docket/date/figure the excerpt does not.

When you are unsure, choose NOT_ADDRESSED — never CONTRADICTED on a guess. Precision matters more than catching everything.

Output ONLY this JSON object, "verdict" first, with nothing before or after it:
{"verdict":"SUPPORTED"|"NOT_ADDRESSED"|"CONTRADICTED","why":"<one short clause>"}`;

type Verdict = "SUPPORTED" | "NOT_ADDRESSED" | "CONTRADICTED";

async function judgeClaim(
  unit: ClaimUnit,
  byRef: Map<string, Source>,
  signal?: AbortSignal,
): Promise<Verdict | null> {
  const excerpt = unit.refs
    .map((r) => {
      const s = byRef.get(r.toUpperCase());
      return s
        ? `[${r}] ${s.citation}\n${trunc((s.content ?? "").trim(), SNIPPET_CHARS)}`
        : `[${r}] (cited source not found)`;
    })
    .join("\n\n");
  const user = `CLAIM\n${unit.claim}\n\nCITED SOURCE(S)\n${excerpt}`;
  try {
    const res = await Promise.race([
      bedrockChat({
        model: JUDGE_MODEL,
        system: SYSTEM,
        messages: [userText(user)],
        maxTokens: 1000,
        ...(signal ? { signal } : {}),
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("per-claim check timed out")), PER_CLAIM_TIMEOUT_MS),
      ),
    ]);
    const parsed = parseJsonBlock(res.text, "verdict");
    const v = typeof parsed?.["verdict"] === "string" ? parsed["verdict"].toUpperCase() : "";
    if (v === "SUPPORTED" || v === "NOT_ADDRESSED" || v === "CONTRADICTED") return v;
    return null;
  } catch {
    return null; // a failed check never counts against the answer
  }
}

/** Parallel per-claim faithfulness check. Returns null on missing judge, no
 *  citable claims, or if every check failed. Never throws. */
export async function checkFaithfulness(opts: {
  question: string;
  answer: string;
  sources: Source[];
  signal?: AbortSignal;
}): Promise<FaithfulnessResult | null> {
  if (!judgeEnabled()) return null;
  const answer = opts.answer.trim();
  if (!answer || opts.sources.length === 0) return null;
  const units = extractClaims(answer);
  if (!units.length) return null;

  const byRef = new Map<string, Source>();
  for (const s of opts.sources) if (s.ref) byRef.set(s.ref.toUpperCase(), s);

  const t0 = Date.now();
  const verdicts = await mapPool(units, CONCURRENCY, (u) => judgeClaim(u, byRef, opts.signal));

  const unsupported: UnsupportedClaim[] = [];
  let evaluated = 0;
  units.forEach((u, i) => {
    const v = verdicts[i];
    if (!v) return; // check failed — skip, do not flag
    evaluated++;
    if (v === "CONTRADICTED") unsupported.push({ claim: u.claim, refs: u.refs });
  });
  if (!evaluated) {
    agentError("faithfulness_no_verdicts", { claims: units.length });
    return null;
  }

  agentLog("faithfulness", {
    model: JUDGE_MODEL,
    ms: Date.now() - t0,
    claims: units.length,
    evaluated,
    flagged: unsupported.map((u) => trunc(u.claim, 60)),
  });
  return { checked: evaluated, supported: evaluated - unsupported.length, unsupported };
}
