// ============================================================================
// Report pipeline (server-only) — for FILE deliverables that must be COMPLETE.
//
// A single synthesis call truncates a long, multi-section report. So a file
// request runs a multi-pass workflow instead:
//   1. PLAN   — one call returns a dynamic, content-specific section plan
//               (creative headers; boilerplate labels are banned).
//   2. DRAFT  — every section is drafted IN PARALLEL from the shared source
//               pool, each with its own full token budget, so no section is
//               truncated by a shared budget.
//   3. REFINE — any thin/empty section is redrafted once.
// Returns assembled markdown + a title for docgen. No "Executive Summary" /
// "Bottom line" / memo-header boilerplate anywhere.
// ============================================================================
import type { Source } from "@/lib/chat-types";
import { bedrockChat, userText, type BedrockToolDef } from "./bedrock.server";
import { SYSTEM_PROMPT, temporalContext } from "@/lib/system-prompt";

const REPORT_MODEL = process.env["BEDROCK_RESEARCH_MODEL"] || "us.anthropic.claude-sonnet-5";
const PLAN_MODEL = process.env["BEDROCK_AGENT_MODEL"] || "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const SECTION_MAX_TOKENS = 4500;

export type ReportSection = { header: string; focus: string };

const BANNED =
  'Never use boilerplate as a header or lead-in: "Executive Summary", "Bottom Line", "Bottom line for leadership", "Introduction", "Overview", "Conclusion", "TL;DR", "Research Memorandum", "Question:", "Date:" are ALL banned. Invent specific, descriptive headers drawn from THIS matter\'s actual content.';

const PLAN_TOOL: BedrockToolDef = {
  name: "plan_report",
  description: "Return the report's title and its section plan.",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "A specific, professional report title tied to the matter (no 'Report on…', no boilerplate)." },
      sections: {
        type: "array",
        description: "4 to 8 sections in a logical order that cover exactly what the attorney asked for.",
        items: {
          type: "object",
          properties: {
            header: { type: "string", description: "A specific, content-driven section header — NOT a generic label." },
            focus: { type: "string", description: "One sentence stating what this section must cover." },
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

async function planReport(query: string, digest: string, signal?: AbortSignal): Promise<{ title: string; sections: ReportSection[] } | null> {
  try {
    const res = await bedrockChat({
      model: PLAN_MODEL,
      system: `${temporalContext()}\nYou plan the structure of a litigation report for a plaintiffs' mass tort firm. ${BANNED}`,
      messages: [
        userText(
          `REQUEST\n${query}\n\nRESEARCH DIGEST\n${digest.slice(0, 6000)}\n\nPlan the report: a specific title and 4-8 sections with content-driven headers, covering exactly what the attorney asked for, in logical order.`,
        ),
      ],
      tools: [PLAN_TOOL],
      toolChoice: { name: "plan_report" },
      maxTokens: 1200,
      ...(signal ? { signal } : {}),
    });
    const input = res.toolCalls[0]?.input as { title?: string; sections?: ReportSection[] } | undefined;
    if (!input?.sections?.length) return null;
    return {
      title: (input.title || "Litigation Report").slice(0, 120),
      sections: input.sections.filter((s) => s && s.header).slice(0, 8),
    };
  } catch {
    return null;
  }
}

async function draftSection(section: ReportSection, query: string, sourcesText: string, signal?: AbortSignal): Promise<string> {
  const res = await bedrockChat({
    model: REPORT_MODEL,
    system: `${SYSTEM_PROMPT}\n\n${temporalContext()}\n\nYou are drafting ONE section of a litigation report. Ground EVERY factual statement ONLY in the provided SOURCES and cite them inline as [S#]; never invent a fact or a citation. ${BANNED}`,
    messages: [
      userText(
        `SOURCES\n${sourcesText}\n\nREPORT REQUEST\n${query}\n\nDraft this section:\nHEADER: ${section.header}\nCOVERS: ${section.focus}\n\nRules:\n- Start with a "## " heading (refine the wording to be specific and compelling; keep it a ## heading).\n- Write COMPLETE, substantive content — never stub, never write "to be determined" or "[pending]".\n- Use real markdown | pipe tables | (header row + "|---|" separator) for any matrix, timeline, or side-by-side comparison. Keep columns tight and consistent.\n- "- " bullets only for genuinely enumerable items; otherwise write clean prose.\n- Put a [S#] at the end of each clause it supports.\n- If a process/chronology/relationship genuinely reads clearer as a picture, include ONE fenced code block tagged dot with Graphviz DOT.\n- Output ONLY this one section (its ## heading + body). No document title, no other sections, no closing summary.`,
      ),
    ],
    maxTokens: SECTION_MAX_TOKENS,
    ...(signal ? { signal } : {}),
  });
  return res.text.trim();
}

const substance = (s: string) => s.replace(/[#\s*|_`-]/g, "").length;

/** Plan -> parallel draft -> refine. Returns assembled report markdown + title,
 *  or null if it couldn't produce enough (caller falls back to the digest). */
export async function buildReportMarkdown(args: {
  query: string;
  digest: string;
  sources: Source[];
  signal?: AbortSignal;
  onProgress?: (msg: string) => void;
}): Promise<{ title: string; markdown: string; sections: number } | null> {
  const { query, digest, sources, signal, onProgress } = args;
  onProgress?.("Planning the report structure…");
  const plan = await planReport(query, digest, signal);
  if (!plan) return null;

  const sourcesText = sourcesBlock(sources);
  onProgress?.(`Drafting ${plan.sections.length} sections in parallel…`);
  const drafts = await Promise.all(
    plan.sections.map((s) => draftSection(s, query, sourcesText, signal).catch(() => "")),
  );

  // Refine: redraft any empty/too-thin section once (parallel).
  const refined = await Promise.all(
    plan.sections.map(async (s, i) => {
      const body = drafts[i] || "";
      if (substance(body) >= 140) return body;
      const retry = await draftSection(s, query, sourcesText, signal).catch(() => "");
      return substance(retry) > substance(body) ? retry : body;
    }),
  );

  const markdown = refined.map((b) => b.trim()).filter(Boolean).join("\n\n");
  if (substance(markdown) < 200) return null;
  return { title: plan.title, markdown, sections: plan.sections.length };
}
