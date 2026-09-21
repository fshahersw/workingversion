import { AnimatePresence, motion } from "framer-motion";
import {
  AlertCircle,
  ArrowRight,
  ArrowUp,
  Square,
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

import { sentencesForRef } from "@/lib/highlight";
import type { Attachment, ChoiceAnswer, MatterScope, Message, Source } from "@/lib/chat-types";
import {
  ModeDropdown,
  useUploads,
  UploadButton,
  FileChips,
  initialMode,
  persistMode,
  type ComposerMode,
} from "./composer-kit";
import { MicButton } from "./MicButton";
import { ActivityPanel } from "./ActivityPanel";
import { composerPlaceholder } from "@/lib/chat/composer-placeholder";
import { AnswerMarkdown } from "./AnswerMarkdown";
import { ArtifactPanel } from "./ArtifactPanel";
import { AnswerActions } from "./AnswerActions";
import { WorkspaceRail } from "./WorkspaceRail";
import { StructuredChoicePanel } from "./StructuredChoicePanel";
import { SkillForm, SlashPalette } from "./SkillMenu";
import { ComposerScope, MatterChip } from "./ComposerScope";
import { filterSkills, slashDraft, type ResearchSkill, type SelectedDoc } from "@/lib/research-skills";

const MIN_LEFT = 45;
const MAX_LEFT = 75;
const SPLIT_STORAGE_KEY = "wr.splitPct";
const HANDLE_PX = 12;
const clamp = (n: number) => Math.min(MAX_LEFT, Math.max(MIN_LEFT, n));

/** True while the composer holds a slash command that matches at least one
 *  skill: the palette owns Enter then, so Send stays off. An unmatched draft
 *  such as "/remand" is ordinary text and can be sent. */
function slashSkillPending(text: string): boolean {
  const draft = slashDraft(text);
  return draft !== null && filterSkills(draft).length > 0;
}

/** Upper-cased refs an answer cites, with or without the brackets. */
function citedRefsIn(answer: string): Set<string> {
  const set = new Set<string>();
  if (!answer) return set;
  for (const match of answer.matchAll(/\[?\b([SsDd]\d{1,3})\b\]?/g)) {
    set.add(match[1]!.toUpperCase());
  }
  return set;
}

type SourceIndex = { allSources: Source[]; sourcesByRef: Record<string, Source> };
type SourceIndexCache = { ids: string[]; arrays: (Source[] | undefined)[]; index: SourceIndex };

function buildSourceIndex(messages: Message[]): SourceIndex {
  // Sources carried into a follow-up keep their refs, so the same source appears
  // on several turns; the rail shows each ref once (latest copy wins).
  const byRef = new Map<string, Source>();
  for (const m of messages) for (const s of m.sources ?? []) byRef.set(s.ref, s);
  const allSources = [...byRef.values()];
  // Ref -> source for the citation hover cards (one map for the whole thread,
  // since refs are stable across turns).
  const sourcesByRef: Record<string, Source> = {};
  for (const s of allSources) sourcesByRef[s.ref.toUpperCase()] = s;
  return { allSources, sourcesByRef };
}

function sameSourceArrays(cache: SourceIndexCache, messages: Message[]): boolean {
  return (
    cache.ids.length === messages.length &&
    messages.every((m, i) => cache.ids[i] === m.id && cache.arrays[i] === m.sources)
  );
}

/**
 * The thread's source index, rebuilt only when some message's `sources` ARRAY
 * changes identity. The reducer spreads the message on every delta flush but
 * keeps `sources` as is; keying this on `messages` would hand every memoized
 * markdown block a new map each frame and re-parse the whole answer.
 */
function useSourceIndex(messages: Message[]): SourceIndex {
  const cache = useRef<SourceIndexCache | null>(null);
  const prev = cache.current;
  const index =
    prev && sameSourceArrays(prev, messages) ? prev.index : buildSourceIndex(messages);
  // Remember what was handed out, after commit, so a discarded render never
  // poisons the cache.
  useEffect(() => {
    if (cache.current?.index !== index) {
      cache.current = {
        ids: messages.map((m) => m.id),
        arrays: messages.map((m) => m.sources),
        index,
      };
    }
  });
  return index;
}

export function ChatView({
  messages,
  busy,
  onSend,
  onStop,
  onNewChat,
  sessionId,
  matter,
  onMatterChange,
  selectedDocs = [],
  onDocsChange,
  focusOnly = false,
  onFocusOnlyChange,
  conversationId,
}: {
  messages: Message[];
  busy: boolean;
  onSend: (
    text: string,
    opts?: {
      mode?: ComposerMode;
      attachments?: Attachment[];
      choice?: ChoiceAnswer;
      /** With `choice`: id of the assistant message whose clarifying question
       *  is being answered, so the run resumes on that message. */
      resumeId?: string;
    },
  ) => void;
  /** Abort the in-flight run, keeping what has streamed so far. */
  onStop?: () => void;
  onNewChat: () => void;
  sessionId: string;
  matter: MatterScope | null;
  onMatterChange?: (m: MatterScope | null) => void;
  selectedDocs?: SelectedDoc[];
  onDocsChange?: (docs: SelectedDoc[]) => void;
  focusOnly?: boolean;
  onFocusOnlyChange?: (v: boolean) => void;
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
  const lastUser = useMemo(() => [...messages].reverse().find((m) => m.role === "user"), [messages]);
  const lastUserId = lastUser?.id;
  // Composer nudge from context already here (matter label, the last
  // question's subject); recomputed when a turn lands, never repeated back to
  // back, and it rotates every couple of days. Pure helper, no storage.
  const previousPlaceholderRef = useRef<string | null>(null);
  const placeholder = useMemo(() => {
    const next = composerPlaceholder({
      matterLabel: matter?.label ?? null,
      lastQuestion: lastUser?.text ?? null,
      turnCount: messages.filter((m) => m.role === "user").length,
      previous: previousPlaceholderRef.current,
    });
    previousPlaceholderRef.current = next;
    return next;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new turn or matter should change the nudge
  }, [matter?.label, lastUser?.id]);
  const { allSources, sourcesByRef } = useSourceIndex(messages);
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
      if (m.role !== "assistant") continue;
      for (const ref of citedRefsIn(m.answer)) set.add(ref);
    }
    return set;
  }, [messages]);
  // The rail's "This answer" scope. The server re-seeds every turn with the
  // carried sources, so the latest message's `sources` is close to the whole
  // thread; what is specific to this turn is what its answer cites plus what
  // was retrieved for the first time on it.
  const turnSources = useMemo(() => {
    if (!lastAssistant) return undefined;
    const earlier = new Set<string>();
    for (const m of messages) {
      if (m === lastAssistant) break;
      for (const s of m.sources ?? []) earlier.add(s.ref.toUpperCase());
    }
    const cited = citedRefsIn(lastAssistant.answer);
    return (lastAssistant.sources ?? []).filter((s) => {
      const ref = s.ref.toUpperCase();
      return cited.has(ref) || !earlier.has(ref);
    });
  }, [messages, lastAssistant]);

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
              <div className="mx-auto w-full max-w-[880px]">
                {messages.map((m, i) => {
                  if (m.role === "user") {
                    return <UserMessage key={m.id} msg={m} />;
                  }
                  const question =
                    [...messages.slice(0, i)]
                      .reverse()
                      .find((p) => p.role === "user")?.text ?? "";
                  return (
                    <AssistantMessage
                      key={m.id}
                      msg={m}
                      onCite={(ref) => handleCite(ref, m)}
                      selectedRef={selectedRef}
                      sourcesByRef={sourcesByRef}
                      question={question}
                      matter={matter}
                      conversationId={conversationId}
                      onWorkspaceChange={() => setRailKey((k) => k + 1)}
                      onChoice={(answer) => {
                        // Resume on THIS message (not whichever panel happens
                        // to be the last unanswered one), with its own question.
                        if (question.trim()) {
                          onSend(question, { choice: answer, resumeId: m.id });
                        }
                      }}
                    />
                  );
                })}

                {!lastBusy && lastFollowups.length > 0 && (
                  <div className="mb-4">
                    <div className="mb-2.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                      Suggested follow-ups
                    </div>
                    <div className="grid grid-cols-1 gap-2 md:grid-cols-3 md:gap-2.5">
                      {lastFollowups.map((f, i) => (
                        <button
                          key={`${i}-${f}`}
                          onClick={() => onSend(f)}
                          title={f}
                          className="group flex h-full items-start gap-2 rounded-lg border border-border bg-card px-3 py-2.5 text-left transition-colors hover:border-primary/30 hover:bg-muted/40"
                        >
                          <span className="line-clamp-3 flex-1 text-[12.5px] leading-snug text-foreground">
                            {f}
                          </span>
                          <ArrowRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-navy/0 transition-colors group-hover:text-brand-navy/60" />
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
                onStop={onStop}
                onNewChat={onNewChat}
                textareaRef={composerRef}
                matter={matter}
                onMatterChange={onMatterChange}
                selectedDocs={selectedDocs}
                onDocsChange={onDocsChange}
                focusOnly={focusOnly}
                onFocusOnlyChange={onFocusOnlyChange}
                placeholder={placeholder}
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
            turnSources={turnSources}
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
                  turnSources={turnSources}
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
  onStop,
  onNewChat,
  textareaRef,
  matter = null,
  onMatterChange,
  selectedDocs = [],
  onDocsChange,
  focusOnly = false,
  onFocusOnlyChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string, opts: { mode: ComposerMode; attachments: Attachment[] }) => void;
  busy: boolean;
  onStop?: () => void;
  onNewChat: () => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  matter?: MatterScope | null;
  onMatterChange?: (m: MatterScope | null) => void;
  selectedDocs?: SelectedDoc[];
  onDocsChange?: (docs: SelectedDoc[]) => void;
  focusOnly?: boolean;
  onFocusOnlyChange?: (v: boolean) => void;
  /** context-aware nudge from the parent (composerPlaceholder); falls back to the classic prompt */
  placeholder?: string;
}) {
  const [mode, setModeRaw] = useState<ComposerMode>(initialMode);
  const setMode = useCallback((m: ComposerMode) => {
    setModeRaw(m);
    persistMode(m);
  }, []);
  const { files, uploading, uploadError, handleFiles, removeFile } = useUploads();
  const [skill, setSkill] = useState<ResearchSkill | null>(null);

  const submit = useCallback(
    (v: string) => {
      if (!v.trim() || busy || slashSkillPending(v)) return;
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
      <SlashPalette
        value={value}
        onPick={(s) => {
          onChange("");
          setSkill(s);
        }}
      />
      {matter && (
        <div className="flex justify-end px-2.5 pt-2">
          <MatterChip
            matter={matter}
            onClear={
              onMatterChange
                ? () => {
                    onMatterChange(null);
                    onDocsChange?.([]);
                    onFocusOnlyChange?.(false);
                  }
                : undefined
            }
          />
        </div>
      )}
      {skill ? (
        <div className="border-b border-border/60 p-2">
          <SkillForm
            skill={skill}
            onCancel={() => setSkill(null)}
            onRun={(prompt) => {
              setSkill(null);
              onSubmit(prompt, { mode, attachments: files });
            }}
          />
        </div>
      ) : null}
      <FileChips files={files} onRemove={removeFile} className="px-2.5 pt-2" />
      <div className="px-2.5 pt-2">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.defaultPrevented) return;
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit(value);
            }
          }}
          rows={1}
          placeholder={busy ? "Type your next question…" : placeholder || "Ask a follow-up about MDLs, bellwethers, or precedent…"}
          className="block max-h-[220px] min-h-[44px] w-full resize-none bg-transparent px-1.5 py-1.5 text-[14px] leading-[1.55] placeholder:text-muted-foreground/80 focus:outline-none"
        />
      </div>
      <div className="mt-1 flex items-center justify-between gap-1 border-t border-border/60 px-2 py-1.5">
        <div className="flex items-center gap-1">
          {onMatterChange && (
            <ComposerScope
              matter={matter}
              onMatterChange={onMatterChange}
              selectedDocs={selectedDocs}
              onDocsChange={onDocsChange ?? (() => {})}
              focusOnly={focusOnly}
              onFocusOnlyChange={onFocusOnlyChange ?? (() => {})}
              uploads={files}
              disabled={busy}
            />
          )}
          <ModeDropdown mode={mode} onChange={setMode} disabled={busy} />
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
        </div>
        <div className="flex items-center gap-1">
          <UploadButton onFiles={handleFiles} uploading={uploading} disabled={busy} />
          <MicButton
            onTranscript={(t) => onChange(value.trim() ? `${value.trim()} ${t}` : t)}
            disabled={busy}
          />
          {busy && onStop ? (
            <button
              type="button"
              onClick={onStop}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-brand-navy text-white shadow-sm transition-all duration-200 hover:bg-brand-navy/90"
              aria-label="Stop"
              title="Stop (keeps what has been written so far)"
            >
              <Square className="h-[12px] w-[12px]" strokeWidth={2.4} fill="currentColor" />
            </button>
          ) : (
            <button
              type="submit"
              disabled={busy || !value.trim() || slashSkillPending(value)}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-brand-navy text-white shadow-sm transition-all duration-200 hover:bg-brand-navy/90 disabled:opacity-40"
              aria-label="Send"
            >
              <ArrowUp className="h-[16px] w-[16px]" strokeWidth={2.4} />
            </button>
          )}
        </div>
      </div>
      {uploadError && (
        <div className="pb-2 text-center text-[11px] text-destructive">
          {uploadError}
        </div>
      )}
    </form>
  );
}

