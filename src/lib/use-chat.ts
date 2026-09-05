import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  streamOrchestrate,
  fetchFollowups,
  type SSEEvent,
} from "@/lib/orchestrate";
import type { Artifact, Attachment, MatterScope, Message, Round, Source } from "@/lib/chat-types";
import {
  loadConversation,
  saveFollowups,
  saveTurn,
  keepConversation,
} from "@/lib/chat/history";

type Action =
  | { type: "user"; id: string; text: string }
  | { type: "assistant_start"; id: string }
  | { type: "sse"; id: string; evt: SSEEvent }
  | { type: "delta_flush"; id: string; text: string }
  | { type: "thinking"; id: string; text: string }
  | { type: "reasoning"; id: string; text: string }
  | { type: "followups"; id: string; followups: string[] }
  | { type: "hydrate"; messages: Message[] }
  | { type: "reset" };

function emptyAssistant(id: string): Message {
  return {
    id,
    role: "assistant",
    text: "",
    rounds: [],
    sources: [],
    answer: "",
    status: "thinking",
  };
}

function reduce(state: Message[], a: Action): Message[] {
  switch (a.type) {
    case "user":
      return [
        ...state,
        {
          id: a.id,
          role: "user",
          text: a.text,
          rounds: [],
          sources: [],
          answer: "",
          status: "done",
        },
      ];
    case "assistant_start":
      return [...state, emptyAssistant(a.id)];
    case "delta_flush":
      return state.map((m) =>
        m.id === a.id && m.role === "assistant"
          ? { ...m, answer: m.answer + a.text }
          : m,
      );
    case "thinking":
      return state.map((m) =>
        m.id === a.id && m.role === "assistant"
          ? { ...m, thinking: (m.thinking ?? "") + a.text }
          : m,
      );
    case "reasoning":
      return state.map((m) =>
        m.id === a.id && m.role === "assistant"
          ? { ...m, reasoning: (m.reasoning ?? "") + a.text }
          : m,
      );
    case "sse":
      return state.map((m) =>
        m.id === a.id && m.role === "assistant" ? applyEvent(m, a.evt) : m,
      );
    case "hydrate":
      return a.messages;
    case "followups":
      return state.map((m) =>
        m.id === a.id && m.role === "assistant"
          ? { ...m, followups: a.followups }
          : m,
      );
    case "reset":
      return [];
    default:
      return state;
  }
}

