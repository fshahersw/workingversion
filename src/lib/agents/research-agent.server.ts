// ============================================================================
// Single-agent litigation research loop.
//   pre-pass (resolve + ground) → ONE Sonnet 5 tool loop → streaming writer
// Replaces the router → parallel sub-agents → writer machinery: one strong
// model decides its own tool calls (in parallel), iterates until the question
// is supported, then the same model streams the final cited answer. Emits the
// SSE event vocabulary the chat UI already renders.
// ============================================================================
import type { OrchestrateInput, Emit } from "./orchestrator.server";
import { researchAgentPrompt } from "./prompts";
import { bedrockEnabled } from "./bedrock.server";
import { streamConverseToolLoop } from "./bedrock-stream-tools.server";
import { SourceBook } from "./tools.server";
import { RESEARCH_TOOLS, executeResearchTool } from "./research-tools.server";
import { agentLog, agentError, since, trunc } from "./log.server";
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Research failed.";
}

function scopeBlock(input: OrchestrateInput): string {
  if (!input.matter) return "";
  return `MATTER SCOPE\nThe attorney scoped this session to: ${input.matter.label} (matter_id: ${input.matter.matter_id}). Default docket/document searches to this matter unless the question clearly concerns others.\n\n`;
}

export async function runResearchAgent(input: OrchestrateInput, emit: Emit): Promise<void> {
  const runId = crypto.randomUUID();
  const runStart = Date.now();
  emit("run", { run_id: runId, query: input.query });
  emit("round", {
    round: 1,
    phase: "Working the record",
    reasoning: "",
    done: false,
    dispatch: [{ agent: "research", focus: input.query }],
  });

  const book = new SourceBook();

  // Session memory (rolling summary, entity ledger, tail, carried sources).
  let memory: SessionMemory = normalizeMemory(input.memory);
  if (!hasContext(memory) && input.history?.length) {
    memory = { ...memory, tail: input.history.slice(-2).map((h) => ({ role: h.role, content: h.content })) };
  }

  try {
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

    agentLog("run_start", {
      run: runId,
      engine: "single_agent",
      q: trunc(input.query, 200),
      history_turns: history.length,
      carried_sources: book.all().length,
    });

    const contextBlock = memBlock;
    emit("agent", { round: 1, agent: "research", focus: input.query, status: "running" });

    // --- The single research loop (Sonnet 5, tools, parallel calls) --------
    let hits = 0;
    let toolCalls = 0;
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
            user: `${scopeBlock(input)}${historyPreamble}${contextBlock ? `${contextBlock}\n\n---\n\n` : ""}QUESTION\n${resolved.query}\n\nResearch this with your tools (narrate one line before each batch, call them in parallel where independent), then write the final answer for the attorney.`,
            tools: RESEARCH_TOOLS,
            maxTokens: 2000,
            maxSteps: MAX_STEPS,
            synthesisUser:
              "Research complete — do NOT call any more tools. Now write the final answer for the attorney, using the sources you gathered above and citing them with [S#]. Lead with the bottom line, shape the format to the question, and end on the substance (no verification/next-steps closer).",
            // Sonnet 5 adaptive thinking is ALWAYS ON and shares this budget with
            // the answer. At 4000, heavy thinking on deep multi-part questions
            // consumed the whole budget and returned an EMPTY answer
            // (stop=max_tokens, 0 chars) — the cause of ~27% of baseline cases
            // failing. Size it generously so thinking completes AND the answer
            // fits (the writer path learned the same lesson: floor ~12k+).
            synthesisMaxTokens: 16000,
            callBudget: { perTool: 4, total: 18 },
            deadlineMs: RESEARCH_DEADLINE_MS,
            cache: true, // cache the system + tool-defs prefix across every turn
            // Real multi-turn context: prepend the verbatim recent turns so a
            // follow-up isn't riding on the rolling summary alone (memoryBlock
            // renders summary/entities/sources, never the tail).
            ...(history.length ? { history } : {}),
            ...(RESEARCH_EFFORT ? { researchEffort: RESEARCH_EFFORT } : {}),
            ...(SYNTHESIS_EFFORT ? { synthesisEffort: SYNTHESIS_EFFORT } : {}),
            ...(input.signal ? { signal: input.signal } : {}),
          },
          {
            // Per-step status lines stream live as visible "thinking".
            onText: (text) => emit("thinking", { round: 1, agent: "research", text }),
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
              const out = await executeResearchTool(call.name, call.input, book);
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
              return out.text;
            },
          },
        );
        if (!answerText.trim() && res.answer.trim()) answerText = res.answer;
        agentLog("research_loop", {
          run: runId,
          ms: since(loopStart),
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

    emit("done", { run_id: runId, status: "complete", rounds: 1, source_count: sources.length });
    agentLog("run_done", {
      run: runId,
      status: "complete",
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
