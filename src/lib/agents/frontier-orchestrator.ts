// ============================================================================
// §8/§9 Grok research orchestrator — pure prompt + decision parse/normalize.
//
// The orchestrator inspects the ResearchState each round and returns ONE
// structured OrchestratorDecision: run a parallel tool batch, ask the user to
// choose, or stop (complete/handoff). It never executes tools itself and never
// writes end-user prose. Because execution is app-controlled, the decision is a
// plain JSON object we parse and validate here — no Bedrock server-side tool
// use, no Mantle. The live Grok call lives in frontier-orchestrator.server.ts.
//
// normalize is the safety layer: an empty tool batch becomes a writer handoff,
// a choice request without a valid panel degrades to a handoff, unknown fields
// are dropped. The loop can therefore always make progress.
// ============================================================================
import type {
  ChoicePanel,
  GrokReasoning,
  OrchestratorDecision,
  OrchestratorStatus,
  ToolCallSpec,
} from "./frontier-contracts.ts";
import { isPrimarySource } from "./frontier-authority.ts";
import type { ResearchState } from "./frontier-research-state.ts";

/** Reasoning model: the budget must cover hidden reasoning AND the JSON decision.
 *  Too small and Grok spends it all reasoning and returns EMPTY text (stop=
 *  max_tokens) — which parses to nothing and forces a writer handoff with no
 *  research. Keep it generous; the JSON itself is small. */
export const ORCHESTRATOR_MAX_TOKENS = 8000;

const STATUSES: readonly OrchestratorStatus[] = [
  "tool_batch",
  "complete",
  "request_user_choice",
  "handoff_to_writer",
];
const REASONING: readonly GrokReasoning[] = ["low", "medium", "high", "xhigh"];

/** A tool the orchestrator may choose. The live pipeline injects the app's real
 *  registry (name + description from RESEARCH_TOOLS); the default below is a
 *  doc-canonical fallback used only when nothing is injected. */
export interface ToolSpec {
  name: string;
  description?: string;
}

const DEFAULT_TOOL_NAMES: readonly string[] = [
  "web.search",
  "web.fetch",
  "courtlistener.search",
  "courtlistener.get_docket",
  "courtlistener.get_docket_entries",
  "courtlistener.get_opinion",
  "courtlistener.get_document",
  "courtlistener.verify_citation",
  "docketbird.search_cases",
  "docketbird.get_case",
  "docketbird.get_docket",
  "docketbird.search_filing_text",
  "docketbird.get_document",
  "govinfo.search",
  "govinfo.describe",
  "regulations.search_documents",
  "regulations.get_document",
  "regulations.search_dockets",
  "regulations.get_docket",
  "regulations.search_comments",
  "fda.search_labels",
  "fda.search_adverse_events",
  "fda.search_enforcement",
  "fda.search_drugs_at_fda",
  "clinicaltrials.search",
  "clinicaltrials.get_study",
  "clinicaltrials.get_version",
  "sec.get_submissions",
  "sec.get_company_facts",
  "sec.fetch_filing",
  "compute.execute",
  "compute.read_file",
  "compute.write_file",
  "browser.open_task",
  "document.create_docx",
  "document.create_pdf",
  "document.create_xlsx",
  "document.create_pptx",
];

export const DEFAULT_TOOL_CATALOG: readonly ToolSpec[] = DEFAULT_TOOL_NAMES.map((name) => ({ name }));

