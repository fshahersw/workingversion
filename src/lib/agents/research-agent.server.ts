// ============================================================================
// Single-agent litigation research loop.
//   pre-pass (resolve + ground) → ONE Sonnet 5 tool loop → streaming writer
// Replaces the router → parallel sub-agents → writer machinery: one strong
// model decides its own tool calls (in parallel), iterates until the question
// is supported, then the same model streams the final cited answer. Emits the
// SSE event vocabulary the chat UI already renders.
// ============================================================================
import type { OrchestrateInput, Emit } from "./orchestrator.server";
import { researchAgentPrompt, directAnswerPrompt } from "./prompts";
import { bedrockChat, bedrockEnabled, userText, BEDROCK_AGENT_MODEL } from "./bedrock.server";
import { classifyEffort, detectDocRequest, type EffortMode } from "@/lib/research-intent";
import { streamConverseToolLoop } from "./bedrock-stream-tools.server";
import { SourceBook } from "./tools.server";
import { RESEARCH_TOOLS, executeResearchTool } from "./research-tools.server";
import { agentLog, agentError, since, trunc } from "./log.server";
import { factCheck, unverified, kindLabel, checkCitations } from "@/lib/fact-check";
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

/** Loop model — one strong tool-caller. Sonnet 5 by default; override via env. */
const RESEARCH_MODEL = process.env["BEDROCK_RESEARCH_MODEL"] || "us.anthropic.claude-sonnet-5";
const MAX_STEPS = 5;
const RESEARCH_DEADLINE_MS = 40_000;
// Adaptive-thinking effort dial (Phase 4). ON by default (research=low,
// synthesis=medium): the 6-case x3 variance run showed this LIFTS quality
// (avg score 59->64, tier-pass 71->94%, verification 22->34%) at flat latency,
// because low-effort research turns run faster and gather more sources. Override
// per env; set a var to "" to send no effort field (pre-Phase-4 behavior).
const RESEARCH_EFFORT = process.env["BEDROCK_RESEARCH_EFFORT"] ?? "low";
const SYNTHESIS_EFFORT = process.env["BEDROCK_SYNTHESIS_EFFORT"] ?? "medium";

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
      maxSteps: 3,
      callBudget: { perTool: 3, total: 8 },
      researchEffort: "low",
      synthesisEffort: "low",
      synthesisMaxTokens: 8000,
      deadlineMs: 30_000,
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

