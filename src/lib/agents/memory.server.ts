// ============================================================================
// Conversation memory for the research agent (server-only).
//
// Instead of shipping N truncated turns to the router on every question, the
// session carries a compact, maintained state:
//
//   summary      – a rolling narrative of the conversation so far
//   entities     – matters / MDLs / courts / judges / parties the chat locked onto
//   threads      – open asks the lawyer raised that are not yet answered
//   preferences  – standing instructions given in this chat (format, scope, style)
//   tail         – the most recent turns, verbatim, under a character budget
//   sources      – refs already retrieved this session (seeded into the SourceBook)
//
// Two cheap Haiku calls hang off this: one rewrites a follow-up question into a
// standalone form before routing (skipped deterministically when the question
// already names its subject — see memory-budget.needsResolution), one refreshes
// the summary + ledgers after the answer streams. Neither touches the writer,
// its model, its budget or its output — memory only changes what the router
// and sub-agents see.
// ============================================================================
import type { Source } from "@/lib/chat-types";
import { BEDROCK_AGENT_MODEL, bedrockChat, bedrockEnabled, userText } from "./bedrock.server";
import { agentError, agentLog, trunc } from "./log.server";
import { parseJsonBlock } from "./json-extract";
import { anchorsCovered, fitTail, groundedInUserTurns, needsResolution, TAIL_RECENT_CHARS } from "./memory-budget";
import { decideTopicShift, topicShiftQuestions, topicShiftState } from "./typesafe-questions";
import { systemOne, typesafeConfigured } from "./typesafe.server";

/** RESEARCH_TOPIC_SHIFT=typesafe routes the standalone-question topic check to Jev. */
function topicShiftViaTypeSafe(): boolean {
  return (process.env["RESEARCH_TOPIC_SHIFT"] ?? "").trim().toLowerCase() === "typesafe" && typesafeConfigured();
}
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
  /** Open asks the lawyer raised that the conversation has not resolved yet. */
  threads: string[];
  /** Standing instructions given in this chat ("always cite Bluebook", "NJ only"). */
  preferences: string[];
  tail: HistoryTurn[];
  sources: Source[];
  /** Number of completed question/answer turns this memory covers. */
  turns: number;
};

// --- Budgets ---------------------------------------------------------------
export const MEM_SUMMARY_CHARS = 1500;
export const MEM_MAX_ENTITIES = 20;
export const MEM_MAX_THREADS = 5;
export const MEM_THREAD_CHARS = 200;
export const MEM_MAX_PREFERENCES = 6;
export const MEM_PREFERENCE_CHARS = 140;
/** Per-message cap for the verbatim tail; the whole tail is budgeted by fitTail. */
export const MEM_TAIL_CHARS = TAIL_RECENT_CHARS;
export const MEM_MAX_SOURCES = 24;
export const MEM_SOURCE_CHARS = 1200;
/** Hard ceiling for everything memory contributes to a prompt. */
export const MEM_TOTAL_CHARS = 24_000;

const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");

function stringList(raw: unknown, max: number, chars: number): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    const text = trunc(s(v), chars);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

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
    ? fitTail(
        (m["tail"] as Record<string, unknown>[]).map((t) => ({
          role: t["role"] === "assistant" ? ("assistant" as const) : ("user" as const),
          content: s(t["content"]),
        })),
      )
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
    threads: stringList(m["threads"], MEM_MAX_THREADS, MEM_THREAD_CHARS),
    preferences: stringList(m["preferences"], MEM_MAX_PREFERENCES, MEM_PREFERENCE_CHARS),
    tail,
    sources,
    turns: Number(m["turns"]) || 0,
  };
}

export function emptyMemory(): SessionMemory {
  return {
    summary: "",
    entities: [],
    threads: [],
    preferences: [],
    tail: [],
    sources: [],
    turns: 0,
  };
}

export function hasContext(mem: SessionMemory): boolean {
  return Boolean(
    mem.summary ||
    mem.entities.length ||
    mem.tail.length ||
    mem.threads.length ||
    mem.preferences.length,
  );
}