/** Placeholder for the gap between the research finishing and the first
 *  answer token (the model's hidden synthesis thinking), so the page moves
 *  instead of sitting still. */
function ComposingSkeleton() {
  return (
    <div className="mt-1 space-y-2.5" aria-hidden="true">
      <div className="wr-skeleton h-[13px] w-[92%] rounded" />
      <div className="wr-skeleton h-[13px] w-[97%] rounded" />
      <div className="wr-skeleton h-[13px] w-[78%] rounded" />
      <div className="wr-skeleton mt-4 h-[13px] w-[60%] rounded" />
    </div>
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
  sourcesByRef,
  question,
  matter,
  conversationId,
  onWorkspaceChange,
  onChoice,
}: {
  msg: Message;
  onCite: (ref: string) => void;
  selectedRef: string | null;
  sourcesByRef: Record<string, Source>;
  question: string;
  matter: MatterScope | null;
  conversationId: string | null;
  onWorkspaceChange: () => void;
  onChoice: (answer: ChoiceAnswer) => void;
}) {
  const composing = msg.status === "writing" && !msg.answer.trim();

  return (
    <div className="mb-3">
      <ActivityPanel msg={msg} />
      {msg.choice ? (
        <StructuredChoicePanel
          request={msg.choice}
          disabled={
            Boolean(msg.choice.answered) ||
            Boolean(msg.choice.dismissed) ||
            msg.status === "thinking" ||
            msg.status === "writing"
          }
          onSelect={(answer) => onChoice(answer)}
        />
      ) : null}
      <div className="prose prose-neutral max-w-none text-foreground [&_code]:break-all [&_pre]:whitespace-pre-wrap">
        {composing && <ComposingSkeleton />}
        <AnswerMarkdown
          text={msg.answer}
          onCite={onCite}
          selectedRef={selectedRef}
          sourcesByRef={sourcesByRef}
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