export async function runResearchAgent(input: OrchestrateInput, emit: Emit): Promise<void> {
  const runId = crypto.randomUUID();
  const runStart = Date.now();
  emit("run", { run_id: runId, query: input.query });

  const book = new SourceBook();

  // Session memory (rolling summary, entity ledger, tail, carried sources).
  let memory: SessionMemory = normalizeMemory(input.memory);
  if (!hasContext(memory) && input.history?.length) {
    memory = { ...memory, tail: input.history.slice(-2).map((h) => ({ role: h.role, content: h.content })) };
  }

  try {
    // --- Conversational short-circuit -------------------------------------
    // Classify the RAW input first: a greeting / thanks / "who are you" /
    // reformat-my-last-answer needs no research and no decontextualization
    // (this also skips the resolve Bedrock call). The fix for "user typed
    // thanks -> full 18-call tool loop". Conservative by design: only an
    // unmistakable social/meta phrasing with no legal signal lands here.
    const rawDecision = classifyEffort(input.query, memory.tail.length);
    // An explicit Fast/Think selection means the attorney wants the tool loop —
    // skip the no-tool conversational path even for greeting-shaped inputs.
    if (rawDecision.mode === "conversational" && !input.forceMode) {
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
      return;
    }

    // --- Research path (fast / think) -------------------------------------
    // Only rewrite a follow-up to standalone when there IS prior context — a
    // first turn is already standalone, so skip the extra model call. Case
    // resolution now happens inside the loop (db_find_case), so the separate
    // grounding pre-pass is gone (one fewer Bedrock hit; less throttle risk).
    const resolved = hasContext(memory)
      ? await resolveQuestion(input.query, memory, input.signal).catch(() => ({ query: input.query, topicShift: false }))
      : { query: input.query, topicShift: false };
    // A topic shift clears the rolling summary / entity ledger / sources, but
    // KEEPS the verbatim tail: those last turns are still the immediate
    // conversational context, and dropping them here (before `history` is
    // computed below) is what silently defeated the tail injection whenever
    // resolveQuestion misfired topicShift on an empty ledger.
    if (resolved.topicShift) memory = { ...emptyMemory(), tail: memory.tail, turns: memory.turns };

    const memBlock = memoryBlock(memory);
    const history = tailMessages(memory).map((h) => ({ role: h.role, content: h.content }));
    book.seed(memory.sources);

    // Effort mode on the STANDALONE query; never fall back to conversational
    // here (a resolved follow-up is a real question). FAST = tighter budget,
    // THINK = the validated full loop, ambiguous defaults to THINK.
    const decision = classifyEffort(resolved.query, history.length);
    const autoMode: EffortMode = decision.mode === "conversational" ? "fast" : decision.mode;
    let mode: EffortMode = input.forceMode ?? autoMode;
    // A file deliverable (PDF/Word/Excel report) needs the fuller research +
    // synthesis budget; never produce a document off the tight FAST path.
    const docReq = detectDocRequest(resolved.query);
    if (docReq.wants && mode === "fast" && !input.forceMode) mode = "think";
    const cfg = modeConfig(mode);
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
    });

    const contextBlock = memBlock;
    emit("agent", { round: 1, agent: "research", focus: input.query, status: "running" });

    // --- The single research loop (Sonnet 5, tools, parallel calls) --------
    let hits = 0;
    let toolCalls = 0;
    let docCreated = false; // did the model call create_document itself?
    const refs = new Set<string>();
    const loopStart = Date.now();

    let answerText = "";
    const historyPreamble =
      history.length > 0
        ? "This is a follow-up in an ongoing chat; the earlier turns are your context.\n\n"
        : "";
    if (bedrockEnabled()) {
      try {
        const res = await streamConverseToolLoop(
          {
            model: RESEARCH_MODEL,
            system: researchAgentPrompt(),
            user: `${scopeBlock(input)}${attachmentsBlock(input)}${historyPreamble}${contextBlock ? `${contextBlock}\n\n---\n\n` : ""}QUESTION\n${resolved.query}\n\nResearch this with your tools (narrate one line before each batch, call them in parallel where independent), then write the final answer for the attorney.`,
            tools: RESEARCH_TOOLS,
            maxTokens: 2000,
            maxSteps: cfg.maxSteps,
            synthesisUser:
              "Research complete — do NOT call any more tools. Now write the final answer for the attorney, using the sources you gathered above and citing them with [S#]. Lead with the bottom line, shape the format to the question, and end on the substance (no verification/next-steps closer)." +
              (docReq.wants
                ? ` The attorney asked for a ${docReq.format.toUpperCase()} deliverable. Write the COMPLETE report now, as your answer, in clean markdown: use "## " section headings, "| pipe | tables |" for any matrices/timelines, and "- " bullet lists. The markdown you write IS the document — it will be rendered directly into the ${docReq.format.toUpperCase()}. Do NOT say you will generate a file, do NOT describe what the report will contain, and do NOT defer — write the full content in full now.`
                : mode === "fast"
                  ? " This is FAST mode: keep it tight and direct — answer the question in a few well-cited sentences or a short list, no exhaustive survey."
                  : " This is THINK mode: be thorough and well-structured — cover the sub-issues, note tensions or splits, and cite precisely."),
            // Sonnet 5 adaptive thinking is ALWAYS ON and shares this budget with
            // the answer. At 4000, heavy thinking on deep multi-part questions
            // consumed the whole budget and returned an EMPTY answer
            // (stop=max_tokens, 0 chars) — the cause of ~27% of baseline cases
            // failing. Size it generously so thinking completes AND the answer
            // fits (the writer path learned the same lesson: floor ~12k+).
            synthesisMaxTokens: cfg.synthesisMaxTokens,
            callBudget: cfg.callBudget,
            deadlineMs: cfg.deadlineMs,
            cache: true, // cache the system + tool-defs prefix across every turn
            // Real multi-turn context: prepend the verbatim recent turns so a
            // follow-up isn't riding on the rolling summary alone (memoryBlock
            // renders summary/entities/sources, never the tail).
            ...(history.length ? { history } : {}),
            ...(cfg.researchEffort ? { researchEffort: cfg.researchEffort } : {}),
            ...(cfg.synthesisEffort ? { synthesisEffort: cfg.synthesisEffort } : {}),
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
              emit("writer_start", { round: 1, sources: book.all().length });
              agentLog("writer_start", { run: runId, sources: book.all().length });
            },
            // The final synthesis turn streams straight into the answer.
            onAnswer: (text) => {
              answerText += text;
              emit("delta", { text });
            },
            onStep: (s) =>
              agentLog("agent_step", { run: runId, step: s.step, ms: s.ms, stop: s.stopReason, cache_read: s.cacheReadTokens, cache_write: s.cacheWriteTokens, calls: s.toolCalls.join(",") || "-" }),
            // A call emits tool_call TWICE with the same tool-use id: once here
            // when it STARTS (no hits, for a live "searching…" row) and once after
            // execute with the hit count. The client upserts by id, so the two
            // coalesce into one row that fills in its result — no duplicate.
            onToolUse: (call) =>
              emit("tool_call", {
                round: 1,
                agent: "research",
                id: call.id,
                tool: call.name,
                query: typeof call.input["query"] === "string" ? call.input["query"] : undefined,
              }),
            execute: async (call) => {
              toolCalls++;
              const out = await executeResearchTool(call.name, call.input, book, input.attachments);
              if (call.name === "create_document" && out.artifacts?.length) docCreated = true;
              hits += out.hits;
              out.refs.forEach((r) => refs.add(r));
              emit("tool_call", {
                round: 1,
                agent: "research",
                id: call.id,
                tool: call.name,
                query: typeof call.input["query"] === "string" ? call.input["query"] : undefined,
                hits: out.hits,
              });
              emit("sources", { sources: book.all() });
              if (out.artifacts?.length)
                emit("artifact", { round: 1, agent: "research", artifacts: out.artifacts });
              return out.text;
            },
          },
        );
        if (!answerText.trim() && res.answer.trim()) answerText = res.answer;
        agentLog("research_loop", {
          run: runId,
          ms: since(loopStart),
          mode,
          steps: res.steps,
          tool_calls: toolCalls,
          hits,
          sources: book.all().length,
          answer_chars: answerText.length,
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

    // File deliverable: if the attorney asked for one and the model didn't
    // already produce it as a tool step, render the synthesized report into the
    // file now (reliable — synthesis runs tool-less, so the model can't call
    // create_document itself once it's writing).
    if (docReq.wants && !docCreated && answerText.trim().length > 150) {
      try {
        const gen = await executeResearchTool(
          "create_document",
          { format: docReq.format, title: docTitle(resolved.query, answerText), content: answerText },
          book,
        );
        if (gen.artifacts?.length) {
          emit("artifact", { round: 1, agent: "research", artifacts: gen.artifacts });
          emit("delta", { text: `\n\n_Prepared **${gen.artifacts[0]!.name}** — download it below._` });
          agentLog("doc_generated", { run: runId, format: docReq.format, name: gen.artifacts[0]!.name });
        } else {
          agentError("doc_gen_empty", { run: runId, note: trunc(gen.text, 160) });
        }
      } catch (err) {
        agentError("doc_gen_failed", { run: runId, error: trunc(errorMessage(err), 200) });
      }
    }

    // Deterministic verification (always on, no model call, no latency): confirm
    // the specifics the model asserted (MDL/docket/dates/figures/citations) appear
    // verbatim in the retrieved sources, and that every [S#] marker maps to a real
    // source. Surfaces invented specifics / orphan citations as a trust signal.
    const facts = factCheck(answerText, sources);
    const factsVerified = facts.filter((f) => f.verified).length;
    const cites = checkCitations(answerText, sources);
    emit("verification", {
      factsChecked: facts.length,
      factsVerified,
      unverified: unverified(facts)
        .map((f) => `${kindLabel(f.kind)}: ${f.value}`)
        .slice(0, 10),
      orphanRefs: cites.orphans,
    });
    agentLog("verification", {
      run: runId,
      mode,
      facts_checked: facts.length,
      facts_verified: factsVerified,
      orphan_refs: cites.orphans.length,
    });

    emit("done", { run_id: runId, status: "complete", rounds: 1, source_count: sources.length });
    agentLog("run_done", {
      run: runId,
      status: "complete",
      mode,
      sources: sources.length,
      answer_chars: answerText.length,
      total_ms: since(runStart),
    });

    // Refresh session memory off the critical path (answer is already done).
    const nextMemory = await updateMemory(memory, input.query, answerText, sources, input.signal);
    emit("memory", { memory: nextMemory });
  } catch (err) {
    agentError("run_failed", { run: runId, total_ms: since(runStart), error: trunc(errorMessage(err), 240) });
    emit("error", { message: errorMessage(err) });
  }
}
