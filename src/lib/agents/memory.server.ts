// ============================================================================
// Conversation memory for the research agent (server-only).
//
// Instead of shipping N truncated turns to the router on every question, the
// session carries a compact, maintained state:
//
//   summary   – a rolling narrative of the conversation so far
//   entities  – matters / MDLs / courts / judges / parties the chat locked onto
//   tail      – the last two turns, verbatim
//   sources   – refs already retrieved this session (seeded into the SourceBook)
//
// Two cheap Kimi calls hang off this: one rewrites a follow-up question into a
// standalone form before routing, one refreshes the summary + entity ledger
// after the answer streams. Neither touches the writer, its model, its budget
// or its output — memory only changes what the router and sub-agents see.
// ============================================================================
import type { Source } from "@/lib/chat-types";
import {
  BEDROCK_AGENT_MODEL,
  bedrockChat,
  bedrockEnabled,
  userText,
} from "./bedrock.server";
import { agentError, trunc } from "./log.server";
import { parseJsonBlock } from "./json-extract";
import { temporalContext } from "@/lib/system-prompt";

export type HistoryTurn = { role: "user" | "assistant"; content: string };

export type MemoryEntity = {
  /** e.g. "In re Paraquat, MDL 3004 (S.D. Ill.)" */
  label: string;
  /** matter | court | judge | party | statute | date | other */
  kind: string;
  /** 1-based turn the entity was established in; higher wins on conflict. */
  turn: number;
};

export type SessionMemory = {
  summary: string;
  entities: MemoryEntity[];
  tail: HistoryTurn[];
  sources: Source[];
  /** Number of completed question/answer turns this memory covers. */
  turns: number;
};

// --- Budgets ---------------------------------------------------------------
export const MEM_SUMMARY_CHARS = 1500;
export const MEM_MAX_ENTITIES = 20;
export const MEM_TAIL_TURNS = 2;
export const MEM_TAIL_CHARS = 4000;
export const MEM_MAX_SOURCES = 24;
export const MEM_SOURCE_CHARS = 1200;
/** Hard ceiling for everything memory contributes to a prompt. */
export const MEM_TOTAL_CHARS = 24_000;

const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** Normalizes whatever the client sent into a budgeted memory object. */
export function normalizeMemory(raw: unknown): SessionMemory {
  const m = (raw ?? {}) as Record<string, unknown>;
  const entities: MemoryEntity[] = Array.isArray(m["entities"])
    ? (m["entities"] as Record<string, unknown>[])
        .map((e) => ({
          label: trunc(s(e["label"]), 160),
          kind: s(e["kind"]) || "other",
          turn: Number(e["turn"]) || 0,
        }))
        .filter((e) => e.label)
        .slice(-MEM_MAX_ENTITIES)
    : [];

  const tail: HistoryTurn[] = Array.isArray(m["tail"])
    ? (m["tail"] as Record<string, unknown>[])
        .map((t) => ({
          role: t["role"] === "assistant" ? ("assistant" as const) : ("user" as const),
          content: trunc(s(t["content"]), MEM_TAIL_CHARS),
        }))
        .filter((t) => t.content)
        .slice(-MEM_TAIL_TURNS * 2)
    : [];

  const sources: Source[] = Array.isArray(m["sources"])
    ? (m["sources"] as Source[])
        .filter((x) => x && typeof x === "object" && s((x as Source).citation))
        .slice(-MEM_MAX_SOURCES)
        .map((x) => ({ ...x, content: trunc(s(x.content), MEM_SOURCE_CHARS) }))
    : [];

  return {
    summary: trunc(s(m["summary"]), MEM_SUMMARY_CHARS),
    entities,
    tail,
    sources,
    turns: Number(m["turns"]) || 0,
  };
}

export function emptyMemory(): SessionMemory {
  return { summary: "", entities: [], tail: [], sources: [], turns: 0 };
}

export function hasContext(mem: SessionMemory): boolean {
  return Boolean(mem.summary || mem.entities.length || mem.tail.length);
}