/** The block handed to the router and sub-agents in place of raw history. */
export function memoryBlock(mem: SessionMemory): string {
  if (!hasContext(mem) && !mem.sources.length) return "";
  const parts: string[] = [];
  if (mem.preferences.length) {
    parts.push(
      `STANDING INSTRUCTIONS FROM THE ATTORNEY (apply to every answer in this chat)\n${mem.preferences
        .map((p) => `- ${p}`)
        .join("\n")}`,
    );
  }
  if (mem.summary) parts.push(`CONVERSATION SO FAR\n${mem.summary}`);
  if (mem.entities.length) {
    parts.push(
      `ESTABLISHED FACTS IN THIS SESSION (most recent last)\n${mem.entities
        .map((e) => `- ${e.kind}: ${e.label}`)
        .join("\n")}`,
    );
  }
  if (mem.threads.length) {
    parts.push(
      `OPEN THREADS (asked earlier, not yet resolved — address only if this question is about them)\n${mem.threads
        .map((t) => `- ${t}`)
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

/** Verbatim recent turns, as chat messages for the model (budget-fitted). */
export function tailMessages(mem: SessionMemory): HistoryTurn[] {
  return fitTail(mem.tail);
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
  // A question that already names its subject (a matter, an MDL number, a
  // judge) needs no rewrite. The model call is skipped only when every anchor
  // it names is already in the session (ledger or summary): that continues
  // the current topic, so keeping the ledger (topicShift=false) is right and a
  // full Bedrock round trip leaves the critical path. A standalone question
  // about a subject the session has NOT seen still goes to the model, whose
  // topic_shift verdict is the only thing that clears stale sources/facts.
  if (!needsResolution(question)) {
    const known = [...mem.entities.map((e) => e.label), mem.summary ?? ""];
    if (anchorsCovered(question, known)) return fallback;
    // Standalone question naming an anchor the session has not seen: the only
    // open judgment is topic_shift, a yes/no — a typed-decision model answers
    // it in ~150 ms with a calibrated probability, where the Haiku rewrite
    // costs a full generative round trip. RESEARCH_TOPIC_SHIFT=typesafe; an
    // uncertain or unavailable answer falls through to the model rewrite.
    if (topicShiftViaTypeSafe()) {
      const res = await systemOne({
        purpose: "topic_shift",
        state: topicShiftState(question, mem.entities.map((e) => e.label), mem.summary ?? ""),
        questions: topicShiftQuestions(),
        ...(signal ? { signal } : {}),
      });
      const shift = decideTopicShift(res);
      if (shift !== null) {
        agentLog("memory_topic_shift", { via: "typesafe", shift, ms: res?.ms ?? 0 });
        return { query: question, topicShift: shift };
      }
    }
  }

  const facts = mem.entities.length
    ? mem.entities.map((e) => `- ${e.kind}: ${e.label}`).join("\n")
    : "(none recorded)";
  const user = [
    `SESSION FACTS\n${facts}`,
    mem.summary ? `CONVERSATION SO FAR\n${mem.summary}` : "",
    mem.threads.length ? `OPEN THREADS\n${mem.threads.map((t) => `- ${t}`).join("\n")}` : "",
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
    const parsed = (parseJsonBlock(res.text, "query") as Record<string, unknown> | null) ?? null;
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

Call the save_memory tool with the updated summary, entity ledger (kind is one of: matter, court, judge, party, statute, date, other), open threads, and standing preferences.

Rules:
- summary: a compact running narrative of what the lawyer has asked and what has been established. Third person, no preamble, under 1200 characters. Fold the previous summary in; do not restart it. Prefer established facts (holdings, dates, postures, figures) over a play-by-play of the questions.
- entities: the concrete anchors the conversation is about (matters, MDL numbers, courts, judges, parties, key dates). Full, unambiguous labels. Maximum 15. Keep every anchor that is still in play; drop only what the conversation has clearly moved past.
- open_threads: asks the lawyer raised that the answers have NOT yet resolved (a deferred sub-question, "come back to X", a document they said they would want). Maximum 5, one line each, phrased as the ask. Remove a thread once it is answered. Empty is the normal case.
- preferences: standing instructions the lawyer gave that should apply to LATER answers in this chat ("always give Bluebook cites", "New Jersey only", "keep answers under a page", "call the defendant 'the Company'"). Maximum 6, imperative, one line each. Carry the previous list forward unless the lawyer changed or withdrew one. Only explicit instructions — never infer a preference from a single question's phrasing.
- Record only what is supported by the exchange. Never invent docket numbers or dates.`;

/** Forced-tool schema so the model returns validated JSON, not fragile text. */
const MEMORY_TOOL = {
  name: "save_memory",
  description:
    "Save the running conversation memory (rolling summary, entity ledger, open threads, standing preferences).",
  input_schema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description:
          "Compact running third-person narrative of the conversation, under 1200 characters.",
      },
      entities: {
        type: "array",
        items: {
          type: "object",
          properties: { label: { type: "string" }, kind: { type: "string" } },
          required: ["label"],
        },
      },
      open_threads: {
        type: "array",
        items: { type: "string" },
        description:
          "Unresolved asks the lawyer raised, one line each, max 5. Empty when nothing is pending.",
      },
      preferences: {
        type: "array",
        items: { type: "string" },
        description:
          "Explicit standing instructions for later answers in this chat, imperative, one line each, max 6.",
      },
    },
    required: ["summary"],
  },
};

