import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import type { DraftMode } from "@/lib/agents/draft-prompts";
import type { Message } from "@/lib/chat-types";
import { loadConversation, saveTurn } from "@/lib/chat/history";
import { createConversationFn } from "@/lib/chat/chat.functions";
import { streamSSE } from "@/lib/orchestrate";
import { emptyAssistant, makeStreamChannel, reduceChatMessages } from "@/lib/use-chat";

import { updateDraftMetaFn } from "./drafts.functions";

export type DraftDocumentSnapshot = {
  title: string;
  text: string;
  selection?: string;
  before?: string;
  after?: string;
  style?: string;
};

/**
 * Chat state for one draft's assistant. Streams /api/draft with the document
 * context, keeps the rolling memory, and persists turns to a conversation
 * linked to the draft so reopening the document restores the thread.
 */
export function useDraftChat(args: { draftId: string; draftTitle: string; convId?: string }) {
  const [messages, dispatch] = useReducer(reduceChatMessages, [] as Message[]);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const memoryRef = useRef<unknown>(null);
  const convRef = useRef<string | null>(args.convId ?? null);
  const messagesRef = useRef<Message[]>(messages);
  messagesRef.current = messages;

  // Restore the linked conversation once per draft.
  useEffect(() => {
    let cancelled = false;
    convRef.current = args.convId ?? null;
    dispatch({ type: "reset" });
    setReady(false);
    if (!args.convId) {
      setReady(true);
      return;
    }
    void loadConversation(args.convId).then((loaded) => {
      if (cancelled) return;
      if (loaded) {
        memoryRef.current = loaded.memory ?? null;
        dispatch({ type: "hydrate", messages: loaded.messages });
      }
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [args.draftId, args.convId]);

  const send = useCallback(
    async (instruction: string, mode: DraftMode, document: DraftDocumentSnapshot) => {
      if (busy) return;
      const text = instruction.trim();
      if (!text && mode !== "edit" && mode !== "review") return;
      const shown =
        text || (mode === "edit" ? "Improve the selected passage." : "Review this document.");
      const uid = crypto.randomUUID();
      const aid = crypto.randomUUID();
      dispatch({ type: "user", id: uid, text: shown });
      dispatch({ type: "assistant_start", id: aid });
      setBusy(true);
      const ac = new AbortController();
      abortRef.current = ac;

      const answer = makeStreamChannel((t) => dispatch({ type: "delta_flush", id: aid, text: t }));
      const thinking = makeStreamChannel((t) => dispatch({ type: "thinking", id: aid, text: t }));
      const reasoning = makeStreamChannel((t) => dispatch({ type: "reasoning", id: aid, text: t }));
      let fullAnswer = "";

      const history = messagesRef.current
        .filter((m) => (m.role === "user" ? m.text.trim() : m.answer.trim()))
        .slice(-8)
        .map((m) => ({
          role: m.role,
          content: (m.role === "user" ? m.text : m.answer).slice(0, 4000),
        }));
      const carried = Array.from(
        new Map(
          messagesRef.current.flatMap((m) => (m.sources ?? []).map((s) => [s.ref, s] as const)),
        ).values(),
      ).slice(-24);
      const memory = (memoryRef.current as Record<string, unknown> | null) ?? null;
      const outboundMemory = memory
        ? { ...memory, sources: carried }
        : carried.length
          ? { tail: history.slice(-4), sources: carried }
          : null;

      try {
        await streamSSE(
          "/api/draft",
          {
            mode,
            instruction: text,
            document,
            history,
            ...(outboundMemory ? { memory: outboundMemory } : {}),
          },
          (evt) => {
            const d = (evt.data ?? {}) as { text?: string; memory?: unknown };
            if (evt.event === "delta") {
              if (d.text) {
                answer.push(d.text);
                fullAnswer += d.text;
              }
              return;
            }
            if (evt.event === "thinking") {
              if (d.text) thinking.push(d.text);
              return;
            }
            if (evt.event === "reasoning") {
              if (d.text) reasoning.push(d.text);
              return;
            }
            if (evt.event === "memory") {
              if (d.memory) memoryRef.current = d.memory;
              return;
            }
            answer.flush();
            thinking.flush();
            reasoning.flush();
            dispatch({ type: "sse", id: aid, evt });
          },
          ac.signal,
        );
        answer.flush();
        thinking.flush();
        reasoning.flush();

        // Persist the turn to the draft's conversation (created on first use).
        const finished = messagesRef.current.find((m) => m.id === aid) ?? {
          ...emptyAssistant(aid),
          answer: fullAnswer,
          status: "done" as const,
        };
        if (!convRef.current) {
          try {
            const c = await createConversationFn({
              data: { title: `Draft: ${args.draftTitle || "Untitled document"}`.slice(0, 200) },
            });
            convRef.current = c.convId;
            await updateDraftMetaFn({ data: { draftId: args.draftId, convId: c.convId } }).catch(
              () => undefined,
            );
          } catch {
            /* history is best-effort */
          }
        }
        if (convRef.current) {
          await saveTurn({
            conversationId: convRef.current,
            question: {
              id: uid,
              role: "user",
              text: shown,
              rounds: [],
              sources: [],
              answer: "",
              status: "done",
            },
            answer: { ...finished, answer: fullAnswer || finished.answer },
            memory: memoryRef.current,
            matter: null,
            turnIndex: Math.max(0, messagesRef.current.filter((m) => m.role === "user").length - 1),
          });
        }
      } catch (err) {
        answer.flush();
        dispatch({
          type: "sse",
          id: aid,
          evt: { event: "error", data: { message: (err as Error).message ?? "Network error" } },
        });
      } finally {
        setBusy(false);
      }
    },
    [busy, args.draftId, args.draftTitle],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const markApplied = useCallback((id: string) => dispatch({ type: "proposal_applied", id }), []);

  const reset = useCallback(async () => {
    abortRef.current?.abort();
    abortRef.current = null;
    memoryRef.current = null;
    convRef.current = null;
    dispatch({ type: "reset" });
    setBusy(false);
    // A fresh thread for this draft: unlink the old conversation (it stays in
    // Chat history) so the next turn starts a new one.
    await updateDraftMetaFn({ data: { draftId: args.draftId, convId: "" } }).catch(() => undefined);
  }, [args.draftId]);

  useEffect(() => () => abortRef.current?.abort(), []);

  return { messages, busy, ready, send, stop, reset, markApplied };
}
