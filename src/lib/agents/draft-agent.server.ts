// ============================================================================
// Drafts assistant loop (server-only). Same machinery as the research agent
// (Sonnet 5 tool loop, parallel calls, session memory, SSE vocabulary the chat
// UI already renders) pointed at the attorney's document: the document text,
// selection and cursor context ride in the prompt; write/edit/research replies
// carry document material behind CONTENT_MARKER for the client's proposal card.
// Edit and review run as one streamed turn with no tools, so they return in
// seconds.
// ============================================================================
import type { Attachment } from "@/lib/chat-types";
import { checkCitations, factCheck, unverified, kindLabel } from "@/lib/fact-check";

import { streamWriter, type BedrockEffort } from "./bedrock-claude.server";
import { bedrockEnabled } from "./bedrock.server";
import { streamConverseToolLoop } from "./bedrock-stream-tools.server";
import { coverageGaps, requeryInstruction } from "./coverage.server";
import { splitMaterial } from "@/lib/drafts/material";

import { draftAgentPrompt, draftSynthesisInstruction, type DraftMode } from "./draft-prompts";
import { agentError, agentLog, since, trunc } from "./log.server";
import {
  hasContext,
  memoryBlock,
  normalizeMemory,
  tailMessages,
  updateMemory,
  type SessionMemory,
} from "./memory.server";
import type { Emit, HistoryTurn } from "./orchestration-types";
import { RESEARCH_TOOLS, executeResearchTool } from "./research-tools.server";
import { SourceBook } from "./tools.server";

const DRAFT_MODEL = process.env["BEDROCK_RESEARCH_MODEL"] || "us.anthropic.claude-sonnet-5";
const RESEARCH_EFFORT = process.env["BEDROCK_RESEARCH_EFFORT"] ?? "low";
const SYNTHESIS_EFFORT = process.env["BEDROCK_SYNTHESIS_EFFORT"] ?? "medium";
const COVERAGE_GATE_ON = !/^(0|off|false)$/i.test(process.env["BEDROCK_COVERAGE_GATE"] ?? "");

/** Document text budget in the prompt; long documents are abridged in the middle. */
const DOC_HEAD_CHARS = 28_000;
const DOC_TAIL_CHARS = 12_000;
const SELECTION_CHARS = 20_000;
const CONTEXT_CHARS = 1_200;

export type DraftDocumentContext = {
  title: string;
  /** Full plain text of the document (the server abridges it). */
  text: string;
  /** Selected passage, when the attorney selected one. */
  selection?: string;
  /** Text immediately before / after the cursor (or the selection). */
  before?: string;
  after?: string;
  style?: string;
};

export type DraftAgentInput = {
  mode: DraftMode;
  instruction: string;
  document: DraftDocumentContext;
  history?: HistoryTurn[];
  memory?: unknown;
  attachments?: Attachment[];
  signal?: AbortSignal;
};

type ModeCfg = {
  tools: boolean;
  maxSteps: number;
  callBudget: { perTool: number; total: number };
  deadlineMs: number;
  synthesisMaxTokens: number;
  gate: boolean;
};

function modeConfig(mode: DraftMode): ModeCfg {
  switch (mode) {
    case "research":
      return {
        tools: true,
        maxSteps: 6,
        callBudget: { perTool: 4, total: 20 },
        deadlineMs: 55_000,
        synthesisMaxTokens: 16_000,
        gate: true,
      };
    case "write":
      return {
        tools: true,
        maxSteps: 4,
        callBudget: { perTool: 3, total: 10 },
        deadlineMs: 40_000,
        synthesisMaxTokens: 14_000,
        gate: false,
      };
    case "ask":
      return {
        tools: true,
        maxSteps: 3,
        callBudget: { perTool: 3, total: 8 },
        deadlineMs: 30_000,
        synthesisMaxTokens: 8_000,
        gate: false,
      };
    case "edit":
    case "review":
      return {
        tools: false,
        maxSteps: 0,
        callBudget: { perTool: 0, total: 0 },
        deadlineMs: 0,
        synthesisMaxTokens: 12_000,
        gate: false,
      };
  }
}