export const ORCHESTRATOR_SYSTEM_PROMPT = `You are the research orchestrator for a high-accuracy, latency-sensitive legal AI system.

You receive the user's request, conversation context, a RoutePlan, the available tool catalog, prior research rounds, and an evidence ledger.

Your job is to decide the MINIMUM set of next actions needed to answer accurately.

CORE PRINCIPLES:

1. PRIMARY AUTHORITY FIRST
Prefer official court records, opinions, statutes, regulations, agency records, official government repositories, and first-party source documents.

2. RECENCY
When the user asks for status, latest developments, current counsel, scheduled events, recent orders, deadlines, or other changeable facts, treat recency as mandatory. Never rely on model memory for a current fact.

3. PARALLELISM
Identify independent research branches and return them in the same batch. Do not serialize independent calls.

4. DEPENDENCIES
Do not call a downstream tool until required identifiers are known. First identify the docket, then request docket-specific filings.

5. COMPLETENESS
Before stopping, map evidence back to every material element of the request. Several strong sources are still incomplete if an element is unanswered.

6. NEGATIVE CLAIMS
Do not conclude something does not exist merely because one search did not find it. Use an appropriately scoped search and say when the record is incomplete.

7. CONFLICTS
When sources conflict, surface the conflict, rank by authority and date, retrieve the underlying primary source, and do not silently choose a weaker source.

8. TOOL DISCIPLINE
Do not search merely because a tool exists. Do not repeat materially identical searches. Do not use Browser if an API, MCP, web search, or direct fetch can resolve the task.

9. LATENCY
Prefer one well-designed parallel batch to several sequential calls. Use narrow queries. Fetch only the source documents needed for proposition-level support.

10. STOPPING
Stop when all material elements have evidence, current facts are verified, contradictions are resolved or characterized, and the writer can answer without guessing. If not complete, return another targeted batch. Never create open-ended autonomous loops.

11. FIRST ROUND
If the evidence ledger is empty and the request depends on external or current facts (case status, docket, latest developments, case law, regulations, science, or any changeable fact), you MUST return a "tool_batch". Never return "complete" or "handoff_to_writer" before any evidence has been gathered — the writer has no tools and cannot research. Prefer a small parallel batch of primary sources (e.g., a court/docket search plus a targeted web search), and use narrow queries with court/date/docket filters.

OUTPUT:
Return ONLY a single JSON object (no prose, no code fence) shaped as:
{
  "status": one of ["tool_batch","complete","request_user_choice","handoff_to_writer"],
  "calls": [ { "id": "short_id", "tool": "catalog.name", "args": { } } ],
  "parallelGroups": [ ["id","id"] ],
  "missingElements": ["short description of an unmet element"],
  "nextReasoningEffort": one of ["low","medium","high","xhigh"],
  "choicePanel": { present only when status is request_user_choice },
  "writerInstructions": ["optional short notes for the writer"]
}
Use "tool_batch" to research, "complete"/"handoff_to_writer" to stop, "request_user_choice" only when a materially different interpretation cannot be resolved by cheap research.`;

/** Compact evidence line for the ledger (§37 compaction — metadata + short
 *  span, never raw source bytes). */
function evidenceLine(item: {
  id: string;
  authorityLevel: 1 | 2 | 3 | 4 | 5;
  sourceType: string;
  title: string;
  eventDate?: string;
  publishedAt?: string;
  supports: string[];
}): string {
  const date = item.eventDate ?? item.publishedAt ?? "n.d.";
  const primary = isPrimarySource(item.authorityLevel) ? "primary" : "secondary";
  const supports = item.supports.length ? ` supports=[${item.supports.join(",")}]` : "";
  return `[${item.id}] L${item.authorityLevel}/${primary} ${item.sourceType} "${item.title}" (${date})${supports}`;
}

/** Serialize the state into the orchestrator's user turn. Evidence is capped so
 *  a large ledger never blows the context budget. */
export function buildOrchestratorUser(
  state: ResearchState,
  toolCatalog: readonly ToolSpec[] = DEFAULT_TOOL_CATALOG,
): string {
  const r = state.route;
  const lines: string[] = [];
  lines.push(`REQUEST: ${state.ctx.userMessage}`);
  lines.push(`CURRENT DATE: ${state.ctx.currentDateIso}`);
  lines.push(
    `ROUTE: intent=${r.intent} complexity=${r.complexity} freshness=${r.freshness} style=${r.answerStyle} round=${state.round}/${r.maxResearchRounds}`,
  );
  if (r.toolFamilies.length) lines.push(`ALLOWED TOOL FAMILIES: ${r.toolFamilies.join(", ")}`);
  lines.push("", "TOOLS (choose by name; args are the tool's own fields):");
  for (const t of toolCatalog) {
    lines.push(`- ${t.name}${t.description ? ` — ${t.description.replace(/\s+/g, " ").trim().slice(0, 220)}` : ""}`);
  }

  const items = state.evidence();
  if (items.length) {
    lines.push("", `EVIDENCE LEDGER (${items.length} items, strongest first):`);
    for (const it of items.slice(0, 20)) lines.push(evidenceLine(it));
    if (items.length > 20) lines.push(`... and ${items.length - 20} more`);
  } else {
    lines.push("", "EVIDENCE LEDGER: empty (no research yet).");
  }

  if (state.requirements.length) {
    lines.push("", "COVERAGE:");
    for (const req of state.requirements) {
      lines.push(`- ${req.id} [${req.status}]${req.required ? "" : " (optional)"}: ${req.description}`);
    }
    const open = state.requirements
      .filter((req) => req.required && (req.status === "missing" || req.status === "partial"))
      .map((req) => req.id);
    if (open.length) lines.push(`OPEN REQUIRED: ${open.join(", ")}`);
  }

  if (state.activity.length) {
    lines.push("", "RECENT TOOL RESULTS (most recent last):");
    for (const a of state.activity.slice(-8)) {
      const detail = a.detail.replace(/\s+/g, " ").trim().slice(0, 120);
      lines.push(`- r${a.round} ${a.tool}: ${a.ok ? `${a.count} source(s) — ${detail}` : `FAILED — ${detail}`}`);
    }
    lines.push(
      "Do not repeat a call that already failed the same way — narrow it (add a court/date/docket filter), switch provider, or race an alternative source.",
    );
  }

  lines.push("", "Decide the minimum next actions. Return one OrchestratorDecision JSON now.");
  return lines.join("\n");
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function normalizeCalls(value: unknown): ToolCallSpec[] {
  if (!Array.isArray(value)) return [];
  const out: ToolCallSpec[] = [];
  let seq = 0;
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const tool = typeof o["tool"] === "string" ? o["tool"].trim() : "";
    if (!tool) continue; // only the tool name is mandatory
    // Models routinely omit "id" — synthesize one rather than drop the call.
    const id = typeof o["id"] === "string" && o["id"].trim() ? o["id"].trim() : `call_${++seq}`;
    const args = o["args"] && typeof o["args"] === "object" ? (o["args"] as Record<string, unknown>) : {};
    out.push({ id, tool, args });
  }
  return out;
}