function applyEvent(m: Message, e: SSEEvent): Message {
  const d = (e.data ?? {}) as Record<string, unknown>;
  switch (e.event) {
    case "run":
      return m;
    case "mode":
      return { ...m, mode: d.mode ? String(d.mode) : m.mode, modeReason: d.reason ? String(d.reason) : m.modeReason };
    case "round": {
      const round: Round = {
        round: Number(d.round) || m.rounds.length + 1,
        phase: d.phase ? String(d.phase) : undefined,
        reasoning: String(d.reasoning ?? ""),
        scratch_note: d.scratch_note as string | undefined,
        done: Boolean(d.done),
        dispatch:
          (d.dispatch as { agent: string; focus: string }[] | undefined) ?? [],
        agents: {},
      };
      for (const dp of round.dispatch) {
        round.agents[dp.agent] = {
          agent: dp.agent,
          focus: dp.focus,
          status: "running",
          tools: [],
        };
      }
      const existing = m.rounds.find((r) => r.round === round.round);
      const rounds = existing
        ? m.rounds.map((r) =>
            r.round === round.round
              ? { ...r, ...round, agents: { ...r.agents, ...round.agents } }
              : r,
          )
        : [...m.rounds, round];
      return { ...m, rounds };
    }
    case "agent": {
      const rn = Number(d.round);
      const agent = String(d.agent);
      return mapRound(m, rn, (r) => ({
        ...r,
        agents: {
          ...r.agents,
          [agent]: r.agents[agent] ?? {
            agent,
            focus: String(d.focus ?? ""),
            status: "running",
            tools: [],
          },
        },
      }));
    }
    case "tool_call": {
      const rn = Number(d.round);
      const agent = String(d.agent);
      const id = d.id as string | undefined;
      const tc = {
        id,
        tool: String(d.tool ?? ""),
        query: d.query as string | undefined,
        scope: d.scope as string | undefined,
        hits: d.hits as number | undefined,
      };
      return mapRound(m, rn, (r) => {
        const ex = r.agents[agent] ?? {
          agent,
          focus: "",
          status: "running" as const,
          tools: [],
        };
        // Upsert by tool-use id: a call emits once when it STARTS (no hits) and
        // again when it COMPLETES (with hits). Merge into one row so the timeline
        // shows a live "searching…" state that fills in its result, not two rows.
        const i = id ? ex.tools.findIndex((t) => t.id === id) : -1;
        const tools =
          i >= 0
            ? ex.tools.map((t, j) => (j === i ? { ...t, ...tc } : t))
            : [...ex.tools, tc];
        return {
          ...r,
          agents: { ...r.agents, [agent]: { ...ex, tools } },
        };
      });
    }
    case "agent_done": {
      const rn = Number(d.round);
      const agent = String(d.agent);
      return mapRound(m, rn, (r) => {
        const ex = r.agents[agent];
        if (!ex) return r;
        return {
          ...r,
          agents: {
            ...r.agents,
            [agent]: {
              ...ex,
              status: "done",
              summary: d.summary as string | undefined,
              count: d.count as number | undefined,
              citations: d.citations as string[] | undefined,
            },
          },
        };
      });
    }
    case "sources": {
      const sources = (d.sources as Source[] | undefined) ?? [];
      return { ...m, sources };
    }
    case "writer_start":
      return {
        ...m,
        status: "writing",
        collapseTimeline: true,
        deliverable: d.deliverable ? String(d.deliverable) : m.deliverable,
      };
    case "delta":
      // Streaming text is batched outside the reducer via RAF;
      // see useChat.send. We still tolerate raw deltas here.
      return { ...m, answer: m.answer + ((d.text as string) ?? "") };
    case "verification":
      return {
        ...m,
        verification: {
          factsChecked: Number(d.factsChecked) || 0,
          factsVerified: Number(d.factsVerified) || 0,
          unverified: (d.unverified as string[] | undefined) ?? [],
          orphanRefs: (d.orphanRefs as string[] | undefined) ?? [],
          ...(d.faithfulness && typeof d.faithfulness === "object"
            ? { faithfulness: d.faithfulness as NonNullable<Message["verification"]>["faithfulness"] }
            : {}),
        },
      };
    case "artifact": {
      const incoming = (d.artifacts as Artifact[] | undefined) ?? [];
      if (!incoming.length) return m;
      // Upsert by id so a re-emitted artifact replaces rather than duplicates.
      const byId = new Map((m.artifacts ?? []).map((x) => [x.id, x]));
      for (const a of incoming) byId.set(a.id, a);
      return { ...m, artifacts: [...byId.values()] };
    }
    case "done":
      return { ...m, status: "done", collapseTimeline: true };
    case "error":
      return {
        ...m,
        status: "error",
        error: (d.message as string) ?? "Something went wrong.",
      };
    default:
      return m;
  }
}

function mapRound(m: Message, n: number, fn: (r: Round) => Round): Message {
  return { ...m, rounds: m.rounds.map((r) => (r.round === n ? fn(r) : r)) };
}

