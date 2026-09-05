// ============================================================================
// Report pipeline (server-only) — for FILE deliverables that must be COMPLETE,
// on-length, and non-repetitive.
//
//   1. PLAN   — one call returns a length-scaled, MUTUALLY-EXCLUSIVE section
//               plan with dynamic content-driven headers (boilerplate banned);
//               it also picks AT MOST ONE section to carry a diagram.
//   2. DRAFT  — sections are drafted IN PARALLEL, but each drafter is given the
//               FULL outline and told to stay in its lane (kills the cross-
//               section redundancy that blind parallelism produces) and a word
//               budget derived from the requested page count.
//   3. REFINE — thin/empty sections are redrafted once.
//   4. VERIFY — a Sources appendix lists every cited [S#] -> citation + URL, and
//               reporter-style case citations are checked against CourtListener.
// ============================================================================
import type { Source } from "@/lib/chat-types";
import { bedrockChat, userText, type BedrockToolDef } from "./bedrock.server";
import { SYSTEM_PROMPT, temporalContext } from "@/lib/system-prompt";
import { lookupCitations } from "./courtlistener.server";

const REPORT_MODEL = process.env["BEDROCK_RESEARCH_MODEL"] || "us.anthropic.claude-sonnet-5";
const PLAN_MODEL = process.env["BEDROCK_AGENT_MODEL"] || "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const WORDS_PER_PAGE = 430;

export type ReportSection = { header: string; focus: string; diagram?: boolean };

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

const BANNED =
  'Never use boilerplate as a header or lead-in: "Executive Summary", "Bottom Line", "Bottom line for leadership", "Introduction", "Overview", "Conclusion", "TL;DR", "Research Memorandum", "Question:", "Date:" are ALL banned. Invent specific, descriptive headers drawn from THIS matter\'s actual content.';

const PLAN_TOOL: BedrockToolDef = {
  name: "plan_report",
  description: "Return the report's title and a mutually-exclusive section plan.",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "A specific, professional report title tied to the matter (no 'Report on…', no boilerplate)." },
      sections: {
        type: "array",
        description: "Sections in logical order. Each MUST cover a DISTINCT sub-topic — no two sections may overlap or repeat the same doctrine/foundation.",
        items: {
          type: "object",
          properties: {
            header: { type: "string", description: "A specific, content-driven section header — NOT a generic label." },
            focus: { type: "string", description: "One sentence: what ONLY this section covers (distinct from every other section)." },
            diagram: { type: "boolean", description: "true for AT MOST ONE section — the one a flow/relationship diagram would most help." },
          },
          required: ["header", "focus"],
        },
      },
    },
    required: ["title", "sections"],
  },
};

function sourcesBlock(sources: Source[], limit = 44): string {
  return sources
    .slice(0, limit)
    .map((s) => {
      const head = [s.ref, s.citation || s.authority || s.source_type].filter(Boolean).join(" ");
      return `[${s.ref}] ${head}\n${(s.content || "").slice(0, 1100)}`;
    })
    .join("\n\n");
}

function outlineText(sections: ReportSection[]): string {
  return sections.map((s, i) => `${i + 1}. ${s.header} — ${s.focus}`).join("\n");
}

async function planReport(query: string, digest: string, maxSections: number, pages: number | undefined, signal?: AbortSignal): Promise<{ title: string; sections: ReportSection[] } | null> {
  const sizing = pages
    ? `The report must fit ~${pages} page(s), so plan ${Math.min(3, maxSections)}-${maxSections} sections.`
    : `Use ONLY as many sections as the request genuinely needs (a narrow question: 3; a broad, multi-part question: up to ${maxSections}). Size the plan to the scope of the request, not a fixed length.`;
  try {
    const res = await bedrockChat({
      model: PLAN_MODEL,
      system: `${temporalContext()}\nYou plan the structure of a litigation report for a plaintiffs' mass tort firm. Sections MUST be mutually exclusive: no two sections may cover the same doctrine or repeat foundational material — each owns a distinct slice. Mark AT MOST ONE section diagram:true. ${BANNED}`,
      messages: [
        userText(
          `REQUEST\n${query}\n\nRESEARCH DIGEST\n${digest.slice(0, 6000)}\n\n${sizing} Give each a content-driven header, in logical order. Fewer, distinct sections beat many overlapping ones.`,
        ),
      ],
      tools: [PLAN_TOOL],
      toolChoice: { name: "plan_report" },
      maxTokens: 1200,
      ...(signal ? { signal } : {}),
    });
    const input = res.toolCalls[0]?.input as { title?: string; sections?: ReportSection[] } | undefined;
    if (!input?.sections?.length) return null;
    const sections = input.sections.filter((s) => s && s.header).slice(0, maxSections);
    // Enforce the "at most one diagram" rule regardless of what the model marked.
    let sawDiagram = false;
    for (const s of sections) {
      if (s.diagram && !sawDiagram) sawDiagram = true;
      else s.diagram = false;
    }
    return { title: (input.title || "Litigation Report").slice(0, 120), sections };
  } catch {
    return null;
  }
}

