// ============================================================================
// Single-agent litigation research loop.
//   pre-pass (resolve + ground) → ONE Sonnet 5 tool loop → streaming writer
// Replaces the router → parallel sub-agents → writer machinery: one strong
// model decides its own tool calls (in parallel), iterates until the question
// is supported, then the same model streams the final cited answer. Emits the
// SSE event vocabulary the chat UI already renders.
// ============================================================================
import type { Emit, OrchestrateInput } from "./orchestration-types";
import { researchAgentPrompt, fastRouterPrompt, fastWriterPrompt, directAnswerPrompt } from "./prompts";
import { bedrockChat, bedrockEnabled, userText, BEDROCK_AGENT_MODEL } from "./bedrock.server";
import { detectDocRequest, type EffortMode } from "@/lib/research-intent";

import { routeEffort } from "./effort-router.server";
import {
  applyChoice,
  clarifyEnabled,
  contextFrom,
  detectClarification,
} from "./clarify";
import { buildReportMarkdown } from "./report.server";
import { planSubquestions, runSubagents, assembleFindings, subagentsEnabled } from "./subagent.server";
import { streamConverseToolLoop } from "./bedrock-stream-tools.server";
import { loadResearchModel, loadFastModel, loadFastWriterModel } from "./research-models";
import { SourceBook } from "./tools.server";
import { RESEARCH_TOOLS, executeResearchTool } from "./research-tools.server";
import { agentLog, agentError, since, trunc } from "./log.server";
import { factCheck, unverified, kindLabel, checkCitations } from "@/lib/fact-check";
import { coverageGaps, requeryInstruction } from "./coverage.server";
import { checkFaithfulness, judgeEnabled } from "./faithfulness.server";
import { startPrefetch } from "./prefetch.server";
import {
  emptyMemory,
  hasContext,
  memoryBlock,
  normalizeMemory,
  resolveQuestion,
  tailMessages,
  updateMemory,
  type SessionMemory,
} from "./memory.server";
import { loadUserContext, recordUserMemory, type UserContext } from "./user-memory.server";

/** THINK loop + writer model (Sonnet 5 by default; override via BEDROCK_RESEARCH_MODEL).
 *  FAST runs its tool loop on loadFastModel() (Nemotron on dev / opt-in on prod)
 *  and hands the final write to loadFastWriterModel() (Sonnet). */
const RESEARCH_MODEL = loadResearchModel();
const MAX_STEPS = 5;
/** DocketBird (the db_* tools) is THINK-only: fast mode is web-first and fast, and
 *  the sequential docket calls are the slow part. Fast gets every research tool
 *  EXCEPT db_*; Think gets the full set (and does the real docket/PACER pulls). */
const FAST_TOOLS = RESEARCH_TOOLS.filter((t) => !t.name.startsWith("db_"));
const RESEARCH_DEADLINE_MS = 40_000;
// Adaptive-thinking effort dial (Phase 4). ON by default (research=low,
// synthesis=medium): the 6-case x3 variance run showed this LIFTS quality
// (avg score 59->64, tier-pass 71->94%, verification 22->34%) at flat latency,
// because low-effort research turns run faster and gather more sources. Override
// per env; set a var to "" to send no effort field (pre-Phase-4 behavior).
const RESEARCH_EFFORT = process.env["BEDROCK_RESEARCH_EFFORT"] ?? "low";
const SYNTHESIS_EFFORT = process.env["BEDROCK_SYNTHESIS_EFFORT"] ?? "medium";
// Comprehensiveness gate (quality plan A): after research, before synthesis, a
// cheap Haiku pass checks the gathered sources cover every part of the question
// and triggers ONE bounded targeted re-query round for genuine gaps. ON by
// default for THINK + report modes (never fast/conversational); set
// BEDROCK_COVERAGE_GATE=0 to disable so eval can A/B from one codebase.
const COVERAGE_GATE_ON = !/^(0|off|false)$/i.test(process.env["BEDROCK_COVERAGE_GATE"] ?? "");
/** Injected once when a fresh question (no conversation context) gets a
 *  tool-less first reply: the answer must rest on sources, not recall. */
const NO_TOOL_NUDGE =
  "You answered without consulting any source. A litigation answer must rest on retrieved authority, not recall: call the relevant tools now (in parallel where independent), then write the answer with [S#] citations. Only if this question is genuinely about the conversation itself or needs no factual support, restate your reply.";

type ModeCfg = {
  maxSteps: number;
  callBudget: { perTool: number; total: number };
  researchEffort: string;
  synthesisEffort: string;
  synthesisMaxTokens: number;
  deadlineMs: number;
};

/** Per-mode budget/effort for the tool loop. Conversational never reaches here
 *  (handled inline, no tools). THINK preserves the validated baseline exactly;
 *  FAST is a tighter, lower-latency path for a single scoped lookup. */
