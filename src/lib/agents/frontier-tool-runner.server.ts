// ============================================================================
// ToolRunner (§11) — executes the app's real research tools and normalizes what
// they retrieve into EvidenceItems for the frontier pipeline.
//
// It wraps the existing executeResearchTool + SourceBook (battle-tested) rather
// than reimplementing any tool. For each call it runs the tool, finds the
// sources that call produced (by the [S#] refs the tool reports), and stamps
// each with an authority level (§12). Crucially it CLASSIFIES failures: a tool
// that errored or timed out returns ok:false with the reason, so the orchestrator
// can race a second provider or narrow the query instead of surrendering — the
// exact failure mode where a whole-docket DocketBird pull timed out and the old
// loop just gave up.
//
// Dependencies (the real executor + SourceBook) are INJECTED as minimal
// structural types so this module stays free of the @/-aliased tool graph and
// is unit-testable under node --test with fakes.
// ============================================================================
import type { EvidenceItem, SourceType, ToolCallSpec, ToolRunResult } from "./frontier-contracts.ts";
import { authorityLevelForSource, isPrimarySource } from "./frontier-authority.ts";
import type { ToolRunner } from "./frontier-research-loop.server.ts";

/** Structural subset of the app's Source (chat-types) the runner needs. */
export interface SourceLike {
  ref: string;
  citation: string;
  authority: string;
  source_type: string;
  source_url?: string;
  effective_date?: string;
  content: string;
}

/** Structural subset of SourceBook. */
export interface SourceBookLike {
  all(): SourceLike[];
}

/** Shape of executeResearchTool (research-tools.server). */
export type ResearchExecutor = (
  name: string,
  input: Record<string, unknown>,
  book: SourceBookLike,
  attachments?: unknown,
) => Promise<{ text: string; hits: number; refs: string[] }>;

/** Map the app's source_type onto the frontier SourceType enum (§11). */
export function mapSourceType(appType: string): SourceType {
  switch (appType) {
    case "opinion":
    case "case_law":
      return "court_opinion";
    case "filing":
    case "docket":
    case "case":
    case "calendar":
      return "court_filing";
    case "regulation":
    case "regulatory":
      return "regulation";
    case "science":
    case "graph":
      return "secondary";
    case "web":
      return "web";
    default:
      return "web";
  }
}

/** Best-effort provider name from the tool that produced a source. */
export function providerForTool(tool: string): string {
  if (tool.startsWith("recap") || tool === "verify_citations") return "courtlistener";
  if (tool.startsWith("db_")) return "docketbird";
  if (tool === "fda_search") return "openfda";
  if (tool === "federal_register_search") return "federal_register";
  if (tool === "ecfr_search") return "ecfr";
  if (tool === "search_pubmed") return "pubmed";
  if (tool === "fetch_page") return "web-fetch";
  if (tool === "web_search" || tool === "search_authorities" || tool.startsWith("search_")) return "web-search";
  return tool;
}

function trunc(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}

/** A tool result with no evidence AND failure-shaped text is a real failure
 *  (errored/timed out/misconfigured) — distinct from a legitimate empty result
 *  ("No RECAP dockets for X"), which is ok:true so the orchestrator can move on. */
const FAILURE_RE = /(\bfailed\b|timed out|time-?out|not configured|no readable text|python error)/i;

export function sourceToEvidence(source: SourceLike, tool: string): EvidenceItem {
  const sourceType = mapSourceType(source.source_type);
  const authorityLevel = authorityLevelForSource(sourceType);
  const item: EvidenceItem = {
    id: source.ref,
    sourceType,
    provider: providerForTool(tool),
    authorityLevel,
    title: source.citation || source.ref,
    url: source.source_url ?? "",
    retrievedAt: new Date().toISOString(),
    supports: [],
    contradicts: [],
    primarySource: isPrimarySource(authorityLevel),
    currentVerified: false,
    confidence: 0.6,
  };
  if (source.effective_date) item.eventDate = source.effective_date;
  if (source.content) item.excerpt = trunc(source.content, 500);
  return item;
}

export class ResearchToolRunner implements ToolRunner {
  private readonly book: SourceBookLike;
  private readonly execute: ResearchExecutor;
  private readonly attachments?: unknown;

  constructor(opts: { book: SourceBookLike; execute: ResearchExecutor; attachments?: unknown }) {
    this.book = opts.book;
    this.execute = opts.execute;
    this.attachments = opts.attachments;
  }

  async run(call: ToolCallSpec, signal?: AbortSignal): Promise<ToolRunResult> {
    if (signal?.aborted) {
      return { callId: call.id, tool: call.tool, ok: false, evidence: [], error: "aborted" };
    }
    const before = new Set(this.book.all().map((s) => s.ref));
    let outcome: { text: string; hits: number; refs: string[] };
    try {
      outcome = await this.execute(call.tool, call.args, this.book, this.attachments);
    } catch (err) {
      return {
        callId: call.id,
        tool: call.tool,
        ok: false,
        evidence: [],
        error: trunc(err instanceof Error ? err.message : "tool threw", 200),
      };
    }

    // Sources this call produced: prefer the refs the tool reports; else diff.
    const refs = outcome.refs?.length ? new Set(outcome.refs) : null;
    const produced = this.book
      .all()
      .filter((s) => (refs ? refs.has(s.ref) : !before.has(s.ref)));
    const evidence = produced.map((s) => sourceToEvidence(s, call.tool));

    const text = (outcome.text ?? "").trim();
    const failed = evidence.length === 0 && FAILURE_RE.test(text);
    const summary = text ? trunc(text.split("\n")[0] ?? text, 200) : `${evidence.length} result(s)`;

    return {
      callId: call.id,
      tool: call.tool,
      ok: !failed,
      evidence,
      summary,
      ...(failed ? { error: trunc(text, 200) } : {}),
    };
  }
}