async function draftSection(
  section: ReportSection,
  idx: number,
  outline: string,
  query: string,
  sourcesText: string,
  wordBudget: number,
  allowDiagram: boolean,
  signal?: AbortSignal,
): Promise<string> {
  const maxTokens = clamp(wordBudget * 3 + 600, 1400, 4200);
  const res = await bedrockChat({
    model: REPORT_MODEL,
    system: `${SYSTEM_PROMPT}\n\n${temporalContext()}\n\nYou are drafting ONE section of a multi-section report. Ground EVERY factual statement ONLY in the provided SOURCES and cite them inline as [S#]; never invent a fact or a citation. ${BANNED}`,
    messages: [
      userText(
        `SOURCES\n${sourcesText}\n\nREPORT REQUEST\n${query}\n\nFULL REPORT OUTLINE (other drafters are writing these concurrently — do NOT duplicate or re-explain material another section owns):\n${outline}\n\nWRITE ONLY SECTION #${idx + 1}:\nHEADER: ${section.header}\nCOVERS: ${section.focus}\n\nRules:\n- Start with a "## " heading (you may sharpen the wording; keep it a ## heading).\n- Target ~${wordBudget} words. Be dense and NON-REPETITIVE — assume the reader has the other sections, so state foundational concepts once (if they're yours) and otherwise reference them in a clause, don't re-teach them.\n- Include a markdown | pipe table | ONLY if it genuinely adds value for THIS section; at most one, kept tight.\n- ${allowDiagram ? "You MAY include ONE fenced ```dot Graphviz diagram if a process/relationship truly reads clearer as a picture." : "Do NOT include any diagram or ```dot block."}\n- Put a [S#] at the end of each clause it supports; never cite a source number that isn't in SOURCES.\n- Output ONLY this one section (its ## heading + body). No title, no other sections, no closing summary.`,
      ),
    ],
    maxTokens,
    ...(signal ? { signal } : {}),
  });
  return res.text.trim();
}