/** The document, abridged in the middle when long, so head and tail both survive. */
function abridge(text: string): string {
  const clean = text.replace(/\r\n?/g, "\n").trim();
  if (clean.length <= DOC_HEAD_CHARS + DOC_TAIL_CHARS) return clean;
  const omitted = clean.length - DOC_HEAD_CHARS - DOC_TAIL_CHARS;
  return `${clean.slice(0, DOC_HEAD_CHARS)}\n\n[... ${omitted.toLocaleString()} characters omitted from the middle of the document ...]\n\n${clean.slice(-DOC_TAIL_CHARS)}`;
}

function documentBlock(doc: DraftDocumentContext, mode: DraftMode): string {
  const parts: string[] = [];
  parts.push(
    `DOCUMENT TITLE: ${doc.title || "Untitled document"}${doc.style ? ` (style: ${doc.style})` : ""}`,
  );
  const text = abridge(doc.text ?? "");
  parts.push(text ? `DOCUMENT TEXT\n${text}` : "DOCUMENT TEXT\n(the document is empty)");
  const selection = (doc.selection ?? "").trim();
  if (selection) {
    parts.push(
      `SELECTED PASSAGE (the attorney selected this)\n${trunc(selection, SELECTION_CHARS)}`,
    );
  } else if (mode !== "review") {
    const before = (doc.before ?? "").slice(-CONTEXT_CHARS);
    const after = (doc.after ?? "").slice(0, CONTEXT_CHARS);
    if (before || after) {
      parts.push(
        `CURSOR CONTEXT\nText before the cursor:\n${before || "(start of document)"}\n\nText after the cursor:\n${after || "(end of document)"}`,
      );
    }
  }
  return parts.join("\n\n");
}

function attachmentsBlock(attachments: Attachment[] | undefined): string {
  const files = (attachments ?? []).filter((a) => a && a.name);
  if (!files.length) return "";
  const parts = files.map((a) => {
    const header = `--- ${a.name} (${a.kind}${a.chars ? `, ${a.chars} chars` : ""}) ---`;
    const tail = a.hasFullText
      ? `\n[Only a preview is shown. Call read_document("${a.name}", "<keywords>") for more of the full document.]`
      : "";
    return `${header}\n${a.contextText || "(no text extracted)"}${tail}`;
  });
  return `UPLOADED FILES (this session)\n${parts.join("\n\n")}\n\n`;
}

