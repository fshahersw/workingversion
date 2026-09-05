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
  /(?:\b(?:No|Nos|v|vs|Inc|Corp|Co|Ltd|LLC|Cir|Fed|Supp|Ct|Rev|Ed|Dr|Mr|Ms|Mrs|Jr|Sr|St|Art|Sec|pp|al|Cal|Ill|Pa|Ga|Tex|Fla|Dist|Ass'n|Bros)|U\.S|F\.\d|N\.D|S\.D|E\.D|W\.D|e\.g|i\.e)\.$/i;

/** The sentence that carries the citation: the text since the previous cite,
 *  trimmed to its last sentence. Abbreviation-guarded so "U.S.", "No.", "v."
 *  don't trigger a false split. */
function lastSentence(seg: string): string {
  const boundary = /[.?!]\s+(?=[A-Z(])/g;
  let start = 0;
  for (let m = boundary.exec(seg); m !== null; m = boundary.exec(seg)) {
    const before = seg.slice(0, m.index + 1); // through the terminator
    if (before.endsWith(".") && ABBREV.test(before.slice(-9))) continue; // e.g. "…U.S."
    start = m.index + m[0].length;
  }
  return seg.slice(start).trim();
}

/** Split the answer into (claim, [S#]) units: for each inline citation cluster
 *  (one or more adjacent [S#]), the claim is the sentence carrying it. Markdown
 *  is stripped first so headings/bullets/emphasis never leak into a claim. No
 *  model call. */
function extractClaims(answer: string): ClaimUnit[] {
  const text = answer
    .replace(/```[\s\S]*?```/g, " ") // code / artifact blocks
    .replace(/[*_`>#]/g, "") // emphasis / heading / quote marks
    .replace(/^\s*(?:[-+•]|\d+[.)])\s+/gm, ""); // leading list markers
  const clusterRe = /\[S\d+\](?:\s*\[S\d+\])*/g;
  const units: ClaimUnit[] = [];
  const seen = new Set<string>();
  let prevEnd = 0;
  for (let m = clusterRe.exec(text); m !== null; m = clusterRe.exec(text)) {
    const refs = [...m[0].matchAll(/\[S(\d+)\]/g)].map((x) => `S${x[1]}`);
    let seg = lastSentence(text.slice(prevEnd, m.index)).replace(/\s+/g, " ").trim();
    prevEnd = m.index + m[0].length;
    if (seg.length > 400) seg = seg.slice(-400).trim(); // safety window
    if (seg.length < 12 || !refs.length) continue;
    const key = seg.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    units.push({ claim: trunc(seg, 400), refs });
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