const substance = (s: string) => s.replace(/[#\s*|_`-]/g, "").length;

/** Integrity gate (always-on, deterministic): strip any [S#] marker that does
 *  not map to a gathered source, so the report never carries a dangling cite. */
function integrityGate(body: string, sources: Source[]): { body: string; orphans: string[] } {
  const valid = new Set(sources.map((s) => s.ref));
  const orphans = new Set<string>();
  const cleaned = body.replace(/\[S(\d+)\]/g, (m, n: string) => {
    const ref = `S${n}`;
    if (valid.has(ref)) return m;
    orphans.add(ref);
    return "";
  });
  return { body: cleaned, orphans: [...orphans] };
}

const GROUND_TOOL: BedrockToolDef = {
  name: "citation_audit",
  description: "Report any claim in the draft that its cited source does not actually support.",
  input_schema: {
    type: "object",
    properties: {
      issues: {
        type: "array",
        description: "Only genuinely unsupported or mis-cited claims. Empty if every cited claim is supported.",
        items: {
          type: "object",
          properties: {
            ref: { type: "string", description: "The [S#] cited (e.g. S3)." },
            claim: { type: "string", description: "Short quote of the unsupported claim." },
            problem: { type: "string", description: "Why the source doesn't support it (not stated / says otherwise / wrong source)." },
          },
          required: ["claim", "problem"],
        },
      },
    },
    required: ["issues"],
  },
};

/** Claim grounding (Think/Research only): a model re-reads the report against the
 *  source texts and flags clauses the cited source doesn't support. Best-effort. */
async function groundClaims(body: string, sources: Source[], signal?: AbortSignal): Promise<string> {
  try {
    const res = await bedrockChat({
      model: REPORT_MODEL,
      system: `${temporalContext()}\nYou are a strict citation auditor for a law firm. For each [S#]-cited claim in the REPORT, verify it against the matching SOURCE text below. Flag ONLY claims the cited source does not actually support (or that cite the wrong source). Do not nitpick phrasing; flag substantive unsupported assertions. If everything checks out, return an empty issues list.`,
      messages: [userText(`SOURCES\n${sourcesBlock(sources)}\n\nREPORT\n${body.slice(0, 40000)}`)],
      tools: [GROUND_TOOL],
      toolChoice: { name: "citation_audit" },
      maxTokens: 1500,
      ...(signal ? { signal } : {}),
    });
    const issues = (res.toolCalls[0]?.input as { issues?: { ref?: string; claim?: string; problem?: string }[] } | undefined)?.issues ?? [];
    if (!issues.length) return "";
    const lines = issues.slice(0, 8).map((i) => `- ${i.ref ? i.ref + ": " : ""}${(i.claim || "").slice(0, 160)} — ${(i.problem || "").slice(0, 160)}`);
    return `\n\n> **Verification notes (automated citation audit — confirm before filing):**\n${lines.join("\n")}`;
  } catch {
    return "";
  }
}

/** Append a Sources list mapping every cited [S#] to its citation + URL, and a
 *  citation-check note for any reporter-style case cites in the body. */
async function verifyAndAppend(body: string, sources: Source[], signal?: AbortSignal): Promise<string> {
  const citedRefs = Array.from(new Set([...body.matchAll(/\[S(\d+)\]/g)].map((m) => `S${m[1]}`)));
  const byRef = new Map(sources.map((s) => [s.ref, s]));
  let out = body;

  if (citedRefs.length) {
    const ordered = citedRefs.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    const lines = ordered.map((ref) => {
      const s = byRef.get(ref);
      if (!s) return `- **${ref}**: (no matching source on record — verify independently)`;
      const cite = s.citation || s.authority || s.source_type || "source";
      const url = s.source_url ? ` — ${s.source_url}` : "";
      return `- **${ref}**: ${cite}${url}`;
    });
    out += `\n\n## Sources\n${lines.join("\n")}`;
  }

  // Best-effort: confirm any reporter-style case citations resolve to a real case.
  try {
    if (/\b\d{1,4}\s+[A-Z][A-Za-z.]{1,10}\.?\s?\d?[a-z]?\s+\d{1,4}\b|\b\d{4}\s+WL\s+\d+\b/.test(body)) {
      const results = await lookupCitations(body.slice(0, 60000), signal ? { signal } : undefined);
      const bad = results.filter((r) => !r.found && r.citation);
      if (bad.length) {
        out += `\n\n> **Citation check:** ${bad.length} cited reporter citation(s) did not resolve in CourtListener and must be confirmed before filing: ${bad.map((b) => b.citation).slice(0, 8).join("; ")}.`;
      }
    }
  } catch {
    /* verification is best-effort */
  }
  return out;
}

/** Plan -> parallel draft (lane-scoped) -> refine -> verify/append. Returns
 *  assembled report markdown + title, or null (caller falls back to the digest). */
export async function buildReportMarkdown(args: {
  query: string;
  digest: string;
  sources: Source[];
  pages?: number;
  /** Think/Research mode runs the extra adversarial claim-grounding audit. */
  verifyClaims?: boolean;
  signal?: AbortSignal;
  onProgress?: (msg: string) => void;
}): Promise<{ title: string; markdown: string; sections: number } | null> {
  const { query, digest, sources, pages, verifyClaims, signal, onProgress } = args;
  const hasPages = !!pages && pages > 0;
  // With a page count, scale sections to it; otherwise let the plan size to the
  // request's scope (up to 8) with a moderate per-section budget.
  const maxSections = hasPages ? clamp(Math.round((pages as number) * 0.6) + 1, 3, 8) : 8;
  const wordBudget = hasPages ? Math.max(Math.round(((pages as number) * WORDS_PER_PAGE) / maxSections), 200) : 480;

  onProgress?.(hasPages ? `Planning ~${pages}-page report…` : "Planning report (sized to the request)…");
  const plan = await planReport(query, digest, maxSections, hasPages ? pages : undefined, signal);
  if (!plan) return null;

  const outline = outlineText(plan.sections);
  const sourcesText = sourcesBlock(sources);
  const diagramIdx = plan.sections.findIndex((s) => s.diagram);

  onProgress?.(`Drafting ${plan.sections.length} sections in parallel (~${wordBudget} words each)…`);
  const drafts = await Promise.all(
    plan.sections.map((s, i) => draftSection(s, i, outline, query, sourcesText, wordBudget, i === diagramIdx, signal).catch(() => "")),
  );

  const refined = await Promise.all(
    plan.sections.map(async (s, i) => {
      const body = drafts[i] || "";
      if (substance(body) >= 140) return body;
      const retry = await draftSection(s, i, outline, query, sourcesText, wordBudget, false, signal).catch(() => "");
      return substance(retry) > substance(body) ? retry : body;
    }),
  );

  let body = refined.map((b) => b.trim()).filter(Boolean).join("\n\n");
  if (substance(body) < 200) return null;

  // Integrity gate (always): drop [S#] markers with no matching source.
  const gate = integrityGate(body, sources);
  body = gate.body;

  // Claim grounding (Think/Research): adversarial audit of cited claims.
  if (verifyClaims) {
    onProgress?.("Auditing citations against sources…");
    body += await groundClaims(body, sources, signal);
  }

  onProgress?.("Building sources list…");
  let markdown = await verifyAndAppend(body, sources, signal);
  if (gate.orphans.length) {
    markdown += `\n\n> Note: ${gate.orphans.length} citation marker(s) referenced sources not in the record and were removed.`;
  }
  return { title: plan.title, markdown, sections: plan.sections.length };
}
