// ============================================================================
// Subagent primitive (server-only) — the shared building block for Deep Research
// and the light-subagent report path.
//
// A subagent is a FOCUSED research loop that owns exactly ONE sub-question. Given
// a delegation contract (objective + tool guidance + out-of-scope boundary), it
// runs a bounded streamConverseToolLoop over the SHARED run SourceBook and
// returns a dense, [S#]-cited findings digest — raw material for a lead
// synthesizer, not prose.
//
// Subagents SHARE one SourceBook on purpose: SourceBook.add() is synchronous
// (race-free under Promise.all), refs stay globally unique with NO merge step,
// and the per-book SEEN_URLS dedupe already spans every subagent of a run
// (tools.server.ts). Contexts stay isolated — each subagent's conversation holds
// only ITS own tool results; the book is just the shared citation registry.
//
// Bounded (capped count, per-subagent step/tool budget, bounded concurrency to
// protect Bedrock rate limits) and partial-failure tolerant (a subagent that
// throws returns ok:false and is skipped, never failing the batch). Inert until a
// caller invokes it (gated by the caller, e.g. BEDROCK_SUBAGENTS / Deep Research).
// ============================================================================
import type { Attachment } from "@/lib/chat-types";
import { bedrockChat, bedrockEnabled, userText, type BedrockToolDef } from "./bedrock.server";
import { streamConverseToolLoop } from "./bedrock-stream-tools.server";
import { RESEARCH_TOOLS, executeResearchTool } from "./research-tools.server";
import { SourceBook } from "./tools.server";
import { temporalContext } from "@/lib/system-prompt";
import { agentError, agentLog, trunc } from "./log.server";
import {
  assembleFindings,
  mapPoolSettled,
  parsePlan,
  type SubagentResult,
  type SubagentSpec,
} from "./subagent-plan";

export type { SubagentSpec, SubagentResult } from "./subagent-plan";
export { assembleFindings } from "./subagent-plan";

const PLANNER_MODEL = process.env["BEDROCK_SUBAGENT_PLANNER"] || "us.anthropic.claude-sonnet-5";
const SUBAGENT_MODEL = process.env["BEDROCK_SUBAGENT_MODEL"] || "us.anthropic.claude-sonnet-5";
const MAX_SUBAGENTS = Number(process.env["BEDROCK_SUBAGENT_MAX"]) || 5;
const CONCURRENCY = Number(process.env["BEDROCK_SUBAGENT_CONCURRENCY"]) || 3;
const SUBAGENT_MAX_STEPS = Number(process.env["BEDROCK_SUBAGENT_STEPS"]) || 4;
const SUBAGENT_DEADLINE_MS = Number(process.env["BEDROCK_SUBAGENT_DEADLINE_MS"]) || 60_000;

// --- Planner (LeadResearcher) -----------------------------------------------

const PLAN_TOOL: BedrockToolDef = {
  name: "plan_research",
  description:
    "Decompose a broad research question into MUTUALLY EXCLUSIVE sub-questions, each independently researchable in parallel by a focused subagent.",
  input_schema: {
    type: "object",
    properties: {
      subquestions: {
        type: "array",
        description:
          "Sub-questions in logical order. Each MUST cover a DISTINCT slice — no two may overlap. Prefer FEWER, well-separated sub-questions over many near-duplicates.",
        items: {
          type: "object",
          properties: {
            objective: {
              type: "string",
              description: "The single sub-question this subagent owns, phrased as a concrete research task.",
            },
            tools_hint: {
              type: "string",
              description:
                "Which sources fit, e.g. 'PubMed + scientific literature for causation', 'RECAP + DocketBird for docket posture', 'CFR + Federal Register for regulation'.",
            },
            boundaries: {
              type: "string",
              description: "One clause: what this subagent must NOT cover because a sibling owns it.",
            },
          },
          required: ["objective"],
        },
      },
    },
    required: ["subquestions"],
  },
};

/** Decompose a research question into parallel sub-questions. Falls back to a
 *  single whole-question spec if planning is unavailable or returns < 2. */
