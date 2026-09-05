import { AnimatePresence, motion } from "framer-motion";
import {
  AlertCircle,
  ArrowUp,
  Loader2,
  ShieldCheck,
  SquarePen,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { factCheck, kindLabel, unverified } from "@/lib/fact-check";
import { sentencesForRef } from "@/lib/highlight";
import type { Attachment, MatterScope, Message } from "@/lib/chat-types";
import {
  ModeDropdown,
  useUploads,
  UploadButton,
  FileChips,
  initialMode,
  persistMode,
  type ComposerMode,
} from "./composer-kit";
import { AgentTimeline } from "./AgentTimeline";
import { ConversationHistory } from "./ConversationHistory";
import { AnswerMarkdown } from "./AnswerMarkdown";
import { ArtifactPanel } from "./ArtifactPanel";
import { ThinkingStream } from "./ThinkingStream";
import { ReasoningStream } from "./ReasoningStream";
import { AnswerActions } from "./AnswerActions";
import { WorkspaceRail } from "./WorkspaceRail";


const MIN_LEFT = 45;
const MAX_LEFT = 75;
const SPLIT_STORAGE_KEY = "wr.splitPct";
const HANDLE_PX = 12;
const clamp = (n: number) => Math.min(MAX_LEFT, Math.max(MIN_LEFT, n));

export function ChatView({
  messages,
  busy,
  onSend,
  onNewChat,
  sessionId,
  matter,
  onOpenConversation,
  conversationId,
}: {
  messages: Message[];
  busy: boolean;
  onSend: (
    text: string,
    opts?: { mode?: ComposerMode; attachments?: Attachment[] },
  ) => void;
  onNewChat: () => void;
  sessionId: string;
  matter: MatterScope | null;
  onOpenConversation: (id: string) => void;
  conversationId: string | null;
}) {
  const [leftPct, setLeftPct] = useState<number>(() => {
    if (typeof window === "undefined") return 58;
    const saved = Number(window.localStorage.getItem(SPLIT_STORAGE_KEY));
    return Number.isFinite(saved) && saved > 0 ? clamp(saved) : 58;
  });
  const [dragging, setDragging] = useState(false);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const [selectedQuote, setSelectedQuote] = useState<string | undefined>();
  const [railKey, setRailKey] = useState(0);
  const [composer, setComposer] = useState("");

  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [isMobile, setIsMobile] = useState<boolean>(false);
  const lastUserId = useMemo(
    () => [...messages].reverse().find((m) => m.role === "user")?.id,
    [messages],
  );
  const allSources = useMemo(
    () => messages.flatMap((m) => m.sources ?? []),
    [messages],
  );
  const lastAssistant = useMemo(
    () => [...messages].reverse().find((m) => m.role === "assistant"),
    [messages],
  );
  const lastBusy = useMemo(
    () =>
      lastAssistant
        ? lastAssistant.status === "thinking" ||
          lastAssistant.status === "writing"
        : false,
    [lastAssistant],
  );
  const lastFollowups = useMemo(
    () => lastAssistant?.followups ?? [],
    [lastAssistant],
  );
  const citedRefs = useMemo(() => {
    const set = new Set<string>();
    for (const m of messages) {
      if (m.role !== "assistant" || !m.answer) continue;
      for (const match of m.answer.matchAll(/\[?\b([SsDd]\d{1,3})\b\]?/g)) {
        set.add(match[1]!.toUpperCase());
      }
    }
    return set;
  }, [messages]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SPLIT_STORAGE_KEY, String(leftPct));
    } catch {
      /* ignore */
    }
  }, [leftPct]);

  // Reflect the committed percentage into the CSS var (mount + keyboard nudges).
  useEffect(() => {
    splitContainerRef.current?.style.setProperty("--split-pct", `${leftPct}%`);
  }, [leftPct]);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 1023.98px)");
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // ---- Single scroll controller -------------------------------------------
  // One rule: a new question anchors to the top of the viewport and stays put.
  // We only follow new content when the user is parked at the bottom, and the
  // natural document height is preserved so the reader cannot scroll into
  // synthetic blank space after the final response.
  const lastMsg = messages[messages.length - 1];
  const lastAnswerLen = lastMsg ? lastMsg.answer.length : 0;
  const lastStatus = lastMsg?.status;

  const followRef = useRef(false);
  // True while the anchor scroll owns the viewport; nothing else may move it.
  const animatingRef = useRef(false);
  const rafRef = useRef<number | null>(null);

  const nearBottom = useCallback((el: HTMLElement) => {
    return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }, []);

  // Passive scroll listener drives follow-mode. A direct wheel/touch gesture
  // cancels follow (and any in-flight anchor) instantly.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const bottom = nearBottom(el);
      if (!animatingRef.current) followRef.current = bottom;
    };
    const onGesture = () => {
      animatingRef.current = false;
      followRef.current = nearBottom(el);
    };
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onGesture, { passive: true });
    el.addEventListener("touchstart", onGesture, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onGesture);
      el.removeEventListener("touchstart", onGesture);
    };
  }, [nearBottom]);

  // Continuous eased follow: one rAF loop that closes the remaining distance
  // to the bottom a fraction at a time instead of hopping every token flush.
  const startFollowLoop = useCallback(() => {
    if (rafRef.current != null) return;
    const step = () => {
      const el = scrollRef.current;
      if (!el || !followRef.current || animatingRef.current) {
        rafRef.current = null;
        return;
      }
      const target = el.scrollHeight - el.clientHeight;
      const delta = target - el.scrollTop;
      if (delta <= 1) {
        rafRef.current = null;
        return;
      }
      el.scrollTop += Math.max(1, Math.min(delta * 0.22, 36));
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
  }, []);

  useEffect(
    () => () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    },
    [],
  );

  // Bring each new question into view exactly once. The target is clamped to
  // the natural maximum, so short turns never create artificial scroll room.
  useEffect(() => {
    if (!lastUserId) return;
    const el = scrollRef.current;
    if (!el) return;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let stopTimer: ReturnType<typeof setTimeout> | null = null;
    const run = () => {
      const node = el.querySelector<HTMLElement>(
        `[data-user-msg="${CSS.escape(lastUserId)}"]`,
      );
      if (!node) return;
      const requestedTop =
        node.getBoundingClientRect().top -
        el.getBoundingClientRect().top +
        el.scrollTop -
        12;
      const top = Math.max(
        0,
        Math.min(requestedTop, el.scrollHeight - el.clientHeight),
      );
      followRef.current = false;
      animatingRef.current = true;
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      el.scrollTo({ top, behavior: "smooth" });
      // Release the viewport once the smooth scroll goes quiet (or times out).
      let last = el.scrollTop;
      const poll = () => {
        if (!animatingRef.current) return;
        if (Math.abs(el.scrollTop - last) < 1) {
          animatingRef.current = false;
          return;
        }
        last = el.scrollTop;
        settleTimer = setTimeout(poll, 100);
      };
      settleTimer = setTimeout(poll, 120);
      stopTimer = setTimeout(() => {
        animatingRef.current = false;
      }, 1200);
    };
    const raf = requestAnimationFrame(() => requestAnimationFrame(run));
    return () => {
      cancelAnimationFrame(raf);
      if (settleTimer) clearTimeout(settleTimer);
      if (stopTimer) clearTimeout(stopTimer);
      animatingRef.current = false;
    };
  }, [lastUserId]);

  // Follow new content only while the user is parked at the bottom.
  useEffect(() => {
    if (!followRef.current || animatingRef.current) return;
    startFollowLoop();
  }, [lastAnswerLen, lastStatus, startFollowLoop]);



  useEffect(() => {
    if (!isMobile) setPanelOpen(false);
  }, [isMobile]);

  // Imperative drag: during pointermove only the CSS var changes (no React
  // re-render); the committed percentage is stored once, on release.
  const onResizerPointerDown = useCallback((e: React.PointerEvent) => {
    const container = splitContainerRef.current;
    if (!container) return;
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setDragging(true);
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    let raf = 0;
    let nextPct = 0;
    const onMove = (ev: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      nextPct = clamp(((ev.clientX - rect.left) / rect.width) * 100);
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          container.style.setProperty("--split-pct", `${nextPct}%`);
        });
      }
    };
    const onUp = () => {
      setDragging(false);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (raf) cancelAnimationFrame(raf);
      if (nextPct) setLeftPct(nextPct);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }, []);

  const onResizerKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    setLeftPct((pct) => clamp(pct + (e.key === "ArrowLeft" ? -2 : 2)));
  }, []);

  function handleCite(ref: string, msg: Message) {
    setSelectedRef(ref);
    const quote = sentencesForRef(msg.answer, ref);
    setSelectedQuote(quote || undefined);
    if (isMobile) setPanelOpen(true);
  }

  function clearSelect() {
    setSelectedRef(null);
    setSelectedQuote(undefined);
  }

  return (
    <div className="relative h-full min-h-0">
      <div
        ref={splitContainerRef}
        className="flex h-full min-h-0 w-full flex-col lg:flex-row"
      >
        {/* Left: chat column */}
        <div className="relative flex h-full min-h-0 w-full flex-1 flex-col lg:w-[var(--split-pct)] lg:flex-none lg:[contain:layout]">
          <div className="relative h-full min-h-0">
            <div
              ref={scrollRef}
              className="wr-app-scroll h-full overflow-y-auto overscroll-contain px-4 pb-[168px] pt-4 sm:px-7 lg:px-8"
            >
              <div className="mx-auto w-full max-w-[820px]">
                {messages.map((m, i) =>
                  m.role === "user" ? (
                    <UserMessage key={m.id} msg={m} />
                  ) : (
                    <AssistantMessage
                      key={m.id}
                      msg={m}
                      onCite={(ref) => handleCite(ref, m)}
                      selectedRef={selectedRef}
                      question={
                        [...messages.slice(0, i)]
                          .reverse()
                          .find((p) => p.role === "user")?.text ?? ""
                      }
                      matter={matter}
                      conversationId={conversationId}
                      onWorkspaceChange={() => setRailKey((k) => k + 1)}
                    />
                  ),
                )}

                {!lastBusy && lastFollowups.length > 0 && (
                  <div className="mb-4">
                    <div className="mb-2 text-xs text-muted-foreground">
                      Suggested follow-ups
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {lastFollowups.map((f, i) => (
                        <button
                          key={`${i}-${f}`}
                          onClick={() => onSend(f)}
                          className="max-w-full truncate rounded-md border border-border bg-card px-2.5 py-1 text-xs text-foreground shadow-sm transition-colors hover:bg-muted/60"
                          title={f}
                        >
                          {f}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

            </div>
          </div>
          {/* Composer: sticky footer inside the chat column */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-background via-background/92 to-transparent px-4 pb-3 pt-10 sm:px-8 lg:px-10">
            <div className="pointer-events-auto mx-auto w-full max-w-[880px]">

              <ChatComposer
                value={composer}
                onChange={setComposer}
                onSubmit={(t, opts) => {
                  setComposer("");
                  onSend(t, opts);
                }}

                busy={busy}
                onNewChat={onNewChat}
                textareaRef={composerRef}
                onOpenConversation={onOpenConversation}
                conversationId={conversationId}
              />
            </div>
          </div>
        </div>

        {/* Drag handle (desktop only) */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize panels"
          aria-valuemin={MIN_LEFT}
          aria-valuemax={MAX_LEFT}
          aria-valuenow={Math.round(leftPct)}
          tabIndex={0}
          onPointerDown={onResizerPointerDown}
          onKeyDown={onResizerKeyDown}
          className="group relative hidden h-full w-3 shrink-0 cursor-col-resize touch-none select-none items-center justify-center lg:flex"
        >
          <span
            className={[
              "pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors",
              dragging
                ? "bg-brand-navy/40"
                : "bg-border group-hover:bg-brand-navy/30",
            ].join(" ")}
          />
          <span
            className={[
              "pointer-events-none relative z-10 grid h-10 w-5 place-items-center rounded-md border bg-card transition-all",
              dragging
                ? "border-brand-navy/40 shadow-sm"
                : "border-border group-hover:border-brand-navy/30 group-hover:shadow-sm",
            ].join(" ")}
          >
            <span className="flex flex-col gap-[3px]">
              <span className="h-[3px] w-[3px] rounded-full bg-muted-foreground/60" />
              <span className="h-[3px] w-[3px] rounded-full bg-muted-foreground/60" />
              <span className="h-[3px] w-[3px] rounded-full bg-muted-foreground/60" />
            </span>
          </span>
        </div>

        {/* Right: sources panel */}
        <aside
          className="hidden h-full min-h-0 border-l border-border bg-card/30 lg:block"
          style={{ width: `calc(100% - var(--split-pct) - ${HANDLE_PX}px)` }}
        >
          <WorkspaceRail
            sources={allSources}
            selectedRef={selectedRef}
            citedRefs={citedRefs}
            selectedQuote={selectedQuote}
            onClearSelect={clearSelect}
            conversationId={conversationId}
            matter={matter}
            reloadKey={railKey}
          />

        </aside>
      </div>

      {/* Mobile sources sheet */}
      <AnimatePresence>
        {panelOpen && isMobile && (
          <motion.div
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", stiffness: 280, damping: 30 }}
            className="absolute inset-0 z-40 lg:hidden"
          >
            <div
              className="absolute inset-0 bg-black/30"
              onClick={() => setPanelOpen(false)}
            />
            <div className="absolute inset-x-0 bottom-0 top-10 rounded-t-xl bg-card shadow-xl">
              <div className="flex h-11 items-center justify-between border-b px-3">
                <div className="text-sm font-medium">Sources</div>
                <button
                  className="rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-muted"
                  onClick={() => setPanelOpen(false)}
                >
                  Close
                </button>
              </div>
              <div className="h-[calc(100%-2.75rem)]">
                <WorkspaceRail
                  sources={allSources}
                  selectedRef={selectedRef}
                  citedRefs={citedRefs}
                  selectedQuote={selectedQuote}
                  onClearSelect={clearSelect}
                  conversationId={conversationId}
                  matter={matter}
                  reloadKey={railKey}
                />

              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ChatComposer({
  value,
  onChange,
  onSubmit,
  busy,
  onNewChat,
  textareaRef,
  onOpenConversation,
  conversationId,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string, opts: { mode: ComposerMode; attachments: Attachment[] }) => void;
  busy: boolean;
  onNewChat: () => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  onOpenConversation: (id: string) => void;
  conversationId: string | null;
}) {
  const [mode, setModeRaw] = useState<ComposerMode>(initialMode);
  const setMode = useCallback((m: ComposerMode) => {
    setModeRaw(m);
    persistMode(m);
  }, []);
  const { files, uploading, uploadError, handleFiles, removeFile } = useUploads();

  const submit = useCallback(
    (v: string) => {
      if (!v.trim() || busy) return;
      onSubmit(v, { mode, attachments: files });
    },
    [onSubmit, mode, files, busy],
  );

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const resize = () => {
      // Empty composer: pin to the exact min height. Measuring an empty
      // textarea can read a rounded/stale scrollHeight (fonts, pane layout)
      // and leave the box a few px taller than it should be.
      if (!el.value) {
        el.style.height = "44px";
        return;
      }
      el.style.height = "0px";
      el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
    };
    // Measure now (layout phase) and again after paint, once the
    // surrounding split-pane/flex layout has fully settled — the first
    // mount can otherwise read a stale scrollHeight and lock the box tall.
    resize();
    const raf = requestAnimationFrame(resize);
    window.addEventListener("resize", resize);
    // Re-measure when the composer's width changes (mode switches, pane
    // drags) and once webfonts settle — both change line wrapping.
    let lastW = el.clientWidth;
    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            const w = el.clientWidth;
            if (w !== lastW) {
              lastW = w;
              resize();
            }
          })
        : null;
    ro?.observe(el);
    document.fonts?.ready.then(() => resize()).catch(() => {});
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      ro?.disconnect();
    };
  }, [value, textareaRef]);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit(value);
      }}
      onDragOver={(e) => {
        e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        if (!busy) void handleFiles(e.dataTransfer?.files ?? null);
      }}
      className="relative flex w-full flex-col rounded-lg border border-border bg-card/95 shadow-[0_8px_28px_-14px_rgba(31,42,94,0.22)] backdrop-blur-md transition-all focus-within:border-primary/40 focus-within:shadow-[0_12px_32px_-16px_rgba(31,42,94,0.28)]"
    >
      <FileChips files={files} onRemove={removeFile} className="px-2.5 pt-2" />
      <div className="flex items-end gap-1.5 px-2.5 pt-2">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit(value);
            }
          }}
          rows={1}
          disabled={busy}
          placeholder="Ask a follow-up about MDLs, bellwethers, or precedent…"
          className="block max-h-[220px] min-h-[44px] w-full min-w-0 resize-none bg-transparent px-1.5 py-1.5 text-[14px] leading-[1.55] placeholder:text-muted-foreground/80 focus:outline-none"
        />
        <button
          type="submit"
          disabled={busy || !value.trim()}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-brand-navy text-white shadow-sm transition-all duration-200 hover:bg-brand-navy/90 disabled:opacity-40"
          aria-label="Send"
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <ArrowUp className="h-[18px] w-[18px]" strokeWidth={2.4} />
          )}
        </button>
      </div>
      <div className="mt-1 flex items-center gap-1 border-t border-border/60 px-2 py-1.5">
        <ModeDropdown mode={mode} onChange={setMode} disabled={busy} />
        <UploadButton onFiles={handleFiles} uploading={uploading} disabled={busy} />
        <span className="mx-0.5 h-4 w-px bg-border/70" />
        <button
          type="button"
          onClick={onNewChat}
          title="New chat"
          aria-label="New chat"
          className="grid h-8 w-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-brand-navy"
        >
          <SquarePen className="h-[15px] w-[15px]" strokeWidth={1.85} />
        </button>
        <ConversationHistory
          activeId={conversationId}
          onOpen={onOpenConversation}
        />
      </div>
      {uploadError && (
        <div className="pb-2 text-center text-[11px] text-destructive">
          {uploadError}
        </div>
      )}
    </form>
  );
}

