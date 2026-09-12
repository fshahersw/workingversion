import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { streamOrchestrate, fetchFollowups, type SSEEvent } from "@/lib/orchestrate";
import type { Attachment, ChoiceAnswer, MatterScope, Message } from "@/lib/chat-types";
import {
  loadConversation,
  saveFollowups,
  saveTurn,
  updateAssistantTurn,
  updateConversationMemory,
  keepConversation,
} from "@/lib/chat/history";
import {
  emptyAssistant,
  makeStreamChannel,
  reduceChatMessages,
  type ChatAction,
} from "@/lib/chat-reducer";

// The reducer lives in chat-reducer.ts (pure, unit-tested); these re-exports
// keep the historical import path working for other hooks.
export { emptyAssistant, makeStreamChannel, reduceChatMessages, type ChatAction } from "@/lib/chat-reducer";

export type SendMode = "auto" | "fast" | "think";

export type SendOptions = {
  mode?: SendMode;
  attachments?: Attachment[];
  /** Resume the same question after a clarification-panel selection. */
  choice?: ChoiceAnswer;
  /** Id of the assistant message whose panel is being answered. */
  resumeId?: string;
};

type StoredSendOptions = { mode?: SendMode; attachments?: Attachment[] };

type Tail = { role: "user" | "assistant"; content: string }[];

/**
 * Verbatim recent turns for the server, built from the client's own transcript
 * (the server's copy rides on the `memory` event, which can still be in flight
 * when the next question is sent). An answered clarification is carried as a
 * marker on its question so the detectors treat that fork as settled later.
 */
export function buildTail(messages: Message[]): Tail {
  const tail: Tail = [];
  for (const m of messages) {
    if (m.role === "user") {
      if (m.text.trim()) tail.push({ role: "user", content: m.text.slice(0, 4000) });
      continue;
    }
    const answered = m.choice?.answered;
    if (m.choice && answered) {
      const marker = `[Clarification — ${m.choice.id}: ${(answered.text || answered.label).slice(0, 200)}]`;
      const last = tail[tail.length - 1];
      if (last && last.role === "user") last.content = `${last.content}\n${marker}`;
      else tail.push({ role: "user", content: marker });
    }
    if (m.answer.trim()) tail.push({ role: "assistant", content: m.answer.slice(0, 4000) });
  }
  return tail;
}