function normalizeParallelGroups(value: unknown, callIds: Set<string>): string[][] {
  if (!Array.isArray(value)) return [];
  const groups: string[][] = [];
  for (const g of value) {
    if (!Array.isArray(g)) continue;
    const ids = g.filter((x): x is string => typeof x === "string" && callIds.has(x));
    if (ids.length) groups.push(ids);
  }
  return groups;
}

function isValidPanel(value: unknown): value is ChoicePanel {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return typeof o["id"] === "string" && Array.isArray(o["options"]);
}

/**
 * Coerce arbitrary parsed JSON into a safe OrchestratorDecision. Guarantees the
 * loop can always act: an empty/invalid tool batch or a panel-less choice
 * request both degrade to handoff_to_writer. Never throws.
 */
export function normalizeOrchestratorDecision(obj: Record<string, unknown>): OrchestratorDecision {
  let status = oneOf(obj["status"], STATUSES, "handoff_to_writer");
  const calls = normalizeCalls(obj["calls"]);

  if (status === "tool_batch" && !calls.length) status = "handoff_to_writer";

  if (status === "request_user_choice" && !isValidPanel(obj["choicePanel"])) {
    status = "handoff_to_writer";
  }

  const decision: OrchestratorDecision = { status };

  if (status === "tool_batch") {
    decision.calls = calls;
    const ids = new Set(calls.map((c) => c.id));
    const groups = normalizeParallelGroups(obj["parallelGroups"], ids);
    // Default: run the whole batch concurrently when the model omitted groups.
    decision.parallelGroups = groups.length ? groups : [calls.map((c) => c.id)];
  }

  if (status === "request_user_choice" && isValidPanel(obj["choicePanel"])) {
    decision.choicePanel = obj["choicePanel"];
  }

  if (Array.isArray(obj["missingElements"])) {
    const missing = obj["missingElements"].filter((x): x is string => typeof x === "string");
    if (missing.length) decision.missingElements = missing;
  }

  if (typeof obj["nextReasoningEffort"] === "string") {
    const effort = oneOf(obj["nextReasoningEffort"], REASONING, "medium");
    decision.nextReasoningEffort = effort;
  }

  if (Array.isArray(obj["writerInstructions"])) {
    const notes = obj["writerInstructions"].filter((x): x is string => typeof x === "string");
    if (notes.length) decision.writerInstructions = notes;
  }

  return decision;
}

function tryParseObject(s: string): Record<string, unknown> | null {
  try {
    const p = JSON.parse(s);
    return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Index just past the balanced closing brace for the "{" at `start`, string- and
 *  escape-aware; -1 if unbalanced. */
function matchBrace(text: string, start: number): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (esc) {
      esc = false;
      continue;
    }
    if (inStr) {
      if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Recover a JSON object from model text regardless of key order or wrapping:
 *  prefer a fenced ```json block, else the first balanced-brace object. */
export function extractJsonObject(raw: string): Record<string, unknown> | null {
  const fences = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => (m[1] ?? "").trim());
  for (const f of fences.reverse()) {
    const parsed = tryParseObject(f);
    if (parsed) return parsed;
  }
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== "{") continue;
    const end = matchBrace(raw, i);
    if (end !== -1) {
      const parsed = tryParseObject(raw.slice(i, end));
      if (parsed) return parsed;
    }
  }
  return null;
}

/** Extract + normalize an OrchestratorDecision from raw model text; null when no
 *  JSON object can be recovered (caller falls back to handoff). */
export function parseOrchestratorDecision(raw: string): OrchestratorDecision | null {
  const obj = extractJsonObject(raw);
  if (!obj) return null;
  return normalizeOrchestratorDecision(obj);
}
