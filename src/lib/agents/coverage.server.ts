// ============================================================================
// Comprehensiveness gate (research quality plan, item A) — server-only.
//
// After the research loop stops but BEFORE synthesis, a cheap Haiku pass audits
// whether the sources gathered actually cover every part of the question. When
// it finds a genuine gap a targeted search would plausibly fill, it returns
// bounded re-query instructions so the loop runs ONE more targeted round instead
// of writing the answer over a hole. This is the "don't leave data on the table
// when another tool call could have retrieved it" guard.
//
// Cheap and off the hot path: one forced-tool Haiku call, hard 6s cap, returns
// null on any failure so it can never block or slow synthesis. Wired for think +
// report modes only (fast/conversational keep their tight paths).
// ============================================================================
import type { Source } from "@/lib/chat-types";
import { BEDROCK_AGENT_MODEL, bedrockChat, bedrockEnabled, userText } from "./bedrock.server";
import { agentError, trunc } from "./log.server";
import { temporalContext } from "@/lib/system-prompt";

export type CoverageResult = {
  /** True only when every distinct part of the question has source support. */
  covered: boolean;
  /** Short phrases naming parts of the question no source supports yet. */
  missing: string[];
  /** Targeted search queries that would fill those gaps (aligned to `missing`). */
  queries: string[];
};

const COVERAGE_SYSTEM = `You are a research completeness auditor for a litigation research agent.

You are given a lawyer's research QUESTION and the SOURCES the agent gathered before writing its answer. Decide whether the sources actually cover every part of the question.

Call the report_coverage tool.
- covered: true only if every distinct sub-question, entity, or element the question asks about is supported by at least one source. Otherwise false.
- missing: for each genuine gap, a short phrase naming the uncovered part (e.g. "bellwether trial schedule", "general-causation epidemiology", "defendant's prior FDA warning letters"). Empty if covered.
- queries: for each gap, ONE tight targeted search query — distinctive terms only (a party, docket/MDL number, doctrine, statute, agency) — that would plausibly retrieve the missing authority. Aligned one-to-one with missing. Empty if covered.

Be strict but practical:
- Flag a gap ONLY when a targeted search would plausibly find missing authority. Do NOT invent gaps, do NOT ask for sources that likely do not exist, and do NOT flag something the existing sources already answer.
- A multi-part question ("compare X and Y", "posture AND science AND experts") is covered only when EACH part has support.
- At most 3 gaps — the most important ones. Quality over quantity. If coverage is adequate, set covered=true with empty arrays.`;

const COVERAGE_TOOL = {
  name: "report_coverage",
  description:
    "Report whether the gathered sources cover every part of the question, and targeted queries for any genuine gaps.",
  input_schema: {
    type: "object",
    properties: {
      covered: {
        type: "boolean",
        description:
          "True if every distinct part of the question is supported by at least one source.",
      },
      missing: {
        type: "array",
        items: { type: "string" },
        description:
          "Short phrases naming uncovered parts of the question. Empty if covered. At most 3.",
      },
      queries: {
        type: "array",
        items: { type: "string" },
        description:
          "One tight targeted search query per gap, aligned to `missing`. Empty if covered. At most 3.",
      },
    },
    required: ["covered"],
  },
};

/** Hard cap on the audit call so a slow Haiku turn can never eat the synthesis
 *  reserve — a coverage check is a nicety, never worth stalling the answer for. */
const GATE_TIMEOUT_MS = 6_000;

/** Compact source list for the auditor: ref, type, citation, and a short snippet
 *  so it can judge coverage without the full 1500-char bodies blowing the budget. */
function sourceDigest(sources: Source[]): string {
  if (!sources.length) return "(no sources gathered)";
  return sources
    .slice(0, 40)
    .map((sx) => {
      const snip = trunc((sx.content ?? "").replace(/\s+/g, " ").trim(), 200);
      return `[${sx.ref}] ${sx.source_type} — ${trunc(sx.citation, 140)}${snip ? ` :: ${snip}` : ""}`;
    })
    .join("\n");
}

/** One cheap Haiku pass: are all parts of the question covered by the sources?
 *  Returns null on any failure or timeout (never blocks synthesis). */
export async function coverageGaps(opts: {
  query: string;
  sources: Source[];
  signal?: AbortSignal;
}): Promise<CoverageResult | null> {
  if (!bedrockEnabled()) return null;
  const user = [
    `QUESTION\n${trunc(opts.query, 1200)}`,
    `SOURCES GATHERED (${opts.sources.length})\n${sourceDigest(opts.sources)}`,
  ].join("\n\n");

  try {
    const res = await Promise.race([
      bedrockChat({
        model: BEDROCK_AGENT_MODEL,
        system: `${temporalContext()}\n\n${COVERAGE_SYSTEM}`,
        messages: [userText(user)],
        tools: [COVERAGE_TOOL],
        toolChoice: { name: "report_coverage" },
        maxTokens: 500,
        temperature: 0,
        ...(opts.signal ? { signal: opts.signal } : {}),
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`coverage gate timed out after ${GATE_TIMEOUT_MS}ms`)),
          GATE_TIMEOUT_MS,
        ),
      ),
    ]);
    // Forced tool call: the input is already-validated JSON.
    const parsed = (res.toolCalls[0]?.input as Record<string, unknown> | undefined) ?? null;
    if (!parsed) return null;
    const clean = (v: unknown) =>
      Array.isArray(v)
        ? (v as unknown[])
            .map((x) => (typeof x === "string" ? x.trim() : ""))
            .filter(Boolean)
            .slice(0, 3)
        : [];
    return {
      covered: parsed["covered"] === true,
      missing: clean(parsed["missing"]),
      queries: clean(parsed["queries"]),
    };
  } catch (err) {
    agentError("coverage_gate_failed", { error: trunc(String(err), 160) });
    return null;
  }
}

/** The bounded re-query instruction injected as a user turn so the loop runs ONE
 *  more targeted round to close the gaps, then writes the answer. Kept tight and
 *  explicitly one-round so the model does not spiral into open-ended searching. */
export function requeryInstruction(gaps: CoverageResult): string {
  const missing = gaps.missing.length
    ? gaps.missing.map((m) => `- ${m}`).join("\n")
    : "- (parts of the question are still unsupported)";
  const queries = gaps.queries.length ? gaps.queries.map((q) => `- ${q}`).join("\n") : "";
  return [
    "Before you write the answer, there are coverage gaps. These parts of the question are not yet supported by any source you gathered:",
    missing,
    queries
      ? `Run these targeted searches now (in parallel where independent), then write the answer:\n${queries}`
      : "Run one more round of targeted searches to close these gaps, then write the answer.",
    "Search ONLY for these specific gaps — do not repeat searches you already ran. This is your last research round; if a targeted search returns nothing useful, note the gap briefly in the answer and move on rather than retrying.",
  ].join("\n\n");
}