export function useChat(sessionId: string) {
  const [messages, dispatch] = useReducer(reduceChatMessages, [] as Message[]);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  // Maintained conversation memory (rolling summary, entity ledger, verbatim
  // tail, retrieved sources). The server refreshes it after each answer and
  // sends it back on the `memory` event; we carry it forward.
  const memoryRef = useRef<unknown>(null);
  // Conversation the turns are being saved to (created lazily on first turn).
  const conversationRef = useRef<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const messagesRef = useRef<Message[]>(messages);
  messagesRef.current = messages;
  // Monotonic run counter: only the newest run may replace the memory, so an
  // older run's late `memory` event cannot overwrite a newer one.
  const runSeqRef = useRef(0);
  // Chat generation, bumped by reset/open: a run from a previous chat can
  // neither attach its turn to the new one nor refill its memory.
  const genRef = useRef(0);
  // Original send options per assistant message id, replayed on a resume.
  const sendOptsRef = useRef(new Map<string, StoredSendOptions>());
  // Persistence runs strictly in order (the first turn creates the conversation
  // that the second one must append to).
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());

  const send = useCallback(
    async (text: string, matter?: MatterScope | null, opts?: SendOptions) => {
      if (busy || !text.trim()) return;
      const snapshot = messagesRef.current;
      let uid: string = crypto.randomUUID();
      let aid: string = crypto.randomUUID();
      let prior = snapshot;
      let local: Message;
      let sendOpts: StoredSendOptions = {
        ...(opts?.mode ? { mode: opts.mode } : {}),
        ...(opts?.attachments ? { attachments: opts.attachments } : {}),
      };
      const choice = opts?.choice;
      if (choice) {
        const open = snapshot.filter(
          (m) => m.role === "assistant" && m.choice && !m.choice.answered && !m.choice.dismissed,
        );
        const target = opts?.resumeId ? open.find((m) => m.id === opts.resumeId) : open[open.length - 1];
        if (!target) return;
        aid = target.id;
        const idx = snapshot.findIndex((m) => m.id === aid);
        let userIdx = -1;
        for (let i = idx - 1; i >= 0; i--) {
          if (snapshot[i]?.role === "user") {
            userIdx = i;
            break;
          }
        }
        if (userIdx >= 0) uid = snapshot[userIdx]!.id;
        // The pending question and its placeholder are the turn being resumed,
        // not prior context.
        prior = snapshot.slice(0, userIdx >= 0 ? userIdx : idx);
        // Replay the original mode and attachments unless overridden.
        sendOpts = { ...(sendOptsRef.current.get(aid) ?? {}), ...sendOpts };
        const action: ChatAction = { type: "choice_resume", id: aid, answer: choice };
        dispatch(action);
        local = reduceChatMessages([target], action)[0] ?? emptyAssistant(aid);
      } else {
        dispatch({ type: "user", id: uid, text });
        dispatch({ type: "assistant_start", id: aid });
        local = emptyAssistant(aid);
      }
      sendOptsRef.current.set(aid, sendOpts);
      const myRun = ++runSeqRef.current;
      const myGen = genRef.current;
      setBusy(true);
      const ac = new AbortController();
      abortRef.current = ac;

      // Every action is applied to a local copy as well, so persistence never
      // depends on React having rendered the latest state.
      const apply = (action: ChatAction) => {
        local = reduceChatMessages([local], action)[0] ?? local;
        dispatch(action);
      };
      let fullAnswer = "";
      // RAF-batched channels so we do not re-render per token.
      const answerCh = makeStreamChannel((t) => apply({ type: "delta_flush", id: aid, text: t }));
      const thinkCh = makeStreamChannel((t) => apply({ type: "thinking", id: aid, text: t }));
      const reasonCh = makeStreamChannel((t) => apply({ type: "reasoning", id: aid, text: t }));
      const flushAll = () => {
        answerCh.flush();
        thinkCh.flush();
        reasonCh.flush();
      };

      let doneSeen = false;
      let awaitingChoice = false;
      let persisted = false;
      let savedConv: string | null = null;
      let savedMsgId: string | null = null;
      let verificationAfterSave = false;
      let memoryArrived = false;
      let followupsRequested = false;
      let saveDone: Promise<void> = Promise.resolve();

      const requestFollowups = () => {
        if (followupsRequested || awaitingChoice || !fullAnswer.trim()) return;
        followupsRequested = true;
        fetchFollowups(text, fullAnswer).then((followups) => {
          if (followups.length) {
            dispatch({ type: "followups", id: aid, followups });
            void saveFollowups(conversationRef.current, aid, followups);
          }
        });
      };

      // Persist the moment the answer is complete (on `done`, or on Stop with
      // text on screen), not after the late-event drain: a Stop, New chat, or
      // navigation during the drain used to lose the whole turn.
      const persist = () => {
        if (persisted) return;
        persisted = true;
        flushAll();
        const answer: Message = { ...local, answer: fullAnswer || local.answer, status: "done" };
        if (!answer.answer.trim() && !answer.artifacts?.length) return;
        const question: Message = {
          id: uid,
          role: "user",
          text,
          rounds: [],
          sources: [],
          answer: "",
          status: "done",
        };
        const capturedConv = conversationRef.current;
        const run = async () => {
          // A run whose chat was reset or reopened meanwhile must not attach
          // its turn to the new chat; it gets its own conversation instead.
          const convId = capturedConv ?? (genRef.current === myGen ? conversationRef.current : null);
          const res = await saveTurn({
            conversationId: convId,
            question,
            answer,
            memory: memoryRef.current,
            matter: matter ?? null,
          });
          savedConv = res.conversationId;
          savedMsgId = res.assistantMsgId;
          if (res.conversationId && genRef.current === myGen && res.conversationId !== conversationRef.current) {
            conversationRef.current = res.conversationId;
            setConversationId(res.conversationId);
          }
        };
        saveDone = saveChainRef.current = saveChainRef.current.then(run, run).catch(() => undefined);
      };

      const onEvent = (evt: SSEEvent) => {
        if (evt.event === "delta") {
          const d = (evt.data ?? {}) as { text?: string };
          if (d.text) {
            fullAnswer += d.text;
            answerCh.push(d.text);
          }
          return;
        }
        if (evt.event === "thinking") {
          const d = (evt.data ?? {}) as { text?: string };
          if (d.text) thinkCh.push(d.text);
          return;
        }
        if (evt.event === "reasoning") {
          const d = (evt.data ?? {}) as { text?: string };
          if (d.text) reasonCh.push(d.text);
          return;
        }
        if (evt.event === "memory") {
          const d = (evt.data ?? {}) as { memory?: unknown };
          // Only the newest run in the current chat may replace the memory.
          if (d.memory && runSeqRef.current === myRun && genRef.current === myGen) {
            memoryRef.current = d.memory;
            memoryArrived = true;
          }
          return;
        }
        // For non-delta events, flush pending text first so ordering with
        // writer_start / done is preserved.
        flushAll();
        if (evt.event === "choice") awaitingChoice = true;
        if (evt.event === "verification" && persisted) verificationAfterSave = true;
        apply({ type: "sse", id: aid, evt });
        if (evt.event === "done") {
          doneSeen = true;
          const status = String((evt.data as { status?: unknown } | null)?.status ?? "");
          if (status === "awaiting_choice") awaitingChoice = true;
          // The answer is complete. Release the composer now; the faithfulness
          // verdict and the memory refresh arrive as late events on this same
          // stream and are applied by message id.
          if (abortRef.current === ac) setBusy(false);
          if (!awaitingChoice) {
            persist();
            requestFollowups();
          }
        }
      };

      try {
        // Sources already retrieved this session keep their [S#] refs, so
        // follow-ups reuse them instead of re-running the same searches.
        const carriedSources = Array.from(
          new Map(snapshot.flatMap((m) => (m.sources ?? []).map((s) => [s.ref, s] as const))).values(),
        ).slice(-24);
        const tail = buildTail(prior).slice(-4);
        const memory = (memoryRef.current as Record<string, unknown> | null) ?? null;
        const outboundMemory = memory
          ? { ...memory, tail, sources: carriedSources }
          : tail.length || carriedSources.length
            ? { tail, sources: carriedSources }
            : null;
        // Only fully-ingested attachments; processing/errored ones are skipped.
        const ready = (sendOpts.attachments ?? []).filter(
          (a) => a.status !== "processing" && a.status !== "error",
        );
        await streamOrchestrate(
          {
            query: text,
            session_id: sessionId,
            stream: true,
            ...(outboundMemory ? { memory: outboundMemory } : {}),
            ...(matter ? { matter_id: matter.matterId, matter_label: matter.label } : {}),
            ...(sendOpts.mode && sendOpts.mode !== "auto" ? { mode: sendOpts.mode } : {}),
            ...(choice ? { choice } : {}),
            ...(ready.length ? { attachments: ready } : {}),
          },
          onEvent,
          ac.signal,
        );
        flushAll();
        if (!doneSeen) {
          // The server closed the stream without a terminal event: settle the
          // turn with whatever streamed rather than leaving it spinning.
          doneSeen = true;
          apply({ type: "sse", id: aid, evt: { event: "done", data: { status: "ended" } } });
          persist();
          requestFollowups();
        }
      } catch (err) {
        flushAll();
        if (ac.signal.aborted) {
          if (!doneSeen) {
            // Stop: keep whatever streamed and settle the turn as complete.
            doneSeen = true;
            apply({ type: "sse", id: aid, evt: { event: "done", data: { status: "stopped" } } });
            persist();
          }
        } else if (!doneSeen) {
          apply({
            type: "sse",
            id: aid,
            evt: { event: "error", data: { message: (err as Error).message ?? "Network error" } },
          });
        } else {
          // The late-event drain failed after the answer completed; the answer
          // stands, only the verdict/memory refresh may be missing.
          console.warn("[chat] late-event stream ended early", err);
        }
      } finally {
        // Only the stream that currently owns the composer may release it; an
        // older stream draining its late events must not flip a newer run's state.
        if (abortRef.current === ac) setBusy(false);
      }

      // Post-drain bookkeeping for the persisted turn.
      await saveDone;
      if (savedConv && savedMsgId && verificationAfterSave) {
        flushAll();
        await updateAssistantTurn(savedConv, savedMsgId, {
          ...local,
          answer: fullAnswer || local.answer,
          status: "done",
        });
      }
      if (savedConv && memoryArrived && genRef.current === myGen) {
        await updateConversationMemory(savedConv, memoryRef.current);
      }
    },
    [busy, sessionId],
  );

  /** Abort the in-flight run. The answer streamed so far is kept. */
  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    genRef.current += 1;
    memoryRef.current = null;
    conversationRef.current = null;
    sendOptsRef.current.clear();
    setConversationId(null);
    dispatch({ type: "reset" });
    setBusy(false);
  }, []);

  /** Reopens a saved conversation with its messages, memory, and sources. */
  const open = useCallback(async (id: string) => {
    abortRef.current?.abort();
    abortRef.current = null;
    genRef.current += 1;
    sendOptsRef.current.clear();
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

  return { messages, send, stop, busy, reset, open, keep, conversationId };
}