/**
 * Merge a refreshed entity list over the previous ledger so `turn` keeps the
 * turn an anchor was FIRST established (recency semantics survive the refresh),
 * new anchors take the current turn, and duplicates collapse case-insensitively.
 */
function mergeEntities(
  previous: MemoryEntity[],
  refreshed: Record<string, unknown>[],
  turn: number,
): MemoryEntity[] {
  const firstSeen = new Map<string, number>();
  for (const e of previous) {
    const key = e.label.toLowerCase();
    if (!firstSeen.has(key)) firstSeen.set(key, e.turn || turn);
  }
  const out: MemoryEntity[] = [];
  const seen = new Set<string>();
  for (const e of refreshed) {
    const label = trunc(s(e["label"]), 160);
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label, kind: s(e["kind"]) || "other", turn: firstSeen.get(key) ?? turn });
    if (out.length >= MEM_MAX_ENTITIES) break;
  }
  // Most recently established last, matching the "(most recent last)" header.
  return out.sort((a, b) => a.turn - b.turn);
}

export async function updateMemory(
  mem: SessionMemory,
  question: string,
  answer: string,
  sources: Source[],
  signal?: AbortSignal,
): Promise<SessionMemory> {
  const nextTurn = mem.turns + 1;
  const tail: HistoryTurn[] = fitTail([
    ...mem.tail,
    { role: "user", content: question },
    { role: "assistant", content: answer },
  ]);

  const mergedSources = mergeSources(mem.sources, sources);

  if (!bedrockEnabled()) {
    return { ...mem, tail, sources: mergedSources, turns: nextTurn };
  }

  const user = [
    mem.summary ? `PREVIOUS SUMMARY\n${mem.summary}` : "PREVIOUS SUMMARY\n(none)",
    mem.entities.length
      ? `PREVIOUS ENTITIES\n${mem.entities.map((e) => `- ${e.kind}: ${e.label}`).join("\n")}`
      : "PREVIOUS ENTITIES\n(none)",
    mem.threads.length
      ? `PREVIOUS OPEN THREADS\n${mem.threads.map((t) => `- ${t}`).join("\n")}`
      : "PREVIOUS OPEN THREADS\n(none)",
    mem.preferences.length
      ? `PREVIOUS PREFERENCES\n${mem.preferences.map((p) => `- ${p}`).join("\n")}`
      : "PREVIOUS PREFERENCES\n(none)",
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
    const entities = mergeEntities(mem.entities, rawEntities, nextTurn);
    // Threads and preferences are authoritative from the refresh (the prompt
    // carries the previous lists forward and removes resolved/withdrawn ones);
    // a missing field means "unchanged", an explicit empty array means "none".
    const threads = Array.isArray(parsed["open_threads"])
      ? stringList(parsed["open_threads"], MEM_MAX_THREADS, MEM_THREAD_CHARS)
      : mem.threads;
    // A preference is rendered later as a standing instruction from the
    // attorney, so a NEW one must be grounded in words the user actually typed
    // (this tail's user turns); an instruction-shaped sentence that only occurs
    // in retrieved/answer text is dropped. Previously recorded ones carry over.
    const userTurns = tail.filter((t) => t.role === "user").map((t) => t.content);
    const known = new Set(mem.preferences.map((p) => p.toLowerCase()));
    const preferences = Array.isArray(parsed["preferences"])
      ? stringList(parsed["preferences"], MEM_MAX_PREFERENCES, MEM_PREFERENCE_CHARS).filter(
          (p) => known.has(p.toLowerCase()) || groundedInUserTurns(p, userTurns),
        )
      : mem.preferences;

    return {
      summary: trunc(s(parsed["summary"]) || mem.summary, MEM_SUMMARY_CHARS),
      entities: entities.length ? entities : mem.entities,
      threads,
      preferences,
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
