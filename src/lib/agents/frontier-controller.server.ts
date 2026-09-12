// ============================================================================
// Frontier request controller (§62) — flag-gated parallel path.
//
// Nemotron routes the request, then:
//   - no tools  -> fast direct-write path (§46): stream the Grok writer;
//   - tools     -> the bounded research loop: Grok orchestrator decides tool
//                  batches, the ToolRunner executes the app's real tools and
//                  normalizes to EvidenceItems, the loop races/dedupes/retries
//                  under app control, then the Grok writer answers from the
//                  verified bundle.
//
// Gated by frontierEnabled() at the SSE entry: OFF by default. Emits the existing
// SSE vocabulary so the current chat UI renders it without changes.
// ============================================================================
import type { Emit, OrchestrateInput } from "./orchestration-types.ts";
import type { ChatMessage, EvidenceBundle, RequestContext, RoutePlan, UserMode } from "./frontier-contracts.ts";
import type { Attachment, Source } from "@/lib/chat-types";
import { classifyEffort } from "@/lib/research-intent";
import {
  applyChoice,
  clarifyEnabled,
  contextFrom,
  detectClarification,
} from "./clarify.ts";
import { routeRequest } from "./frontier-router.server.ts";
import { ResearchState } from "./frontier-research-state.ts";
import { GrokOrchestrator } from "./frontier-orchestrator.server.ts";
import { ChoiceRequired, researchLoop } from "./frontier-research-loop.server.ts";
import { ResearchToolRunner } from "./frontier-tool-runner.server.ts";
import { streamGrokWriter } from "./frontier-writer.server.ts";
import { SourceBook } from "./tools.server";
import { RESEARCH_TOOLS, executeResearchTool } from "./research-tools.server";
import { normalizeMemory, tailMessages, updateMemory } from "./memory.server";
import { checkFaithfulness, judgeEnabled } from "./faithfulness.server";
import { checkCitations, factCheck, kindLabel, unverified } from "@/lib/fact-check";
import { agentError, agentLog, since, trunc } from "./log.server";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Frontier run failed.";
}

function toUserMode(forceMode?: "fast" | "think"): UserMode {
  if (forceMode === "fast") return "fast";
  if (forceMode === "think") return "deep";
  return "auto";
}

function recentFromHistory(history: OrchestrateInput["history"]): ChatMessage[] {
  return (history ?? []).slice(-6).map((h) => ({ role: h.role, content: h.content }));
}

/** A short label for a tool row from its args (mirrors the legacy chat UI). */
const LABEL_KEYS = ["query", "search", "term", "url", "docket_number", "docket_id", "document_id", "case_id", "name", "code"];
function argLabel(args: Record<string, unknown>): string | undefined {
  for (const k of LABEL_KEYS) {
    const v = args[k];
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 160);
  }
  return undefined;
}

/** Stream the Grok writer over a bundle, run deterministic verification when
 *  there are sources, then emit sources/done/memory. Shared by both paths. */
async function streamAndFinish(opts: {
  ctx: RequestContext;
  route: RoutePlan;
  bundle: EvidenceBundle;
  sources: Source[];
  runId: string;
  runStart: number;
  input: OrchestrateInput;
  emit: Emit;
}): Promise<void> {
  const { ctx, route, bundle, sources, runId, runStart, input, emit } = opts;
  emit("writer_start", { round: 1, sources: sources.length });

  let answerText = "";
  try {
    const res = await streamGrokWriter(
      { ctx, bundle, route, ...(input.signal ? { signal: input.signal } : {}) },
      {
        onAnswer: (t) => {
          answerText += t;
          emit("delta", { text: t });
        },
        onReasoning: (t) => emit("reasoning", { round: 1, agent: "writer", text: t }),
      },
    );
    agentLog("frontier_writer", {
      run: runId,
      answer_chars: answerText.length,
      stop: res.stopReason,
      tokens_in: res.usage.input,
      tokens_out: res.usage.output,
    });
  } catch (err) {
    agentError("frontier_writer_failed", { run: runId, error: trunc(errorMessage(err), 200) });
  }

  if (!answerText.trim()) {
    emit("error", { message: "The writer produced no answer (Bedrock unavailable or throttled)." });
    return;
  }

  if (sources.length) {
    const facts = factCheck(answerText, sources);
    const cites = checkCitations(answerText, sources);
    let faithful: Awaited<ReturnType<typeof checkFaithfulness>> | null = null;
    if (route.complexity === "deep" && judgeEnabled()) {
      faithful = await checkFaithfulness({
        question: ctx.userMessage,
        answer: answerText,
        sources,
        ...(input.signal ? { signal: input.signal } : {}),
      }).catch(() => null);
    }
    emit("verification", {
      factsChecked: facts.length,
      factsVerified: facts.filter((f) => f.verified).length,
      unverified: unverified(facts).map((f) => `${kindLabel(f.kind)}: ${f.value}`).slice(0, 10),
      orphanRefs: cites.orphans,
      ...(faithful
        ? { faithfulness: { checked: faithful.checked, supported: faithful.supported, unsupported: faithful.unsupported } }
        : {}),
    });
  }

  emit("sources", { sources });
  emit("done", { run_id: runId, status: "complete", rounds: sources.length ? 1 : 0, source_count: sources.length });
  agentLog("frontier_run_done", {
    run: runId,
    status: "complete",
    answer_chars: answerText.length,
    sources: sources.length,
    total_ms: since(runStart),
  });

  try {
    const memory = normalizeMemory(input.memory);
    const next = await updateMemory(memory, input.query, answerText, sources, input.signal);
    emit("memory", { memory: next });
  } catch (err) {
    agentError("frontier_memory_failed", { run: runId, error: trunc(errorMessage(err), 160) });
  }
}

