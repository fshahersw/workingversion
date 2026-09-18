// ============================================================================
// §10 Grok writer — pure system prompt + user-turn assembly.
//
// The writer is a separate role even though it is the same underlying model. It
// receives the request, relevant conversation context, a verified EvidenceBundle
// and style instructions, and answers the user directly in clean legal prose. It
// gets no tools (§45): evidence is handed to it. The live streaming call lives in
// frontier-writer.server.ts.
//
// On the fast direct-write path (§46) the bundle is empty — the writer answers
// from the request alone and must not fabricate citations.
// ============================================================================
import type {
  AnswerStyle,
  EvidenceBundle,
  EvidenceItem,
  RequestContext,
  RoutePlan,
} from "./frontier-contracts.ts";

export const WRITER_SYSTEM_PROMPT = `You are the final legal synthesis and writing model for a professional law-firm AI system.

You receive the user's request, relevant conversation context, a verified EvidenceBundle, research limitations, and formatting/style instructions.

Your job is to answer the user directly.

WRITING REQUIREMENTS:
- Write clean, natural, professional prose.
- Prefer coherent paragraphs over excessive bullets.
- Sound like an excellent legal researcher or senior associate, not a generic AI report generator.
- Be concise when the question is simple; expand only where complexity requires it.
- Do not repeat the user's question. Do not begin with generic throat-clearing.
- Avoid inflated language, filler and unnecessary headings.
- Separate established facts from allegations, argument, inference or unresolved issues.
- Preserve meaningful uncertainty.
- Never manufacture a citation, quotation, docket number, date or procedural event.
- Every current/changeable factual claim must be grounded in the supplied evidence.
- When authorities conflict, explain the conflict rather than flattening it.
- Prefer primary authority over commentary.
- When the record is incomplete, say exactly what remains unverified.
- Use dates precisely, and distinguish when a source was published from when the underlying event occurred.

LEGAL SYNTHESIS:
- Connect sources to propositions; do not merely list sources.
- Identify what actually matters procedurally or strategically.
- Preserve jurisdiction and procedural posture; do not overstate holdings.
- Distinguish dicta, allegations, party positions, expert opinions and court findings.
- Do not convert association into causation, or absence of evidence into evidence of absence.

CITATIONS:
- When sources are provided, cite claims inline with [S#] markers matching the numbered sources.
- When no sources are provided, answer directly from the request and do NOT invent citations.

STYLE:
Default is clear, restrained, readable, intelligent and human. For a normal chat answer, lead with the answer and explain only what is needed. For a memorandum, use professional headings and a synthesis-first structure. For a research report, use an executive synthesis, organized analysis, and tables only when they improve comprehension. Do not mention internal agent or model names.`;

/** Short style directive appended to the writer's user turn. */
export function styleDirective(style: AnswerStyle): string {
  switch (style) {
    case "concise":
      return "STYLE: Answer in a few tight sentences. No headings.";
    case "legal_memo":
      return "STYLE: Write as a professional legal memorandum — clear headings, synthesis-first.";
    case "research_report":
      return "STYLE: Write as a research report — a short executive synthesis, then organized analysis; tables only when they aid comprehension.";
    case "document":
      return "STYLE: Produce well-structured prose suitable for a formal document — clear headings, synthesis-first, complete coverage.";
    case "normal":
    default:
      return "STYLE: Lead with the direct answer, then add only the context needed. Prefer short paragraphs over bullet lists.";
  }
}

/** Generous token floor by style — Grok is a reasoning model, so budget for
 *  hidden reasoning plus the prose. */
export function writerMaxTokens(style: AnswerStyle): number {
  switch (style) {
    case "concise":
      return 4000;
    case "legal_memo":
      return 12000;
    case "research_report":
    case "document":
      return 16000;
    case "normal":
    default:
      return 8000;
  }
}

/** Render the evidence as a source list keyed by each item's own ref (item.id),
 *  so the writer's [S#] citations match the ids shown in the Sources panel. */
export function renderEvidence(items: readonly EvidenceItem[]): string {
  return items
    .map((it) => {
      const meta = `${it.provider} · ${it.sourceType} · L${it.authorityLevel}`;
      const dates = [
        it.eventDate ? `event ${it.eventDate}` : "",
        it.publishedAt ? `published ${it.publishedAt}` : "",
      ]
        .filter(Boolean)
        .join(", ");
      const head = `[${it.id}] ${it.title} — ${meta}${dates ? ` (${dates})` : ""}`;
      const url = it.url ? `\n   ${it.url}` : "";
      const excerpt = it.excerpt ? `\n   ${it.excerpt.slice(0, 300)}` : "";
      return `${head}${url}${excerpt}`;
    })
    .join("\n");
}

/** Assemble the writer's user turn from the request, context, evidence and style. */
export function buildWriterUser(
  ctx: RequestContext,
  bundle: EvidenceBundle,
  route: RoutePlan,
  instructions?: readonly string[],
): string {
  const lines: string[] = [];
  lines.push(`REQUEST: ${ctx.userMessage}`);
  lines.push(`CURRENT DATE: ${ctx.currentDateIso}`);

  if (ctx.userContext?.trim()) {
    lines.push("", ctx.userContext.trim());
  }
  if (ctx.conversationSummary?.trim()) {
    lines.push("", `CONVERSATION SUMMARY: ${ctx.conversationSummary.trim()}`);
  }
  const recent = (ctx.recentMessages ?? []).slice(-2);
  if (recent.length) {
    lines.push("", "RECENT TURNS:");
    for (const m of recent) lines.push(`${m.role}: ${m.content.slice(0, 500)}`);
  }

  const items = bundle.items ?? [];
  if (items.length) {
    lines.push(
      "",
      "SOURCES (cite claims with [S#]; every current or changeable fact must rest on a source):",
      renderEvidence(items),
    );
    if (bundle.limitations?.length) {
      lines.push("", "RESEARCH LIMITATIONS (state honestly where relevant):");
      for (const lim of bundle.limitations) lines.push(`- ${lim}`);
    }
  } else {
    lines.push("", "No external sources were needed for this request. Answer directly; do not invent citations.");
  }

  lines.push("", styleDirective(route.answerStyle));

  if (instructions?.length) {
    lines.push("", "WRITER NOTES:");
    for (const note of instructions) lines.push(`- ${note}`);
  }

  lines.push("", "Write the answer now.");
  return lines.join("\n");
}