/** The block handed to the router and sub-agents in place of raw history. */
export function memoryBlock(mem: SessionMemory): string {
  if (!hasContext(mem) && !mem.sources.length) return "";
  const parts: string[] = [];
  if (mem.summary) parts.push(`CONVERSATION SO FAR\n${mem.summary}`);
  if (mem.entities.length) {
    parts.push(
      `ESTABLISHED FACTS IN THIS SESSION (most recent last)\n${mem.entities
        .map((e) => `- ${e.kind}: ${e.label}`)
        .join("\n")}`,
    );
  }
  if (mem.sources.length) {
    parts.push(
      `SOURCES ALREADY RETRIEVED THIS SESSION — reuse them, do not search for what they already answer\n${mem.sources
        .map((x) => `[${x.ref}] ${x.citation}`)
        .join("\n")}`,
    );
  }
  const block = parts.join("\n\n");
  return block.length > MEM_TOTAL_CHARS ? `${block.slice(0, MEM_TOTAL_CHARS)}…` : block;
}

/** Verbatim recent turns, as chat messages for the model. */
export function tailMessages(mem: SessionMemory): HistoryTurn[] {
  return mem.tail.slice(-MEM_TAIL_TURNS * 2);
}

// --- Question decontextualization -----------------------------------------

export type Resolved = {
  /** Standalone rewrite of the question, used for routing and retrieval. */
  query: string;
  /** True when the question starts a new subject; carried state is dropped. */
  topicShift: boolean;
};

const RESOLVE_SYSTEM = `You rewrite a lawyer's follow-up question into a standalone research query.

Rules:
- Replace pronouns and references ("there", "that MDL", "the judge") with the concrete entity from the session facts.
- Keep the lawyer's intent, scope and specificity exactly. Never add analysis, never narrow or widen the ask, never answer it.
- If the question is already standalone, return it unchanged.
- Set topic_shift to true only when the new question is about a different matter/subject than the session facts, in which case return the question as-is.
- Reply with JSON only: {"query": "...", "topic_shift": false}`;