export async function runFrontierAgent(init: OrchestrateInput, emit: Emit): Promise<void> {
  let input = init;
  const runId = crypto.randomUUID();
  const runStart = Date.now();

  const memory = normalizeMemory(input.memory);
  const effort = classifyEffort(input.query, memory.tail.length);
  const conversational = effort.mode === "conversational" && effort.confidence >= 0.9;

  if (input.choice) {
    input = { ...input, query: applyChoice(input.query, input.choice) };
  } else if (!conversational && clarifyEnabled()) {
    const request = detectClarification({
      query: input.query,
      // Same context the legacy path uses (the memory tail carries the
      // [Clarification — …] markers of forks already answered), so the two
      // engines ask the same questions. `input.history` is not sent by the
      // research client, which made this check blind on the frontier path.
      context: contextFrom(
        tailMessages(memory).map((h) => ({ role: h.role, content: h.content })),
        memory.entities.map((e) => e.label),
      ),
    });
    if (request) {
      emit("run", { run_id: runId, query: input.query });
      emit("choice", { choice: request });
      emit("done", { run_id: runId, status: "awaiting_choice", rounds: 0, source_count: 0 });
      agentLog("run_done", {
        run: runId,
        status: "awaiting_choice",
        engine: "frontier",
        clarify: request.id,
        total_ms: since(runStart),
      });
      return;
    }
  }

  const ctx: RequestContext = {
    requestId: runId,
    conversationId: runId,
    userMessage: input.query,
    currentDateIso: new Date().toISOString().slice(0, 10),
    userMode: toUserMode(input.forceMode),
    recentMessages: recentFromHistory(input.history),
  };

  // Nemotron routing. routeRequest never throws — it degrades to a safe fallback.
  const outcome = await routeRequest(ctx, input.signal ? { signal: input.signal } : {});
  const route = outcome.route;
  agentLog("frontier_route", {
    run: runId,
    intent: route.intent,
    complexity: route.complexity,
    needs_tools: route.needsTools,
    fallback: outcome.usedFallback,
    router_ms: outcome.latencyMs,
    rationale: route.rationaleCode,
  });

  emit("run", { run_id: runId, query: input.query });
  emit("mode", {
    mode: route.complexity === "fast" ? "fast" : "think",
    reason: `${route.intent} · ${route.rationaleCode}`,
  });

  // --- Fast direct-write path (§46): no tools, straight to the writer -------
  if (!route.needsTools) {
    agentLog("frontier_run_start", {
      run: runId,
      engine: "frontier_fast_write",
      intent: route.intent,
      style: route.answerStyle,
      q: trunc(input.query, 200),
    });
    await streamAndFinish({ ctx, route, bundle: { items: [] }, sources: [], runId, runStart, input, emit });
    return;
  }

  // --- Research path: Nemotron route -> Grok orchestrator + ToolRunner ------
  agentLog("frontier_run_start", {
    run: runId,
    engine: "frontier_research",
    intent: route.intent,
    rounds: route.maxResearchRounds,
    q: trunc(input.query, 200),
  });

  const book = new SourceBook();
  const runner = new ResearchToolRunner({
    book,
    execute: (name, args, b, att) =>
      executeResearchTool(name, args, b as SourceBook, att as Attachment[] | undefined),
    ...(input.attachments ? { attachments: input.attachments } : {}),
  });
  const orchestrator = new GrokOrchestrator({
    toolCatalog: RESEARCH_TOOLS.map((t) => ({ name: t.name, description: t.description })),
  });
  const state = new ResearchState(ctx, route);

  emit("round", {
    round: 1,
    phase: "Working the record",
    reasoning: "",
    done: false,
    dispatch: [{ agent: "research", focus: input.query }],
  });
  emit("agent", { round: 1, agent: "research", focus: input.query, status: "running" });

  const labels = new Map<string, string | undefined>();
  let bundle: EvidenceBundle;
  try {
    bundle = await researchLoop(state, orchestrator, runner, {
      perCallTimeoutMs: 20_000,
      ...(input.signal ? { signal: input.signal } : {}),
      onProgress: (label) => emit("thinking", { round: 1, agent: "research", text: `\n${label}` }),
      onToolStart: (c) => {
        const label = argLabel(c.args);
        labels.set(c.id, label);
        emit("tool_call", { round: 1, agent: "research", id: c.id, tool: c.tool, query: label });
      },
      onToolResult: (r) => {
        emit("tool_call", {
          round: 1,
          agent: "research",
          id: r.callId,
          tool: r.tool,
          query: labels.get(r.callId),
          hits: r.evidence.length,
        });
        emit("sources", { sources: book.all() });
      },
    });
  } catch (err) {
    if (err instanceof ChoiceRequired) {
      // Choice panels are not yet rendered on this path — write from what we have.
      agentLog("frontier_choice_skipped", { run: runId, panel: err.panel.id });
    } else {
      agentError("frontier_loop_failed", { run: runId, error: trunc(errorMessage(err), 200) });
    }
    bundle = state.bundle();
  }

  agentLog("frontier_loop", {
    run: runId,
    rounds: state.round,
    sources: book.all().length,
    evidence: bundle.items.length,
  });

  emit("agent_done", { round: 1, agent: "research", summary: "", count: bundle.items.length, citations: [] });
  emit("sources", { sources: book.all() });

  await streamAndFinish({ ctx, route, bundle, sources: book.all(), runId, runStart, input, emit });
}