function ModeBadge({ mode, reason, sources }: { mode: string; reason?: string; sources: number }) {
  const META: Record<string, { label: string; cls: string }> = {
    fast: { label: "Fast", cls: "border-amber-200 bg-amber-50 text-amber-700" },
    think: { label: "Think", cls: "border-[oklch(0.55_0.22_262/0.25)] bg-brand-blue-soft/50 text-brand-navy" },
  };
  const m = META[mode] ?? { label: mode, cls: "border-slate-200 bg-slate-100 text-slate-600" };
  return (
    <div className="mb-1.5 flex items-center gap-1.5 text-[11px]">
      <span
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-medium ${m.cls}`}
        title={reason ? `Effort: ${reason}` : undefined}
      >
        {m.label} mode
      </span>
      {sources > 0 && (
        <span className="text-muted-foreground/70">
          {sources} source{sources === 1 ? "" : "s"}
        </span>
      )}
    </div>
  );
}

/** Citation-faithfulness trust chip: how many [S#]-cited claims a reasoning
 *  judge found the cited sources actually support. Green when all supported;
 *  amber when some are unsupported (tooltip lists them). A signal, not a gate. */
function FaithfulnessChip({
  f,
}: {
  f: { checked: number; supported: number; unsupported: { claim: string; refs: string[] }[] };
}) {
  const clean = f.unsupported.length === 0 && f.supported >= f.checked;
  const tone = clean ? "bg-emerald-500/70" : "bg-amber-500/70";
  const title = f.unsupported.length
    ? "Cited claims the source may not fully support:\n" +
      f.unsupported
        .map((u) => `• ${u.claim}${u.refs.length ? ` [${u.refs.join(", ")}]` : ""}`)
        .join("\n")
    : "Every cited claim is supported by its source (reasoning-model check).";
  return (
    <span className="inline-flex items-center gap-1" title={title}>
      <span className={`h-1.5 w-1.5 rounded-full ${tone}`} />
      {f.supported}/{f.checked} cited claims source-supported
      {f.unsupported.length ? ` · ${f.unsupported.length} to review` : ""}
    </span>
  );
}

function UserMessage({ msg }: { msg: Message }) {
  return (
    <div data-user-msg={msg.id} className="mb-1.5 flex justify-end scroll-mt-4">

      <div className="max-w-[85%] rounded-lg rounded-br-sm bg-brand-navy px-3.5 py-2 text-[13.5px] leading-relaxed text-white shadow-sm">
        {msg.text}
      </div>
    </div>
  );
}

function AssistantMessage({
  msg,
  onCite,
  selectedRef,
  question,
  matter,
  conversationId,
  onWorkspaceChange,
}: {
  msg: Message;
  onCite: (ref: string) => void;
  selectedRef: string | null;
  question: string;
  matter: MatterScope | null;
  conversationId: string | null;
  onWorkspaceChange: () => void;
}) {

  const rounds = msg.rounds ?? [];

  return (
    <div className="mb-3">
      {msg.status === "thinking" && rounds.length === 0 && (
        <div className="mb-2 flex h-[11px] items-center">
          <span className="h-[7px] w-[7px] animate-pulse rounded-full bg-brand-orange" />
        </div>
      )}
      {rounds.length > 0 && (
        <AgentTimeline
          rounds={rounds}
          collapsed={
            Boolean(msg.collapseTimeline) ||
            msg.status === "writing" ||
            msg.status === "done"
          }
          settled={msg.status === "writing" || msg.status === "done"}
          sourceCount={(msg.sources ?? []).length}
        />
      )}
      <ReasoningStream
        text={msg.reasoning ?? ""}
        active={msg.status === "thinking" || msg.status === "writing"}
      />
      <ThinkingStream
        text={msg.thinking ?? ""}
        active={msg.status === "thinking"}
      />
      {msg.status === "writing" && !msg.answer.trim() && (
        <div className="mb-2.5 flex items-center gap-2 rounded-lg border border-brand-orange/25 bg-gradient-to-b from-brand-orange-soft/25 to-transparent px-2.5 py-1.5">
          <span className="h-[7px] w-[7px] shrink-0 animate-pulse rounded-full bg-brand-orange" />
          <span className="text-[12.5px] font-medium text-foreground/75">
            {msg.deliverable
              ? `Research complete · preparing your ${msg.deliverable.toUpperCase()} report`
              : "Research complete · writing your answer"}
            {(msg.sources?.length ?? 0) > 0
              ? ` from ${msg.sources.length} source${msg.sources.length === 1 ? "" : "s"}`
              : ""}
            &hellip;
          </span>
        </div>
      )}
      {msg.mode && msg.mode !== "conversational" && msg.answer.trim().length > 0 && (
        <ModeBadge mode={msg.mode} reason={msg.modeReason} sources={(msg.sources ?? []).length} />
      )}
      <div className="prose prose-neutral max-w-none text-foreground [&_code]:break-all [&_pre]:whitespace-pre-wrap">
        <AnswerMarkdown
          text={msg.answer}
          onCite={onCite}
          selectedRef={selectedRef}
          streaming={msg.status === "writing"}
        />
        {msg.artifacts && msg.artifacts.length > 0 && (
          <ArtifactPanel artifacts={msg.artifacts} />
        )}
        {msg.status === "error" && (
          <div className="mt-2 flex items-start gap-2 text-sm text-red-600">
            <AlertCircle className="mt-[2px] h-4 w-4 shrink-0" />
            <span>{msg.error || "Something went wrong while researching."}</span>
          </div>
        )}
        {msg.status === "done" &&
          msg.verification &&
          (msg.verification.factsChecked > 0 ||
            (msg.verification.faithfulness?.checked ?? 0) > 0) && (
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground/70">
              {msg.verification.factsChecked > 0 && (
                <span className="inline-flex items-center gap-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500/70" />
                  {msg.verification.factsVerified}/{msg.verification.factsChecked}{" "}
                  specifics verified against sources
                </span>
              )}
              {msg.verification.factsChecked > 0 &&
                msg.verification.unverified.length +
                  msg.verification.orphanRefs.length >
                  0 && (
                  <span
                    className="text-amber-700/80"
                    title={[
                      ...msg.verification.unverified,
                      ...msg.verification.orphanRefs.map((r) => `unmatched ${r}`),
                    ].join(" · ")}
                  >
                    ·{" "}
                    {msg.verification.unverified.length +
                      msg.verification.orphanRefs.length}{" "}
                    to confirm
                  </span>
                )}
              {(msg.verification.faithfulness?.checked ?? 0) > 0 && (
                <FaithfulnessChip f={msg.verification.faithfulness!} />
              )}
            </div>
          )}
        {msg.status === "done" && msg.answer.trim().length > 0 && (
          <AnswerActions
            question={question}
            answer={msg.answer}
            sources={msg.sources ?? []}
            matter={matter}
            conversationId={conversationId}
            onWatchAdded={onWorkspaceChange}
          />
        )}

      </div>
    </div>
  );
}