function modeConfig(mode: EffortMode): ModeCfg {
  if (mode === "fast") {
    return {
      // FAST is web-only (no db_* tools), so the old "live-docket work starves"
      // reason for a 5-step/50s budget no longer applies. Four turns and ten
      // calls cover a wide parallel first round plus one follow-up round; the
      // deterministic recency sweep (prefetch.server) runs alongside for free.
      maxSteps: 4,
      callBudget: { perTool: 3, total: 10 },
      // Both efforts LOW to keep FAST fast. Writer thoroughness comes from the
      // PROMPT + synthesis instruction (thorough, length-matched), not from spending
      // reasoning latency; 12k is ample for a low-effort thorough write.
      researchEffort: "low",
      synthesisEffort: "low",
      synthesisMaxTokens: 12_000,
      deadlineMs: 32_000,
    };
  }
  // think (and any non-conversational fallback) — the validated full loop.
  return {
    maxSteps: MAX_STEPS,
    callBudget: { perTool: 4, total: 18 },
    researchEffort: RESEARCH_EFFORT,
    synthesisEffort: SYNTHESIS_EFFORT,
    synthesisMaxTokens: 16000,
    deadlineMs: RESEARCH_DEADLINE_MS,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Research failed.";
}

function scopeBlock(input: OrchestrateInput): string {
  if (!input.matter) return "";
  return `MATTER SCOPE\nThe attorney scoped this session to: ${input.matter.label} (matter_id: ${input.matter.matter_id}). Default docket/document searches to this matter unless the question clearly concerns others.\n\n`;
}

function attachmentsBlock(input: OrchestrateInput): string {
  const files = (input.attachments ?? []).filter((a) => a && a.name);
  if (!files.length) return "";
  const parts = files.map((a) => {
    const header = `--- ${a.name} (${a.kind}${a.chars ? `, ${a.chars} chars` : ""}) ---`;
    const tail = a.hasFullText
      ? `\n[Only a preview is shown above. Call read_document("${a.name}", "<keywords>") to pull specific passages from the full document.]`
      : "";
    return `${header}\n${a.contextText || "(no text extracted)"}${tail}`;
  });
  const names = files.map((a) => a.name).join(", ");
  return `UPLOADED FILES\nThe attorney uploaded ${files.length} file(s) this session: ${names}. Their content is below — use it directly when the question concerns these files. Data files (CSV/Excel/JSON) are also loaded in your code sandbox, so you can run_python over them by filename to compute exact figures. For any file that shows a read_document pointer, call read_document(name, keywords) to pull additional passages from the full document.\n\n${parts.join("\n\n")}\n\n`;
}

/** The one input worth showing next to a tool row: the query for searches, else
 *  whatever identifies the target (URL, docket or document id, file name, title). */
const TOOL_LABEL_KEYS = [
  "query",
  "search",
  "url",
  "case_name",
  "docket_number",
  "docket_id",
  "document_id",
  "doc_id",
  "filing_id",
  "name",
  "title",
  "endpoint",
] as const;

function toolCallLabel(input: Record<string, unknown>): string | undefined {
  for (const key of TOOL_LABEL_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return trunc(value.trim(), 160);
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

/**
 * Wall-clock cap the loop waits on a tool, by class. Search-class tools are
 * bursty network fan-outs where a slow upstream should not stall the turn (the
 * model gets a timeout notice and moves on); page reads, the docket sheet, and
 * the code sandbox legitimately take longer.
 */
export function toolTimeoutMs(tool: string): number {
  switch (tool) {
    case "web_search":
    case "verify_citations":
    case "fda_search":
    case "federal_register_search":
    case "ecfr_search":
    case "search_pubmed":
    case "sec_search":
    case "clinicaltrials_search":
    case "db_find_case":
    case "db_get_case":
    case "db_calendar":
      return 10_000;
    case "db_search_filings":
      return 15_000;
    case "fetch_page":
    case "db_read_filing":
    case "db_docket_sheet":
    case "read_document":
      return 20_000;
    case "db_graph_ask":
      return 25_000;
    case "run_python":
      return 30_000;
    case "create_document":
      return 45_000;
    default:
      return 20_000;
  }
}

/** Short friendly confirmation shown in chat when a file deliverable is ready. */
function friendlyDone(format: string, name: string): string {
  const F = format.toUpperCase();
  const openers = [
    `**Your ${F} is ready.** I compiled the findings into **${name}** — download it below.`,
    `**Done — I put this together as a ${F}.** Grab **${name}** below.`,
    `**Your report is ready.** I saved it as **${name}** (${F}) — download it below.`,
  ];
  // Vary the phrasing deterministically by name length (no Math.random in prod path).
  return openers[name.length % openers.length]!;
}

/** A document title: prefer the report's own first heading, else clean the query. */
function docTitle(query: string, answer: string): string {
  const h = answer.match(/^#{1,3}\s+(.+)$/m);
  if (h && h[1]) return h[1].replace(/[*_`#]/g, "").trim().slice(0, 90);
  const q = query
    .replace(/^\s*\[[^\]]*\]\s*/, "")
    .replace(/\b(generate|create|make|draft|produce|build|prepare|write[- ]?up|please|for me|\d+\s*[- ]?page|pdf|word|docx|excel|spread\s?sheet|xlsx|report|memo(randum)?|document|file|deliverable|one[- ]?pager)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return q.slice(0, 80) || "Research Report";
}

export async function runResearchAgent(init: OrchestrateInput, emit: Emit): Promise<void> {
  let input = init;
  const runId = crypto.randomUUID();
  const runStart = Date.now();
  emit("run", { run_id: runId, query: input.query });

  const book = new SourceBook();

  // Session memory (rolling summary, entity ledger, tail, carried sources).
  let memory: SessionMemory = normalizeMemory(input.memory);
  if (!hasContext(memory) && input.history?.length) {
    memory = { ...memory, tail: input.history.slice(-8).map((h) => ({ role: h.role, content: h.content })) };
  }
  // Cross-chat user memory (anchors + standing preferences from earlier
  // chats). Started now so the two small DynamoDB reads overlap the classify /
  // rewrite work below; hard-capped inside loadUserContext so it can never
  // hold up the turn. Null when there is no verified principal (scripts).
  const userCtxPromise: Promise<UserContext | null> = input.principal
    ? loadUserContext(input.principal, {
        ...(input.conversationId ? { excludeConversationId: input.conversationId } : {}),
      }).catch(() => null)
    : Promise.resolve(null);
  // Fold the refreshed ledger into the user profile. Awaited (briefly) so the
  // write completes before the streamed response closes on Lambda.
  const persistUserMemory = async (mem: SessionMemory) => {
    if (!input.principal) return;
    await recordUserMemory(input.principal, input.conversationId, {
      entities: mem.entities.map((e) => ({ label: e.label, kind: e.kind })),
      preferences: mem.preferences,
    });
  };

  try {
    // --- Conversational short-circuit -------------------------------------
    // Classify the RAW input first: a greeting / thanks / "who are you" /
    // reformat-my-last-answer needs no research and no decontextualization
    // (this also skips the resolve Bedrock call). The fix for "user typed
    // thanks -> full 18-call tool loop". Conservative by design: only an
    // unmistakable social/meta phrasing with no legal signal lands here.
    const rawDecision = await routeEffort(input.query, memory.tail.length, input.signal);
    // The composer's Fast/Think choice persists in localStorage, so a forced mode
    // is the steady state for many users, not a per-message signal. It governs
    // how hard a real question is researched; it must not turn "thanks" into a
    // tool loop. Unmistakable social/meta openers (confidence >= 0.9) short-
    // circuit regardless; only the ambiguous down-routes defer to the forced mode.
    const conversational =
      rawDecision.mode === "conversational" &&
      (!input.forceMode || rawDecision.confidence >= 0.9);
    if (conversational) {
      emit("mode", { mode: "conversational", reason: rawDecision.reason });
      agentLog("run_start", { run: runId, engine: "conversational", q: trunc(input.query, 200) });
      let convo = "";
      if (bedrockEnabled()) {
        try {
          const hist = tailMessages(memory);
          const res = await bedrockChat({
            model: BEDROCK_AGENT_MODEL,
            system: directAnswerPrompt(),
            messages: [
              ...hist.map((h) => ({ role: h.role, content: [{ text: h.content }] })),
              userText(input.query),
            ],
            maxTokens: 700,
            ...(input.signal ? { signal: input.signal } : {}),
          });
          convo = res.text;
        } catch (err) {
          agentError("conversational_failed", { run: runId, error: trunc(errorMessage(err), 200) });
        }
      }
      if (!convo.trim()) convo = "Happy to help — what would you like to dig into?";
      emit("delta", { text: convo });
      emit("sources", { sources: [] });
      emit("done", { run_id: runId, status: "complete", rounds: 0, source_count: 0 });
      agentLog("run_done", { run: runId, status: "complete", engine: "conversational", answer_chars: convo.length, total_ms: since(runStart) });
      const convMemory = await updateMemory(memory, input.query, convo, [], input.signal);
      emit("memory", { memory: convMemory });
      await persistUserMemory(convMemory);
      return;
    }

    // --- Pre-flight clarification ------------------------------------------
    // Ask before spending the tool budget when the question forks in a way
    // that changes the work (forum / jurisdiction / deliverable). Resume
    // rewrites the same question deterministically; it does not restart.
    if (input.choice) {
      input = { ...input, query: applyChoice(input.query, input.choice) };
    } else if (clarifyEnabled()) {
      const request = detectClarification({
        query: input.query,
        context: contextFrom(tailMessages(memory), memory.entities.map((e) => e.label)),
      });
      if (request) {
        emit("choice", { choice: request });
        emit("done", { run_id: runId, status: "awaiting_choice", rounds: 0, source_count: 0 });
        agentLog("run_done", {
          run: runId,
          status: "awaiting_choice",
          clarify: request.id,
          total_ms: since(runStart),
        });
        return;
      }
    }

    // --- Research path (fast / think) -------------------------------------
    // Only rewrite a follow-up to standalone when there IS prior context — a
    // first turn is already standalone, so skip the extra model call. Case
    // resolution now happens inside the loop (db_find_case), so the separate
    // grounding pre-pass is gone (one fewer Bedrock hit; less throttle risk).
    // A clarified question (resume after a choice panel) is standalone by
    // construction and carries a trailing [Clarification — …] constraint that a
    // model rewrite could drop or truncate, so it skips the rewrite entirely.
    const resolved =
      hasContext(memory) && !input.choice
        ? await resolveQuestion(input.query, memory, input.signal).catch(() => ({ query: input.query, topicShift: false }))
        : { query: input.query, topicShift: false };
    // A topic shift clears the rolling summary / entity ledger / sources, but
    // KEEPS the verbatim tail: those last turns are still the immediate
    // conversational context, and dropping them here (before `history` is
    // computed below) is what silently defeated the tail injection whenever
    // resolveQuestion misfired topicShift on an empty ledger.
    // Standing instructions ("always Bluebook", "NJ only") are about HOW to
    // answer, not WHAT the chat is about, so they survive a topic shift too.
    if (resolved.topicShift)
      memory = { ...emptyMemory(), tail: memory.tail, preferences: memory.preferences, turns: memory.turns };

    const memBlock = memoryBlock(memory);
    const history = tailMessages(memory).map((h) => ({ role: h.role, content: h.content }));
    book.seed(memory.sources);
    const userCtx = await userCtxPromise;

    // Effort mode on the STANDALONE query; never fall back to conversational
    // here (a resolved follow-up is a real question). FAST = tighter budget,
    // THINK = the validated full loop, ambiguous defaults to THINK.
    // The raw decision already covers this query when no rewrite happened;
    // only a rewritten standalone query is classed again.
    const decision =
      resolved.query === input.query ? rawDecision : await routeEffort(resolved.query, history.length, input.signal);
    const autoMode: EffortMode = decision.mode === "conversational" ? "fast" : decision.mode;
    let mode: EffortMode = input.forceMode ?? autoMode;
    // A file deliverable (PDF/Word/Excel report) needs the fuller research +
    // synthesis budget; never produce a document off the tight FAST path.
    const docReq = detectDocRequest(resolved.query);
    if (docReq.wants && mode === "fast" && !input.forceMode) mode = "think";
    const cfg = modeConfig(mode);
    // A report deliverable needs a deeper, richer source pool than a chat answer —
    // widen the research budget so the parallel section drafts have enough to work with.
    if (docReq.wants) {
      cfg.maxSteps = Math.max(cfg.maxSteps, 7);
      cfg.callBudget = { perTool: 5, total: 26 };
      cfg.deadlineMs = Math.max(cfg.deadlineMs, 75_000);
    }
    emit("mode", { mode, reason: input.forceMode ? `${mode} mode (selected)` : decision.reason });

    emit("round", {
      round: 1,
      phase: "Working the record",
      reasoning: "",
      done: false,
      dispatch: [{ agent: "research", focus: input.query }],
    });

    agentLog("run_start", {
      run: runId,
      engine: "single_agent",
      mode,
      q: trunc(input.query, 200),
      history_turns: history.length,
      carried_sources: book.all().length,
      user_ctx_chars: userCtx?.block.length ?? 0,
    });

    // Cross-chat background first (small, clearly labelled as background),
    // then this conversation's own working memory.
    const contextBlock = [userCtx?.block ?? "", memBlock].filter(Boolean).join("\n\n");
    emit("agent", { round: 1, agent: "research", focus: input.query, status: "running" });

    // --- The single research loop (Sonnet 5, tools, parallel calls) --------
    let hits = 0;
    let toolCalls = 0;
    let docCreated = false; // did the model call create_document itself?
    const refs = new Set<string>();
    const loopStart = Date.now();
    // Per-run token accounting — Bedrock returns exact billed usage per turn
    // (usage.inputTokens/outputTokens) via onStep; sum across the research loop +
    // synthesis for the trace and the subagent cost model. Side calls (coverage
    // gate, faithfulness judge, memory) are separate and not included here.
    let tokIn = 0;
    let tokOut = 0;
    let cacheRead = 0;
    let cacheWrite = 0;

    let answerText = "";
    let directAnswer = false;
    const hasFollowupContext = history.length > 0 || book.all().length > 0;
    const historyPreamble =
      history.length > 0
        ? "This is a follow-up in an ongoing chat; the earlier turns are your context.\n\n"
        : "";
    // Speculative recency sweep: a deterministic last-30-days web_search on the
    // question's distinctive terms, started NOW so it runs during the model's
    // first turn (TTFT + tool-use generation) instead of after it. Handed to
    // the model's first web_search result when that executes. Off on a follow-up
    // that already carries sources (the model will reuse them) and when the
    // sweep would be noise (see buildPrefetchPlan).
    const prefetch =
      book.all().length === 0
        ? startPrefetch(resolved.query, book, input.signal ? { signal: input.signal } : {})
        : null;
    if (prefetch) {
      agentLog("prefetch_start", {
        run: runId,
        q: prefetch.plan.query,
        variants: prefetch.plan.queries.length,
        categories: prefetch.plan.categories.join(","),
      });
    }
    // Start times per tool-use id so the completion event can carry a duration.
    const toolStarted = new Map<string, number>();

    if (bedrockEnabled()) {
      try {
        const res = await streamConverseToolLoop(
          {
            model: mode === "fast" ? loadFastModel() : RESEARCH_MODEL,
            synthesisModel: mode === "fast" ? loadFastWriterModel() : RESEARCH_MODEL,
            system: mode === "fast" ? fastRouterPrompt() : researchAgentPrompt(),
            // FAST splits the loop and the write: the router (system) gathers and
            // never writes; the writer (synthesisSystem) composes the answer.
            ...(mode === "fast" ? { synthesisSystem: fastWriterPrompt() } : {}),
            user: `${scopeBlock(input)}${attachmentsBlock(input)}${historyPreamble}${contextBlock ? `${contextBlock}\n\n---\n\n` : ""}QUESTION\n${resolved.query}\n\n${
              mode === "fast"
                ? "Research this with your tools — narrate one line before each batch, call them in parallel where independent — then STOP. A separate writer composes the final answer from the sources you gather; do not write it yourself."
                : "Research this with your tools (narrate one line before each batch, call them in parallel where independent), then write the final answer for the reader."
            }`,
            tools: mode === "fast" ? FAST_TOOLS : RESEARCH_TOOLS,
            maxTokens: 2000,
            maxSteps: cfg.maxSteps,
            synthesisUser: docReq.wants
              ? "Research complete — do NOT call any more tools. Write a DENSE research digest that a formatted report will be built from: capture every key fact, date, holding, figure, party, defendant, procedural milestone, and expert/Daubert point you found, each with its [S#] citation. Terse notes and bullet fragments are fine — completeness over prose. This is raw material, NOT the finished report: do not add a title, cover, or any 'Executive Summary'/'Bottom line' section — just get all the substance down with citations."
              : "Research complete — do NOT call any more tools. Now write the final answer for the reader who asked, using the sources you gathered above and citing them with [S#]. Open with the direct answer, shape the format to the question, and end on the substance (no verification/next-steps closer)." +
                " Be thorough and well-structured — cover the sub-issues the question raises, note any tensions or splits, and cite precisely. Match the length to the question and never truncate real substance to be brief; a short question still gets a tight answer, but a multi-part or status question gets the full, well-organized treatment with the dates, parties, orders, and figures that matter.",
            // Sonnet 5 adaptive thinking is ALWAYS ON and shares this budget with
            // the answer. At 4000, heavy thinking on deep multi-part questions
            // consumed the whole budget and returned an EMPTY answer
            // (stop=max_tokens, 0 chars) — the cause of ~27% of baseline cases
            // failing. Size it generously so thinking completes AND the answer
            // fits (the writer path learned the same lesson: floor ~12k+).
            synthesisMaxTokens: cfg.synthesisMaxTokens,
            callBudget: cfg.callBudget,
            deadlineMs: cfg.deadlineMs,
            // Per-class caps: a slow search upstream costs the turn ~10s at most
            // instead of stalling it for the tool's own 30s internal timeout.
            perToolTimeoutMs: toolTimeoutMs,
            cache: true, // cache the system + tool-defs prefix across every turn
            // Real multi-turn context: prepend the verbatim recent turns so a
            // follow-up isn't riding on the rolling summary alone (memoryBlock
            // renders summary/entities/sources, never the tail).
            ...(history.length ? { history } : {}),
            ...(cfg.researchEffort ? { researchEffort: cfg.researchEffort } : {}),
            ...(cfg.synthesisEffort ? { synthesisEffort: cfg.synthesisEffort } : {}),
            // Comprehensiveness gate (plan A): every voluntary stop in THINK +
            // report modes. FAST stays tight: it is consulted only when the model
            // stopped without a single tool call, the one case where a scoped
            // lookup is about to be answered from recall instead of a source.
            ...(COVERAGE_GATE_ON
              ? {
                  gate: {
                    check: async (ctx: { totalCalls: number }) => {
                      if (mode === "fast" && !docReq.wants && ctx.totalCalls > 0) return null;
                      const gaps = await coverageGaps({
                        query: resolved.query,
                        sources: book.all(),
                        ...(input.signal ? { signal: input.signal } : {}),
                      });
                      // Always log the consult (covered or not) so the gate's
                      // behavior is observable — a silent pass was previously
                      // indistinguishable from "never fired".
                      agentLog("coverage_check", {
                        run: runId,
                        consulted: gaps !== null,
                        covered: gaps?.covered ?? null,
                        missing: gaps?.missing.length ?? 0,
                        sources: book.all().length,
                      });
                      if (!gaps || gaps.covered) return null;
                      if (!gaps.missing.length && !gaps.queries.length) return null;
                      agentLog("coverage_gap", {
                        run: runId,
                        sources: book.all().length,
                        missing: gaps.missing,
                        queries: gaps.queries,
                      });
                      // Surface the coverage follow-up as a live thinking line.
                      const label = gaps.missing.slice(0, 3).join("; ") || "open gaps";
                      emit("thinking", {
                        round: 1,
                        agent: "research",
                        text: `\nChecking coverage — following up on ${label}.`,
                      });
                      return requeryInstruction(gaps);
                    },
                  },
                }
              : {}),
            // In FAST the loop model (Nemotron) NEVER emits the answer — the writer
            // always composes it — so fast skips the direct-answer shortcut: a
            // no-tool turn just breaks through to the writer synthesis. In THINK
            // (one Sonnet doing both) a follow-up answerable from the conversation
            // and carried sources still streams its first tool-less reply as the
            // answer (one turn instead of draft + synthesis). Either mode, a fresh
            // question with no context gets one nudge to research before recall.
            ...(hasFollowupContext
              ? mode === "fast"
                ? {}
                : { directAnswer: { minChars: 160 } }
              : { noToolNudge: NO_TOOL_NUDGE }),
            ...(input.signal ? { signal: input.signal } : {}),
          },
          {
            // Per-step status lines stream live as visible "thinking".
            onText: (text) => emit("thinking", { round: 1, agent: "research", text }),
            // The model's actual adaptive-thinking reasoning streams live on its own
            // channel — fills the otherwise-silent synthesis gap (the frontier feel).
            onReasoning: (text) => emit("reasoning", { round: 1, agent: "research", text }),
            // Research done → mark the agent done and flip the UI to the answer.
            onSynthesisStart: () => {
              emit("agent_done", { round: 1, agent: "research", summary: "", count: hits, citations: [...refs] });
              emit("sources", { sources: book.all() });
              emit("writer_start", { round: 1, sources: book.all().length, ...(docReq.wants ? { deliverable: docReq.format } : {}) });
              agentLog("writer_start", { run: runId, sources: book.all().length });
            },
            // The final synthesis turn streams straight into the answer — EXCEPT
            // for a file deliverable, where the report goes into the file (not the
            // chat); we accumulate it silently and show a short note when done.
            onAnswer: (text) => {
              answerText += text;
              if (!docReq.wants) emit("delta", { text });
            },
            onStep: (s) => {
              tokIn += s.inputTokens;
              tokOut += s.outputTokens;
              cacheRead += s.cacheReadTokens;
              cacheWrite += s.cacheWriteTokens;
              agentLog("agent_step", { run: runId, step: s.step, ms: s.ms, stop: s.stopReason, in: s.inputTokens, out: s.outputTokens, cache_read: s.cacheReadTokens, cache_write: s.cacheWriteTokens, calls: s.toolCalls.join(",") || "-" });
            },
            // A call emits tool_call TWICE with the same tool-use id: once here
            // when it STARTS (no hits, for a live "searching…" row) and once after
            // execute with the hit count. The client upserts by id, so the two
            // coalesce into one row that fills in its result — no duplicate.
            onToolUse: (call) => {
              toolStarted.set(call.id, Date.now());
              emit("tool_call", {
                round: 1,
                agent: "research",
                id: call.id,
                tool: call.name,
                query: toolCallLabel(call.input),
              });
            },
            // The loop stopped waiting on this call. Settle its row as timed out
            // now; if the underlying call later resolves, execute() below still
            // emits its real completion and the row updates in place.
            onToolTimeout: (call, ms) =>
              emit("tool_call", {
                round: 1,
                agent: "research",
                id: call.id,
                tool: call.name,
                query: toolCallLabel(call.input),
                hits: 0,
                ms,
                error: "timeout",
              }),
            execute: async (call) => {
              toolCalls++;
              const started = toolStarted.get(call.id) ?? Date.now();
              let out;
              try {
                out = await executeResearchTool(call.name, call.input, book, input.attachments);
              } catch (err) {
                // A thrown tool previously left its row spinning forever: emit the
                // failure so the timeline settles, then let the loop report it.
                emit("tool_call", {
                  round: 1,
                  agent: "research",
                  id: call.id,
                  tool: call.name,
                  query: toolCallLabel(call.input),
                  hits: 0,
                  ms: Date.now() - started,
                  error: "error",
                });
                throw err;
              }
              // Fold the speculative recency sweep into the FIRST web_search result
              // (a text enrichment of an existing toolResult; no new wire blocks).
              // Its sources are already in the book under their own refs.
              if (call.name === "web_search" && prefetch && !prefetch.consumed) {
                // Wait for the sweep only within what is left of this call's
                // loop cap (minus a margin), never past it: a wait that pushed a
                // finished search over the cap made the model see "timed out"
                // for a call that had actually succeeded. take(0) is non-blocking
                // and leaves the sweep for a later web_search when it is still
                // running.
                const remaining = toolTimeoutMs(call.name) - (Date.now() - started) - 750;
                const sweep = await prefetch.take(Math.max(0, Math.min(4_000, remaining)));
                if (sweep) {
                  out = {
                    ...out,
                    text: `${out.text}\n\n### recency sweep (last 30 days, run in parallel)\n${sweep.text}`,
                    hits: out.hits + sweep.hits,
                    refs: [...out.refs, ...sweep.refs],
                  };
                  agentLog("prefetch_merged", { run: runId, hits: sweep.hits, ms: prefetch.ms() });
                }
              }
              if (call.name === "create_document" && out.artifacts?.length) docCreated = true;
              hits += out.hits;
              out.refs.forEach((r) => refs.add(r));
              emit("tool_call", {
                round: 1,
                agent: "research",
                id: call.id,
                tool: call.name,
                query: toolCallLabel(call.input),
                hits: out.hits,
                ms: Date.now() - started,
                // Top hosts behind this call's sources, for the timeline's chips.
                hosts: book.hostsFor(out.refs),
              });
              emit("sources", { sources: book.all() });
              if (out.artifacts?.length)
                emit("artifact", { round: 1, agent: "research", artifacts: out.artifacts });
              return out.text;
            },
          },
        );
        if (!answerText.trim() && res.answer.trim()) answerText = res.answer;
        directAnswer = Boolean(res.direct);
        agentLog("research_loop", {
          run: runId,
          ms: since(loopStart),
          mode,
          steps: res.steps,
          tool_calls: toolCalls,
          hits,
          sources: book.all().length,
          answer_chars: answerText.length,
          gate_requeried: res.gateRequeried,
          direct: directAnswer,
          tokens_in: tokIn,
          tokens_out: tokOut,
          tokens_total: tokIn + tokOut,
          cache_read: cacheRead,
          cache_write: cacheWrite,
        });
      } catch (err) {
        agentError("research_loop_failed", { run: runId, error: trunc(errorMessage(err), 200) });
      }
    }

    const sources = book.all();
    if (!answerText.trim()) {
      emit("sources", { sources });
      agentError("no_answer", { run: runId, q: trunc(input.query, 200) });
      throw new Error("Research produced no answer (Bedrock unavailable or throttled).");
    }
    emit("sources", { sources });

    // File deliverable: the report was written into `answerText` but NOT streamed
    // to chat (see onAnswer). Render it into the file, then show a short friendly
    // note — the chat stays clean, the content lives in the download.
    if (docReq.wants) {
      // Track A — light subagents for file deliverables (flag-gated via
      // BEDROCK_SUBAGENTS, off by default). Decompose the request and run a small
      // bounded pool of focused subagents over the SHARED book to add targeted
      // depth, then fold their findings into the digest the report is built from.
      // book.all() is a live reference, so buildReportMarkdown below sees the new
      // sources automatically. Bounded + tolerant: a failure never blocks the doc.
      if (subagentsEnabled() && answerText.trim() && !docCreated) {
        try {
          const specs = await planSubquestions(resolved.query, {
            max: 3, // "light": a small pool, not the full deep-research fan-out
            ...(input.signal ? { signal: input.signal } : {}),
          });
          if (specs.length >= 2) {
            emit("thinking", {
              round: 1,
              agent: "research",
              text: `\nExpanding the report with ${specs.length} parallel research threads.`,
            });
            const results = await runSubagents(specs, book, {
              parentRun: runId,
              ...(input.attachments ? { attachments: input.attachments } : {}),
              ...(input.signal ? { signal: input.signal } : {}),
              budget: { maxSteps: 3, deadlineMs: 40_000 }, // keep the in-flow pass light
            });
            const extra = assembleFindings(results);
            if (extra.trim()) {
              answerText = `${answerText}\n\n---\nADDITIONAL PARALLEL RESEARCH FINDINGS\n${extra}`;
              emit("sources", { sources: book.all() });
            }
          }
        } catch (err) {
          agentError("subagents_report_failed", {
            run: runId,
            error: trunc(errorMessage(err), 160),
          });
        }
      }

      let handled = false;
      if (!docCreated && answerText.trim().length > 120) {
        try {
          // Multi-pass pipeline: plan dynamic sections -> draft them in parallel
          // -> refine thin ones. Falls back to the digest if planning fails.
          const report = await buildReportMarkdown({
            query: resolved.query,
            digest: answerText,
            sources,
            verifyClaims: mode === "think", // Think/Research get the adversarial citation audit
            ...(docReq.pages ? { pages: docReq.pages } : {}),
            ...(input.signal ? { signal: input.signal } : {}),
            onProgress: (m) => agentLog("report_progress", { run: runId, msg: m }),
          });
          const md = report?.markdown || answerText;
          const title = report?.title || docTitle(resolved.query, answerText);
          const gen = await executeResearchTool(
            "create_document",
            { format: docReq.format, title, content: md, style: docReq.style },
            book,
          );
          if (gen.artifacts?.length) {
            emit("artifact", { round: 1, agent: "research", artifacts: gen.artifacts });
            emit("delta", { text: friendlyDone(docReq.format, gen.artifacts[0]!.name) });
            handled = true;
            agentLog("doc_generated", { run: runId, format: docReq.format, name: gen.artifacts[0]!.name, sections: report?.sections ?? 0 });
          } else {
            agentError("doc_gen_empty", { run: runId, note: trunc(gen.text, 160) });
          }
        } catch (err) {
          agentError("doc_gen_failed", { run: runId, error: trunc(errorMessage(err), 200) });
        }
      }
      if (!handled) {
        // The model already produced the file as a tool step -> confirm; otherwise
        // the render failed / too little content -> fall back to the report inline
        // so nothing the model wrote is ever lost.
        if (docCreated) {
          emit("delta", { text: "**Your file is ready — download it below.**" });
        } else if (answerText.trim()) {
          emit("delta", { text: `${answerText}\n\n_(I couldn't render the file this time — the full report is above.)_` });
        } else {
          emit("delta", { text: "I couldn't compile the report this time. Try again, or tell me what sections you'd like in it." });
        }
      }
    }

    // Deterministic verification (always on, no model call, no latency): confirm
    // the specifics the model asserted (MDL/docket/dates/figures/citations) appear
    // verbatim in the retrieved sources, and that every [S#] marker maps to a real
    // source. Surfaces invented specifics / orphan citations as a trust signal.
    // The corpus includes the book's untrimmed verification shadow, so a
    // specific the model read on a fetched page or filing verifies even when it
    // sits past the bounded `content` excerpt the client receives.
    const facts = factCheck(answerText, sources, book.fullTexts());
    const factsVerified = facts.filter((f) => f.verified).length;
    const cites = checkCitations(answerText, sources);
    const deterministic = {
      factsChecked: facts.length,
      factsVerified,
      unverified: unverified(facts)
        .map((f) => `${kindLabel(f.kind)}: ${f.value}`)
        .slice(0, 10),
      orphanRefs: cites.orphans,
    };
    emit("verification", deterministic);

    // `done` goes out the moment the answer and its deterministic checks are in.
    // Everything below is post-answer work the reader should not wait on: the
    // client releases the composer on `done` and keeps reading late events.
    emit("done", { run_id: runId, status: "complete", rounds: 1, source_count: sources.length });
    agentLog("run_done", {
      run: runId,
      status: "complete",
      mode,
      sources: sources.length,
      answer_chars: answerText.length,
      total_ms: since(runStart),
      tokens_in: tokIn,
      tokens_out: tokOut,
      tokens_total: tokIn + tokOut,
    });

    // Citation-faithfulness (accuracy lever): a REASONING model judges whether
    // each [S#]-cited claim actually follows from its cited source (catching
    // overstatement / mis-attribution / fabrication) — the valid signal for
    // abstractive legal synthesis, where extractive contextual-grounding was
    // unusable. Score-only — never blocks the already-streamed answer.
    // THINK/report modes only; no-op unless BEDROCK_JUDGE_MODEL is set; null on
    // any failure/timeout. Re-emits `verification` with the verdict attached.
    const faithful =
      (mode === "think" || docReq.wants) && judgeEnabled()
        ? await checkFaithfulness({
            question: resolved.query,
            answer: answerText,
            sources,
            ...(input.signal ? { signal: input.signal } : {}),
          })
        : null;
    if (faithful) {
      emit("verification", {
        ...deterministic,
        faithfulness: {
          checked: faithful.checked,
          supported: faithful.supported,
          unsupported: faithful.unsupported,
        },
      });
    }
    agentLog("verification", {
      run: runId,
      mode,
      facts_checked: facts.length,
      facts_verified: factsVerified,
      orphan_refs: cites.orphans.length,
      ...(faithful
        ? {
            faith_checked: faithful.checked,
            faith_supported: faithful.supported,
            faith_unsupported: faithful.unsupported.length,
          }
        : {}),
    });

    // Refresh session memory off the critical path (answer is already done).
    const nextMemory = await updateMemory(memory, input.query, answerText, sources, input.signal);
    emit("memory", { memory: nextMemory });
    await persistUserMemory(nextMemory);
  } catch (err) {
    agentError("run_failed", { run: runId, total_ms: since(runStart), error: trunc(errorMessage(err), 240) });
    emit("error", { message: errorMessage(err) });
  }
}
