// ============================================================================
// §6.2/§7 Nemotron RoutePlan router — pure prompt + parse + normalize + fallback.
//
// The router's ONLY job is to emit the smallest valid RoutePlan that sends a
// request through the fastest still-accurate workflow. It never answers, never
// writes prose, never calls tools. This module holds everything testable in
// isolation; the live Nemotron call lives in frontier-router.server.ts.
//
// The normalize step is where "application code controls execution" (§0.3): a
// small fast model can emit sloppy JSON, so we coerce every field to a safe
// value and clamp research rounds to the per-class ceilings from §4 regardless
// of what the model asked for.
// ============================================================================
import { parseJsonBlock } from "./json-extract.ts";
import type {
  AnswerStyle,
  Complexity,
  Freshness,
  GrokReasoning,
  LatencyClass,
  RequestContext,
  RouteIntent,
  RoutePlan,
  ToolFamily,
} from "./frontier-contracts.ts";

/** Router generation constraints (§2.1): tiny structured output, near-greedy. */
export const ROUTER_MAX_TOKENS = 400;
export const ROUTER_TEMPERATURE = 0.1;

// --- Allowed value sets (runtime mirrors of the contract unions) ------------
const INTENTS: readonly RouteIntent[] = [
  "answer",
  "rewrite",
  "legal_research",
  "docket_status",
  "case_law",
  "regulatory",
  "citation_check",
  "data_analysis",
  "artifact",
  "browser_task",
];
const COMPLEXITIES: readonly Complexity[] = ["fast", "standard", "deep"];
const FRESHNESS: readonly Freshness[] = ["not_required", "recent_preferred", "current_required"];
const REASONING: readonly GrokReasoning[] = ["low", "medium", "high", "xhigh"];
const STYLES: readonly AnswerStyle[] = [
  "concise",
  "normal",
  "legal_memo",
  "research_report",
  "document",
];
const TOOL_FAMILIES: readonly ToolFamily[] = [
  "web",
  "courtlistener",
  "docketbird",
  "govinfo",
  "regulations",
  "fda",
  "clinicaltrials",
  "sec",
  "browser",
  "compute",
  "document",
];

/** Per-complexity research-round ceilings (§4). Enforced in code, not trusted
 *  to the model. */
const ROUND_CEILING: Record<Complexity, number> = { fast: 1, standard: 3, deep: 6 };

export const ROUTER_SYSTEM_PROMPT = `You are the low-latency routing controller for a production legal AI system.

Your job is NOT to answer the user.
Your job is NOT to write legal analysis.
Your job is NOT to call tools.

Your only job is to produce the smallest valid RoutePlan that sends the request
through the fastest workflow that is still accurate.

PRIORITIES, IN ORDER:
1. Correctness of route.
2. Current information when the request depends on current facts.
3. Minimum total latency.
4. Minimum unnecessary tool usage.
5. Minimum unnecessary model escalation.

ROUTING RULES:

- Do not use research tools when the user supplied everything needed.
- If a fact may have changed recently, set freshness=current_required.
- Known docket/case status questions should prefer court/docket tools, not generic web search.
- Statutes, regulations, federal publications, agency actions and court materials should prefer primary sources.
- Use generic web search only when structured primary sources are insufficient or discovery is needed.
- Browser automation is a fallback, not a default.
- Code Interpreter is used for computation, extraction, transformation or data analysis, not ordinary prose.
- File creation requires the artifact path but does not automatically require deep research.
- Use Grok planning only when legal judgment, multi-source decomposition, conflicting evidence, multi-step tool dependencies, or completeness judgment is needed.
- If independent sources can be searched simultaneously, set canParallelize=true.
- Do not ask the user a question merely because ambiguity exists. Ask only if different interpretations would materially change the answer or action.
- If ambiguity can be resolved cheaply with parallel research, research it instead.
- Use a choice panel instead of free-text clarification when there are 2-5 clear options.
- Never exceed the configured research-round ceiling.
- Never produce end-user prose.

COMPLEXITY:

FAST:
No research or one obvious tool family; no difficult legal judgment.

STANDARD:
Current factual research or a small number of sources; normal legal synthesis.

DEEP:
Conflicting authorities, cross-jurisdiction analysis, chronology, major litigation
research, regulatory synthesis, scientific/legal integration, or difficult completeness judgment.

GROK REASONING:

low:
Routine writing, straightforward synthesis, obvious tool calling.

medium:
Normal multi-source legal research.

high:
Conflicting evidence, difficult legal synthesis, high-stakes completeness.

xhigh:
Only explicit deep-research workloads where additional latency is acceptable.

OUTPUT:
Return ONLY a single JSON object (no prose, no code fence) with exactly these fields:
{
  "intent": one of ${JSON.stringify(INTENTS)},
  "complexity": one of ${JSON.stringify(COMPLEXITIES)},
  "freshness": one of ${JSON.stringify(FRESHNESS)},
  "needsTools": boolean,
  "needsGrokPlanner": boolean,
  "grokReasoning": one of ${JSON.stringify(REASONING)},
  "toolFamilies": array of ${JSON.stringify(TOOL_FAMILIES)},
  "canParallelize": boolean,
  "maxResearchRounds": integer,
  "needsChoicePanel": boolean,
  "answerStyle": one of ${JSON.stringify(STYLES)},
  "rationaleCode": short UPPER_SNAKE_CASE label
}`;