export async function planSubquestions(
  question: string,
  opts?: { max?: number; signal?: AbortSignal },
): Promise<SubagentSpec[]> {
  const max = Math.max(2, Math.min(opts?.max ?? MAX_SUBAGENTS, MAX_SUBAGENTS));
  const whole: SubagentSpec[] = [{ objective: question.trim() }];
  if (!bedrockEnabled() || !question.trim()) return whole;
  try {
    const res = await bedrockChat({
      model: PLANNER_MODEL,
      system: `${temporalContext()}\nYou are the lead researcher for a plaintiffs' mass tort firm. Decompose the question into the FEWEST mutually-exclusive sub-questions that together cover it — breadth-first, each independently researchable in parallel. A narrow question needs 2; a broad, multi-part one up to ${max}. Give each a concrete objective, a tools hint, and a one-clause boundary so subagents never duplicate each other's work.`,
      messages: [
        userText(`QUESTION\n${question}\n\nDecompose it into ${max} or fewer parallel sub-questions.`),
      ],
      tools: [PLAN_TOOL],
      toolChoice: { name: "plan_research" },
      maxTokens: 1200,
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
    const specs = parsePlan(res.toolCalls[0]?.input, max);
    return specs.length >= 2 ? specs : whole;
  } catch (err) {
    agentError("subagent_plan_failed", {
      error: trunc(err instanceof Error ? err.message : String(err), 160),
    });
    return whole;
  }
}

// --- Subagent runner --------------------------------------------------------

function contractSystem(): string {
  return `${temporalContext()}
You are ONE research subagent for a plaintiffs' mass tort litigation firm, assigned a SINGLE sub-question. Research it with your tools and report FINDINGS — dense, factual, citable — not prose.

RULES
- Stay strictly within your assigned objective. Do NOT research anything your boundary says a sibling owns.
- Ground EVERY fact in a tool result and cite it inline as [S#]. Never invent a fact, holding, date, docket number, or citation.
- Prefer authoritative primary sources; flag when something is only from secondary/news reporting.
- Be efficient: a few well-chosen tool calls, then report. Your step budget is small.`;
}

function contractUser(spec: SubagentSpec): string {
  return [
    `OBJECTIVE (your sub-question)\n${spec.objective}`,
    spec.toolsHint ? `\nSUGGESTED SOURCES\n${spec.toolsHint}` : "",
    spec.boundaries ? `\nOUT OF SCOPE (a sibling subagent owns this)\n${spec.boundaries}` : "",
    `\nResearch this now with your tools (narrate one short line before each batch, call independent tools in parallel), then report your findings.`,
  ]
    .filter(Boolean)
    .join("\n");
}

const FINDINGS_SYNTH =
  "Research complete — do NOT call any more tools. Report your findings on your objective as a DENSE, factual digest: every key fact, holding, date, figure, party, and procedural point, each with its [S#] citation. Terse bullet fragments are fine — this is raw material for a lead synthesizer, so completeness and citations matter more than prose. Do not add a title or intro; if you found little, say so plainly.";

/** Run ONE subagent over the SHARED SourceBook. Never throws — a failure returns
 *  ok:false with empty findings so the batch tolerates it. */
export async function runSubagent(
  spec: SubagentSpec,
  book: SourceBook,
  opts: { parentRun: string; index: number; attachments?: Attachment[]; signal?: AbortSignal },
): Promise<SubagentResult> {
  const t0 = Date.now();
  let findings = "";
  const refs = new Set<string>();
  let tokensIn = 0;
  let tokensOut = 0;
  let steps = 0;
  try {
    const res = await streamConverseToolLoop(
      {
        model: SUBAGENT_MODEL,
        system: contractSystem(),
        user: contractUser(spec),
        tools: RESEARCH_TOOLS,
        maxTokens: 1500,
        maxSteps: SUBAGENT_MAX_STEPS,
        synthesisUser: FINDINGS_SYNTH,
        synthesisMaxTokens: 4000,
        callBudget: { perTool: 3, total: 8 },
        deadlineMs: SUBAGENT_DEADLINE_MS,
        cache: true,
        researchEffort: "low",
        synthesisEffort: "low",
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
      {
        onAnswer: (t) => {
          findings += t;
        },
        onStep: (s) => {
          steps = s.step;
          tokensIn += s.inputTokens;
          tokensOut += s.outputTokens;
        },
        execute: async (call) => {
          const out = await executeResearchTool(call.name, call.input, book, opts.attachments);
          out.refs.forEach((r) => refs.add(r));
          return out.text;
        },
      },
    );
    if (!findings.trim() && res.answer.trim()) findings = res.answer;
    const ok = Boolean(findings.trim());
    agentLog("subagent_done", {
      run: opts.parentRun,
      sub: opts.index,
      ok,
      steps,
      refs: refs.size,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      ms: Date.now() - t0,
      objective: trunc(spec.objective, 80),
    });
    return {
      spec,
      findings: findings.trim(),
      refs: [...refs],
      steps,
      tokensIn,
      tokensOut,
      ms: Date.now() - t0,
      ok,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    agentError("subagent_failed", {
      run: opts.parentRun,
      sub: opts.index,
      error: trunc(error, 160),
      objective: trunc(spec.objective, 80),
    });
    return {
      spec,
      findings: "",
      refs: [...refs],
      steps,
      tokensIn,
      tokensOut,
      ms: Date.now() - t0,
      ok: false,
      error,
    };
  }
}

/** Run subagents in parallel over the SHARED book. Bounded concurrency, partial-
 *  failure tolerant. Returns every result (check `.ok`). */
export async function runSubagents(
  specs: SubagentSpec[],
  book: SourceBook,
  opts: { parentRun: string; attachments?: Attachment[]; signal?: AbortSignal },
): Promise<SubagentResult[]> {
  agentLog("subagents_start", {
    run: opts.parentRun,
    n: specs.length,
    model: SUBAGENT_MODEL,
    concurrency: CONCURRENCY,
  });
  const t0 = Date.now();
  const results = await mapPoolSettled(specs, CONCURRENCY, (spec, i) =>
    runSubagent(spec, book, {
      parentRun: opts.parentRun,
      index: i + 1,
      ...(opts.attachments ? { attachments: opts.attachments } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    }),
  );
  agentLog("subagents_done", {
    run: opts.parentRun,
    n: specs.length,
    ok: results.filter((r) => r.ok).length,
    tokens_total: results.reduce((s, r) => s + r.tokensIn + r.tokensOut, 0),
    ms: Date.now() - t0,
  });
  return results;
}

/** True when subagents can run (Bedrock reachable). */
export function subagentsAvailable(): boolean {
  return bedrockEnabled();
}