export function useChat(sessionId: string) {
  const [messages, dispatch] = useReducer(reduce, [] as Message[]);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  // Maintained conversation memory (rolling summary, entity ledger, verbatim
  // tail, retrieved sources). The server refreshes it after each answer and
  // sends it back on the `memory` event; we simply carry it forward.
  const memoryRef = useRef<unknown>(null);
  // Conversation the turns are being saved to (created lazily on first turn).
  const conversationRef = useRef<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const messagesRef = useRef<Message[]>(messages);
  messagesRef.current = messages;

  const send = useCallback(
    async (
      text: string,
      matter?: MatterScope | null,
      opts?: { mode?: "auto" | "fast" | "think"; attachments?: Attachment[] },
    ) => {
      if (busy || !text.trim()) return;
      const uid = crypto.randomUUID();
      const aid = crypto.randomUUID();
      dispatch({ type: "user", id: uid, text });
      dispatch({ type: "assistant_start", id: aid });
      setBusy(true);
      const ac = new AbortController();
      abortRef.current = ac;

      // RAF-batched delta buffer so we don't re-render per token.
      let buf = "";
      let fullAnswer = "";
      let scheduled = false;
      const flush = () => {
        scheduled = false;
        if (!buf) return;
        const t = buf;
        buf = "";
        dispatch({ type: "delta_flush", id: aid, text: t });
      };
      const schedule = () => {
        if (scheduled) return;
        scheduled = true;
        if (typeof requestAnimationFrame !== "undefined") {
          requestAnimationFrame(flush);
        } else {
          setTimeout(flush, 40);
        }
      };

      // Same RAF batching for the streamed research narration ("thinking").
      let thinkBuf = "";
      let thinkScheduled = false;
      const flushThink = () => {
        thinkScheduled = false;
        if (!thinkBuf) return;
        const t = thinkBuf;
        thinkBuf = "";
        dispatch({ type: "thinking", id: aid, text: t });
      };
      const scheduleThink = () => {
        if (thinkScheduled) return;
        thinkScheduled = true;
        if (typeof requestAnimationFrame !== "undefined") {
          requestAnimationFrame(flushThink);
        } else {
          setTimeout(flushThink, 40);
        }
      };

      // Same RAF batching for the model's live reasoning stream.
      let reasonBuf = "";
      let reasonScheduled = false;
      const flushReason = () => {
        reasonScheduled = false;
        if (!reasonBuf) return;
        const t = reasonBuf;
        reasonBuf = "";
        dispatch({ type: "reasoning", id: aid, text: t });
      };
      const scheduleReason = () => {
        if (reasonScheduled) return;
        reasonScheduled = true;
        if (typeof requestAnimationFrame !== "undefined") {
          requestAnimationFrame(flushReason);
        } else {
          setTimeout(flushReason, 40);
        }
      };

      try {
        // First turn (or a memory the server has not built yet): fall back to
        // the last couple of turns verbatim so context is never empty.
        const fallbackTail: { role: "user" | "assistant"; content: string }[] = [];
        for (const m of messages) {
          if (m.role === "user" && m.text.trim()) {
            fallbackTail.push({ role: "user", content: m.text.slice(0, 4000) });
          } else if (m.role === "assistant" && m.answer.trim()) {
            fallbackTail.push({ role: "assistant", content: m.answer.slice(0, 4000) });
          }
        }
        // Sources already retrieved this session keep their [S#] refs, so
        // follow-ups reuse them instead of re-running the same searches.
        const carriedSources = Array.from(
          new Map(
            messages.flatMap((m) => (m.sources ?? []).map((s) => [s.ref, s] as const)),
          ).values(),
        ).slice(-24);
        const memory =
          (memoryRef.current as Record<string, unknown> | null) ?? null;
        const outboundMemory = memory
          ? { ...memory, sources: carriedSources }
          : fallbackTail.length || carriedSources.length
            ? { tail: fallbackTail.slice(-4), sources: carriedSources }
            : null;
        await streamOrchestrate(
          {
            query: text,
            session_id: sessionId,
            stream: true,
            ...(outboundMemory ? { memory: outboundMemory } : {}),
            ...(matter
              ? { matter_id: matter.matterId, matter_label: matter.label }
              : {}),
            ...(opts?.mode && opts.mode !== "auto" ? { mode: opts.mode } : {}),
            ...(() => {
              // Only send fully-ingested attachments; processing/errored ones are skipped.
              const ready = (opts?.attachments ?? []).filter(
                (a) => a.status !== "processing" && a.status !== "error",
              );
              return ready.length ? { attachments: ready } : {};
            })(),
          },
          (evt) => {
            if (evt.event === "delta") {
              const d = (evt.data ?? {}) as { text?: string };
              if (d.text) {
                buf += d.text;
                fullAnswer += d.text;
                schedule();
              }
              return;
            }
            if (evt.event === "thinking") {
              const d = (evt.data ?? {}) as { text?: string };
              if (d.text) {
                thinkBuf += d.text;
                scheduleThink();
              }
              return;
            }
            if (evt.event === "reasoning") {
              const d = (evt.data ?? {}) as { text?: string };
              if (d.text) {
                reasonBuf += d.text;
                scheduleReason();
              }
              return;
            }
            if (evt.event === "memory") {
              const d = (evt.data ?? {}) as { memory?: unknown };
              if (d.memory) memoryRef.current = d.memory;
              return;
            }
            // For non-delta events, ensure any pending text is flushed first
            // so ordering with writer_start / done is preserved.
            if (buf) flush();
            if (thinkBuf) flushThink();
            if (reasonBuf) flushReason();
            dispatch({ type: "sse", id: aid, evt });
          },
          ac.signal,
        );
        if (buf) flush();
        if (thinkBuf) flushThink();
        if (reasonBuf) flushReason();

        // Persist the completed turn (best-effort; never blocks the UI).
        const finished = messagesRef.current;
        const answerMsg =
          finished.find((m) => m.id === aid) ??
          ({ ...emptyAssistant(aid), answer: fullAnswer, status: "done" } as Message);
        const turnIndex = Math.max(
          0,
          finished.filter((m) => m.role === "user").length - 1,
        );
        const savedId = await saveTurn({
          conversationId: conversationRef.current,
          question: {
            id: uid,
            role: "user",
            text,
            rounds: [],
            sources: [],
            answer: "",
            status: "done",
          },
          answer: { ...answerMsg, answer: fullAnswer || answerMsg.answer },
          memory: memoryRef.current,
          matter: matter ?? null,
          turnIndex,
        });
        if (savedId && savedId !== conversationRef.current) {
          conversationRef.current = savedId;
          setConversationId(savedId);
        }

        if (fullAnswer.trim()) {
          fetchFollowups(text, fullAnswer).then((followups) => {
            if (followups.length) {
              dispatch({ type: "followups", id: aid, followups });
              void saveFollowups(conversationRef.current, aid, followups);
            }
          });
        }
      } catch (err) {
        if (buf) flush();
        dispatch({
          type: "sse",
          id: aid,
          evt: {
            event: "error",
            data: { message: (err as Error).message ?? "Network error" },
          },
        });
      } finally {
        setBusy(false);
      }
    },
    [busy, sessionId, messages],
  );


  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    memoryRef.current = null;
    conversationRef.current = null;
    setConversationId(null);
    dispatch({ type: "reset" });
    setBusy(false);
  }, []);

  /** Reopens a saved conversation with its messages, memory, and sources. */
  const open = useCallback(async (id: string) => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
    const loaded = await loadConversation(id);
    if (!loaded) return null;
    conversationRef.current = loaded.id;
    setConversationId(loaded.id);
    memoryRef.current = loaded.memory ?? null;
    dispatch({ type: "hydrate", messages: loaded.messages });
    return loaded;
  }, []);

  /** Persist the current conversation past the 3-day default (clears its TTL). */
  const keep = useCallback(async (folderId?: string) => {
    const id = conversationRef.current;
    if (!id) return false;
    await keepConversation(id, folderId);
    return true;
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  return { messages, send, busy, reset, open, keep, conversationId };
}