function taskLine(mode: DraftMode, instruction: string, hasSelection: boolean): string {
  const target = hasSelection ? "the selected passage" : "the cursor position";
  switch (mode) {
    case "write":
      return `REQUEST (write material for ${target})\n${instruction}`;
    case "edit":
      return `REQUEST (rewrite the selected passage)\n${instruction || "Improve this passage: tighter, clearer, same facts."}`;
    case "ask":
      return `QUESTION\n${instruction}`;
    case "review":
      return `REVIEW REQUEST${hasSelection ? " (the selected passage)" : " (the whole document)"}\n${instruction || "Review this for problems a senior litigator would flag."}`;
    case "research":
      return `RESEARCH REQUEST (findings become document material for ${target})\n${instruction}`;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "The assistant failed.";
}

function asEffort(value: string): BedrockEffort {
  return value === "medium" || value === "high" || value === "xhigh" || value === "max"
    ? value
    : "low";
}

export async function runDraftAgent(input: DraftAgentInput, emit: Emit): Promise<void> {
  const runId = crypto.randomUUID();
  const runStart = Date.now();
  const mode = input.mode;
  const cfg = modeConfig(mode);
  emit("run", { run_id: runId, query: input.instruction, surface: "draft" });
  emit("mode", { mode, reason: `${mode} mode` });

  let memory: SessionMemory = normalizeMemory(input.memory);
  if (!hasContext(memory) && input.history?.length) {
    memory = {
      ...memory,
      tail: input.history.slice(-4).map((h) => ({ role: h.role, content: h.content })),
    };
  }
  const history = tailMessages(memory).map((h) => ({ role: h.role, content: h.content }));
  const book = new SourceBook();
  book.seed(memory.sources);

  const hasSelection = Boolean((input.document.selection ?? "").trim());
  const user = [
    attachmentsBlock(input.attachments),
    documentBlock(input.document, mode),
    memoryBlock(memory) ? `\n${memoryBlock(memory)}` : "",
    "",
    taskLine(mode, input.instruction.trim(), hasSelection),
  ]
    .filter((p) => p !== "")
    .join("\n\n");

  agentLog("run_start", {
    run: runId,
    engine: "draft_agent",
    mode,
    q: trunc(input.instruction, 200),
    doc_chars: input.document.text?.length ?? 0,
    selection_chars: input.document.selection?.length ?? 0,
    history_turns: history.length,
  });

  if (!bedrockEnabled()) {
    emit("error", { message: "The assistant is not configured (Bedrock unavailable)." });
    return;
  }

  let answerText = "";
  try {
    if (!cfg.tools) {
      // Edit / review: one streamed turn, no tools, straight to the answer.
      emit("writer_start", { round: 1, sources: 0 });
      const res = await streamWriter(
        {
          model: DRAFT_MODEL,
          system: draftAgentPrompt(mode),
          messages: [
            ...history.map((h) => ({ role: h.role, content: h.content })),
            { role: "user" as const, content: user },
          ],
          maxTokens: cfg.synthesisMaxTokens,
          effort: asEffort(mode === "review" ? SYNTHESIS_EFFORT : RESEARCH_EFFORT),
          ...(input.signal ? { signal: input.signal } : {}),
        },
        {
          onText: (text) => {
            answerText += text;
            emit("delta", { text });
          },
        },
      );
      if (!answerText.trim() && res.text.trim()) {
        answerText = res.text;
        emit("delta", { text: res.text });
      }
    } else {
      emit("round", {
        round: 1,
        phase: mode === "ask" ? "Looking into it" : "Researching the material",
        reasoning: "",
        done: false,
        dispatch: [{ agent: "research", focus: input.instruction }],
      });
      emit("agent", { round: 1, agent: "research", focus: input.instruction, status: "running" });
      let hits = 0;
      const refs = new Set<string>();
      const tools = RESEARCH_TOOLS.filter((t) => t.name !== "create_document");
      const res = await streamConverseToolLoop(
        {
          model: DRAFT_MODEL,
          system: draftAgentPrompt(mode),
          user: `${user}\n\nUse your tools where the request needs facts or authority the document does not contain (narrate one line before each batch, call them in parallel where independent), then write the reply.`,
          tools,
          maxTokens: 2000,
          maxSteps: cfg.maxSteps,
          synthesisUser: draftSynthesisInstruction(mode),
          synthesisMaxTokens: cfg.synthesisMaxTokens,
          callBudget: cfg.callBudget,
          deadlineMs: cfg.deadlineMs,
          cache: true,
          ...(history.length ? { history } : {}),
          ...(RESEARCH_EFFORT ? { researchEffort: RESEARCH_EFFORT } : {}),
          ...(SYNTHESIS_EFFORT ? { synthesisEffort: SYNTHESIS_EFFORT } : {}),
          // A first-turn reply with no tools is the answer when the document
          // itself carries what the request needs (a rewrite, a structural
          // section, a question about the text).
          directAnswer: { minChars: 120 },
          ...(COVERAGE_GATE_ON && cfg.gate
            ? {
                gate: {
                  check: async () => {
                    const gaps = await coverageGaps({
                      query: input.instruction,
                      sources: book.all(),
                      ...(input.signal ? { signal: input.signal } : {}),
                    });
                    if (!gaps || gaps.covered) return null;
                    if (!gaps.missing.length && !gaps.queries.length) return null;
                    emit("thinking", {
                      round: 1,
                      agent: "research",
                      text: `\nChecking coverage — following up on ${gaps.missing.slice(0, 3).join("; ") || "open gaps"}.`,
                    });
                    return requeryInstruction(gaps);
                  },
                },
              }
            : {}),
          ...(input.signal ? { signal: input.signal } : {}),
        },
        {
          onText: (text) => emit("thinking", { round: 1, agent: "research", text }),
          onReasoning: (text) => emit("reasoning", { round: 1, agent: "research", text }),
          onSynthesisStart: () => {
            emit("agent_done", {
              round: 1,
              agent: "research",
              summary: "",
              count: hits,
              citations: [...refs],
            });
            emit("sources", { sources: book.all() });
            emit("writer_start", { round: 1, sources: book.all().length });
          },
          onAnswer: (text) => {
            answerText += text;
            emit("delta", { text });
          },
          onStep: (s) =>
            agentLog("agent_step", {
              run: runId,
              step: s.step,
              ms: s.ms,
              stop: s.stopReason,
              calls: s.toolCalls.join(",") || "-",
            }),
          onToolUse: (call) =>
            emit("tool_call", {
              round: 1,
              agent: "research",
              id: call.id,
              tool: call.name,
              query: label(call.input),
            }),
          execute: async (call) => {
            const out = await executeResearchTool(call.name, call.input, book, input.attachments);
            hits += out.hits;
            out.refs.forEach((r) => refs.add(r));
            emit("tool_call", {
              round: 1,
              agent: "research",
              id: call.id,
              tool: call.name,
              query: label(call.input),
              hits: out.hits,
            });
            emit("sources", { sources: book.all() });
            return out.text;
          },
        },
      );
      if (!answerText.trim() && res.answer.trim()) {
        answerText = res.answer;
        emit("delta", { text: res.answer });
      }
    }

    const sources = book.all();
    emit("sources", { sources });
    if (!answerText.trim())
      throw new Error("The assistant produced no reply (Bedrock unavailable or throttled).");

    // Material for the document, when the mode produces some.
    const { note, material } = splitMaterial(answerText);
    if (material) {
      emit("proposal", {
        material,
        target: hasSelection ? "selection" : "cursor",
        note,
      });
    }

    // Deterministic verification of specifics against the retrieved sources.
    const checked = material ?? answerText;
    const facts = factCheck(checked, sources);
    const cites = checkCitations(checked, sources);
    emit("verification", {
      factsChecked: facts.length,
      factsVerified: facts.filter((f) => f.verified).length,
      unverified: unverified(facts)
        .map((f) => `${kindLabel(f.kind)}: ${f.value}`)
        .slice(0, 10),
      orphanRefs: cites.orphans,
    });

    emit("done", { run_id: runId, status: "complete", rounds: 1, source_count: sources.length });
    agentLog("run_done", {
      run: runId,
      engine: "draft_agent",
      mode,
      sources: sources.length,
      answer_chars: answerText.length,
      material_chars: material?.length ?? 0,
      total_ms: since(runStart),
    });

    const nextMemory = await updateMemory(
      memory,
      input.instruction,
      note || answerText,
      sources,
      input.signal,
    );
    emit("memory", { memory: nextMemory });
  } catch (err) {
    agentError("draft_run_failed", {
      run: runId,
      mode,
      total_ms: since(runStart),
      error: trunc(errorMessage(err), 240),
    });
    emit("error", { message: errorMessage(err) });
  }
}

const LABEL_KEYS = [
  "query",
  "search",
  "url",
  "case_name",
  "docket_number",
  "docket_id",
  "document_id",
  "doc_id",
  "name",
  "title",
  "endpoint",
] as const;

function label(input: Record<string, unknown>): string | undefined {
  for (const key of LABEL_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return trunc(value.trim(), 160);
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}
