// ============================================================================
// Case grounding pre-pass (server-only).
//
// The docket sub-agent (Nemotron) is weak at the DEPENDENT chain "search for
// the case -> take its case_id -> pull its docket sheet". So we do that chain
// ONCE, deterministically, in code, before any agent runs:
//
//   1. A single one-shot extraction decides whether the question names a
//      specific case/MDL and what to search for (a one-step decision the model
//      handles reliably — not a chain).
//   2. Code calls db_find_case (searchCases) and db_docket_sheet (getDocketSheet).
//   3. The resolved case_id(s) + a recent docket snapshot are registered as
//      citable sources and returned as a RESOLVED CASE CONTEXT block.
//
// The router and every sub-agent then start from concrete, accurate context:
// the docket agent's job collapses to a single step (read one entry, or answer
// from the snapshot) instead of a chain it cannot complete.
// ============================================================================
import {
  BEDROCK_AGENT_MODEL,
  bedrockChat,
  bedrockEnabled,
  userText,
} from "./bedrock.server";
import {
  searchCases,
  getDocketSheet,
  docketbirdConfigured,
  type DbCaseHit,
} from "./docketbird.server";
import { parseJsonBlock } from "./json-extract";
import { temporalContext } from "@/lib/system-prompt";
import { agentLog, agentError, since, trunc } from "./log.server";
import type { SourceBook } from "./tools.server";

// Only spend the extraction call when the question plausibly names a docket.
const CASE_HINT =
  /\bMDL\b|\bIn re\b|\bv\.?\s|\b\d{1,2}:\d{4}-(cv|md|bk|cr)-\d|\bmd-?\s?\d{3,}|case\s*no|docket/i;

const EXTRACT_SYSTEM = `From a litigator's question, extract the SPECIFIC federal case(s) or MDL(s) the answer depends on, as DocketBird search strings.
- Prefer the case NAME ("In re Acetaminophen Products Liability Litigation") over a bare MDL number; add a case number only when no name is given.
- At most 2, and only cases the question is actually ABOUT — not every case it mentions in passing.
- If the question names no specific case/MDL (it is doctrinal, scientific, or general), return an empty list.
- Reply with JSON only: {"cases":["..."]}`;

/** Federal DISTRICT dockets carry the substantive MDL activity; the JPML panel
 *  docket, appellate dockets, and state dockets do not. Prefer a district. */
function isPreferredCourt(courtId: string): boolean {
  const c = courtId.toLowerCase();
  if (c === "jpml" || c === "scotus") return false;
  if (/^ca(\d+|dc|fc)$/.test(c)) return false; // circuit courts of appeals
  if (c.startsWith("c-") || c.startsWith("uc-")) return false; // state courts
  return true;
}

/**
 * Resolve any specific case(s) the question depends on to their case_id and a
 * recent docket snapshot, registering them as citable sources. Returns a
 * context block (empty string when nothing to ground). Never throws.
 */
export async function groundCases(
  question: string,
  book: SourceBook,
  signal?: AbortSignal,
): Promise<string> {
  if (!bedrockEnabled() || !docketbirdConfigured()) return "";
  if (!CASE_HINT.test(question)) return "";

  const started = Date.now();

  // 1. One-shot extraction of case search strings.
  let strings: string[] = [];
  try {
    const res = await bedrockChat({
      model: BEDROCK_AGENT_MODEL,
      system: `${temporalContext()}\n\n${EXTRACT_SYSTEM}`,
      messages: [userText(question)],
      maxTokens: 300,
      temperature: 0,
      ...(signal ? { signal } : {}),
    });
    const parsed = parseJsonBlock(res.text, "cases") as { cases?: unknown } | null;
    const arr = parsed && Array.isArray(parsed.cases) ? parsed.cases : [];
    strings = arr
      .map((x) => String(x).trim())
      .filter((s) => s.length >= 3)
      .slice(0, 2);
  } catch (err) {
    agentError("grounding_extract_failed", { error: trunc(String(err), 160) });
    return "";
  }
  if (!strings.length) {
    agentLog("grounding", { ms: since(started), cases: 0, resolved: 0 });
    return "";
  }

  // 2. Resolve each to a case + docket snapshot.
  const sections: string[] = [];
  let resolved = 0;
  for (const q of strings) {
    let hits: DbCaseHit[] = [];
    try {
      hits = await searchCases({ q, size: 6, ...(signal ? { signal } : {}) });
    } catch {
      continue;
    }
    if (!hits.length) continue;

    const primary = hits.find((h) => isPreferredCourt(h.court_id)) ?? hits[0];
    const caseCite = `${primary.title} (${primary.court_name || primary.court_id})${
      primary.case_number ? `, No. ${primary.case_number}` : ""
    }`;
    const caseSrc = book.add({
      citation: caseCite,
      authority: "registry",
      source_type: "case",
      section_path: primary.id,
      source_url: primary.canonical_url,
      effective_date: primary.date_filed ?? undefined,
      content: caseCite,
    });
    resolved++;

    const others = hits
      .filter((h) => h.id !== primary.id)
      .slice(0, 3)
      .map((h) => `${h.id} (${h.court_name || h.court_id})`);

    // 3. Pull a recent docket snapshot (best effort).
    let docketLine = `  docket sheet was too large/slow to snapshot here — use db_search_filings scoped to case_id ${primary.id} with a targeted term (e.g. "case management order"), or db_docket_sheet if the case is small`;
    try {
      // Short ceiling: a mega-MDL docket must not stall the whole pre-pass.
      const rows = await getDocketSheet(primary.id, "recent", {
        timeoutMs: 9_000,
        ...(signal ? { signal } : {}),
      });
      const shown = rows.slice(0, 25);
      if (shown.length) {
        const list = shown
          .map((e) => `    - ${e.date_filed ?? "(no date)"} — ${e.title || "(untitled entry)"} [document_id=${e.id}]`)
          .join("\n");
        const docketSrc = book.add({
          citation: `Docket sheet — ${primary.id}`,
          authority: "registry",
          source_type: "docket",
          section_path: `${primary.id}|docket`,
          source_url: primary.canonical_url,
          content: trunc(list, 3000),
        });
        docketLine = `  recent docket entries [${docketSrc.ref}] (newest first):\n${list}`;
      }
    } catch {
      /* keep the fallback line */
    }

    const parts = [`• [${caseSrc.ref}] ${caseCite} — case_id: ${primary.id}`];
    if (others.length) parts.push(`  other candidate dockets: ${others.join("; ")}`);
    parts.push(docketLine);
    sections.push(parts.join("\n"));
  }

  agentLog("grounding", { ms: since(started), cases: strings.length, resolved });
  if (!sections.length) return "";

  return `RESOLVED CASE CONTEXT (already looked up for you — use these case_id(s) directly; do NOT search for the case again with db_find_case)\n${sections.join("\n\n")}`;
}