export async function resolveQuestion(
  question: string,
  mem: SessionMemory,
  signal?: AbortSignal,
): Promise<Resolved> {
  const fallback: Resolved = { query: question, topicShift: false };
  if (!hasContext(mem) || !bedrockEnabled()) return fallback;

  const facts = mem.entities.length
    ? mem.entities.map((e) => `- ${e.kind}: ${e.label}`).join("\n")
    : "(none recorded)";
  const user = [
    `SESSION FACTS\n${facts}`,
    mem.summary ? `CONVERSATION SO FAR\n${mem.summary}` : "",
    `NEW QUESTION\n${question}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    const res = await bedrockChat({
      model: BEDROCK_AGENT_MODEL,
      system: `${temporalContext()}\n\n${RESOLVE_SYSTEM}`,
      messages: [userText(user)],
      maxTokens: 220,
      temperature: 0,
      ...(signal ? { signal } : {}),
    });
    const parsed =
      (parseJsonBlock(res.text, "query") as Record<string, unknown> | null) ?? null;
    if (!parsed) return fallback;
    const rewritten = trunc(s(parsed["query"]), 600);
    // Only honor a topic shift when there WAS an established ledger to shift away
    // from. With no entities and no summary the model has nothing to judge
    // against and tends to false-positive topic_shift on a pronoun follow-up
    // ("developments there") — and a false positive wipes the conversation
    // context. When the ledger is empty, keep context (topicShift = false).
    const hasLedger = mem.entities.length > 0 || Boolean(mem.summary);
    return {
      query: rewritten || question,
      topicShift: hasLedger ? Boolean(parsed["topic_shift"]) : false,
    };
  } catch (err) {
    agentError("memory_resolve_failed", { error: trunc(String(err), 160) });
    return fallback;
  }
}

// --- Memory refresh (after the answer) -------------------------------------

const UPDATE_SYSTEM = `You maintain the working memory of a litigation research conversation.

Call the save_memory tool with the updated summary and entity ledger (kind is one of: matter, court, judge, party, statute, date, other).

Rules:
- summary: a compact running narrative of what the lawyer has asked and what has been established. Third person, no preamble, under 1200 characters. Fold the previous summary in; do not restart it.
- entities: the concrete anchors the conversation is about (matters, MDL numbers, courts, judges, parties, key dates). Full, unambiguous labels. Maximum 15. Drop anything no longer relevant.
- Record only what is supported by the exchange. Never invent docket numbers or dates.`;

/** Forced-tool schema so the model returns validated JSON, not fragile text. */
const MEMORY_TOOL = {
  name: "save_memory",
  description: "Save the running conversation memory (rolling summary + entity ledger).",
  input_schema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "Compact running third-person narrative of the conversation, under 1200 characters.",
      },
      entities: {
        type: "array",
        items: {
          type: "object",
          properties: { label: { type: "string" }, kind: { type: "string" } },
          required: ["label"],
        },
      },
    },
    required: ["summary"],
  },
};

export async function updateMemory(
  mem: SessionMemory,
  question: string,
  answer: string,
  sources: Source[],
  signal?: AbortSignal,
): Promise<SessionMemory> {
  const nextTurn = mem.turns + 1;
  const tail: HistoryTurn[] = (
    [
      ...mem.tail,
      { role: "user", content: trunc(question, MEM_TAIL_CHARS) },
      { role: "assistant", content: trunc(answer, MEM_TAIL_CHARS) },
    ] as HistoryTurn[]
  ).slice(-MEM_TAIL_TURNS * 2);


  const mergedSources = mergeSources(mem.sources, sources);

  if (!bedrockEnabled()) {
    return { ...mem, tail, sources: mergedSources, turns: nextTurn };
  }

  const user = [
    mem.summary ? `PREVIOUS SUMMARY\n${mem.summary}` : "PREVIOUS SUMMARY\n(none)",
    mem.entities.length
      ? `PREVIOUS ENTITIES\n${mem.entities.map((e) => `- ${e.kind}: ${e.label}`).join("\n")}`
      : "PREVIOUS ENTITIES\n(none)",
    `LATEST QUESTION\n${trunc(question, 1200)}`,
    `LATEST ANSWER (excerpt)\n${trunc(answer, 6000)}`,
  ].join("\n\n");

  try {
    const res = await bedrockChat({
      model: BEDROCK_AGENT_MODEL,
      system: `${temporalContext()}\n\n${UPDATE_SYSTEM}`,
      messages: [userText(user)],
      tools: [MEMORY_TOOL],
      toolChoice: { name: "save_memory" },
      maxTokens: 1500,
      temperature: 0,
      ...(signal ? { signal } : {}),
    });
    // Forced tool call: the tool input is already-validated JSON, so a rich legal
    // summary (quotes, $ figures, newlines) can no longer break fragile text-JSON
    // parsing — which was missing on essentially every turn and left the rolling
    // summary + entity ledger perpetually empty.
    const parsed = (res.toolCalls[0]?.input as Record<string, unknown> | undefined) ?? null;
    if (!parsed) {
      agentError("memory_update_no_tool", { chars: res.text.length });
      return { ...mem, tail, sources: mergedSources, turns: nextTurn };
    }

    const rawEntities = Array.isArray(parsed["entities"])
      ? (parsed["entities"] as Record<string, unknown>[])
      : [];
    const entities: MemoryEntity[] = [];
    const seen = new Set<string>();
    for (const e of rawEntities) {
      const label = trunc(s(e["label"]), 160);
      if (!label) continue;
      const key = label.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      entities.push({ label, kind: s(e["kind"]) || "other", turn: nextTurn });
      if (entities.length >= MEM_MAX_ENTITIES) break;
    }

    return {
      summary: trunc(s(parsed["summary"]) || mem.summary, MEM_SUMMARY_CHARS),
      entities: entities.length ? entities : mem.entities,
      tail,
      sources: mergedSources,
      turns: nextTurn,
    };
  } catch (err) {
    agentError("memory_update_failed", { error: trunc(String(err), 160) });
    return { ...mem, tail, sources: mergedSources, turns: nextTurn };
  }
}

/** Keeps the most recent sources, deduped on ref, within budget. */
function mergeSources(prev: Source[], next: Source[]): Source[] {
  const byRef = new Map<string, Source>();
  for (const src of [...prev, ...next]) {
    if (!src?.ref) continue;
    byRef.set(src.ref, { ...src, content: trunc(s(src.content), MEM_SOURCE_CHARS) });
  }
  return [...byRef.values()].slice(-MEM_MAX_SOURCES);
}