/** Compact, latency-sensitive router input. Recent turns are trimmed hard — the
 *  router only needs enough context to classify, not the full transcript. */
export function buildRouterUser(ctx: RequestContext): string {
  const lines: string[] = [];
  lines.push(`CURRENT DATE: ${ctx.currentDateIso}`);
  if (ctx.userMode) lines.push(`USER MODE: ${ctx.userMode}`);
  if (ctx.conversationSummary?.trim()) {
    lines.push(`CONVERSATION SUMMARY: ${ctx.conversationSummary.trim()}`);
  }
  const recent = (ctx.recentMessages ?? []).slice(-3);
  if (recent.length) {
    lines.push("RECENT TURNS:");
    for (const m of recent) lines.push(`${m.role}: ${m.content.slice(0, 400)}`);
  }
  if (ctx.userSelection) {
    lines.push(
      `USER SELECTION: panel ${ctx.userSelection.panelId} -> ${ctx.userSelection.selected.join(", ")}`,
    );
  }
  lines.push("", "USER MESSAGE:", ctx.userMessage, "", "Return the RoutePlan JSON now.");
  return lines.join("\n");
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function asBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function normalizeToolFamilies(value: unknown): ToolFamily[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<ToolFamily>();
  for (const v of value) {
    if (typeof v === "string" && (TOOL_FAMILIES as readonly string[]).includes(v)) {
      seen.add(v as ToolFamily);
    }
  }
  return [...seen];
}

/** Clamp rounds into [0, per-class ceiling]; force 0 when no tools are needed. */
function clampRounds(complexity: Complexity, needsTools: boolean, raw: unknown): number {
  if (!needsTools) return 0;
  const ceiling = ROUND_CEILING[complexity];
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) {
    // No usable value: default to a modest mid-range round count for the class.
    return complexity === "fast" ? 1 : complexity === "standard" ? 2 : 3;
  }
  return Math.max(0, Math.min(ceiling, Math.round(n)));
}

function cleanRationale(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "UNSPECIFIED";
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48) || "UNSPECIFIED";
}

/**
 * Coerce an arbitrary parsed object into a well-formed, safe RoutePlan. Unknown
 * or invalid fields fall back to conservative defaults; research rounds are
 * clamped to the §4 ceilings. Never throws.
 */
export function normalizeRoutePlan(obj: Record<string, unknown>): RoutePlan {
  const intent = oneOf(obj["intent"], INTENTS, "legal_research");
  const complexity = oneOf(obj["complexity"], COMPLEXITIES, "standard");
  const needsTools = asBool(obj["needsTools"], true);
  const answerStyle = oneOf(obj["answerStyle"], STYLES, "normal");
  const route: RoutePlan = {
    intent,
    complexity,
    freshness: oneOf(obj["freshness"], FRESHNESS, "recent_preferred"),
    needsTools,
    needsGrokPlanner: asBool(obj["needsGrokPlanner"], complexity === "deep"),
    grokReasoning: oneOf(obj["grokReasoning"], REASONING, complexity === "deep" ? "high" : "low"),
    toolFamilies: needsTools ? normalizeToolFamilies(obj["toolFamilies"]) : [],
    canParallelize: asBool(obj["canParallelize"], false),
    maxResearchRounds: clampRounds(complexity, needsTools, obj["maxResearchRounds"]),
    needsChoicePanel: asBool(obj["needsChoicePanel"], false),
    answerStyle,
    rationaleCode: cleanRationale(obj["rationaleCode"]),
  };
  return route;
}

/** Extract + normalize a RoutePlan from raw model text. Returns null when no
 *  JSON object can be recovered (caller falls back). */
export function parseRoutePlan(raw: string): RoutePlan | null {
  const obj = parseJsonBlock(raw, "intent") ?? parseJsonBlock(raw, "complexity");
  if (!obj) return null;
  return normalizeRoutePlan(obj);
}

/**
 * Deterministic safe route when the router call fails or returns garbage.
 * Conservative by design: for a legal product, defaulting to a grounded
 * standard research pass is safer than answering from model memory.
 */
export function fallbackRoutePlan(): RoutePlan {
  return {
    intent: "legal_research",
    complexity: "standard",
    freshness: "recent_preferred",
    needsTools: true,
    needsGrokPlanner: false,
    grokReasoning: "medium",
    toolFamilies: ["web"],
    canParallelize: true,
    maxResearchRounds: 2,
    needsChoicePanel: false,
    answerStyle: "normal",
    rationaleCode: "ROUTER_FALLBACK",
  };
}

/** §4 latency class derived from the route (ARTIFACT layers on top of a
 *  research pipeline; it is not a distinct complexity the router emits). */
export function latencyClassOf(route: RoutePlan): LatencyClass {
  if (route.answerStyle === "document" || route.intent === "artifact") return "ARTIFACT";
  if (route.complexity === "deep") return "DEEP";
  if (route.complexity === "standard") return "STANDARD";
  return "FAST";
}
