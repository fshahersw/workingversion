import { createFileRoute } from "@tanstack/react-router";
import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowUp,
  BadgeCheck,
  BookOpen,
  Briefcase,
  CalendarClock,
  FileCheck,
  Flag,
  HeartHandshake,
  Loader2,
  Lock,
  Mic,
  Scale,
  Shuffle,
  ShieldCheck,
  Square,
  Users,
} from "lucide-react";


import { AppShell } from "@/components/app-shell";
import { ChatView } from "@/components/chat/ChatView";
import { ConversationHistory } from "@/components/chat/ConversationHistory";
import { MatterScopePicker } from "@/components/matters/MatterScopePicker";
import type { MatterScope } from "@/lib/chat-types";
import { useChat } from "@/lib/use-chat";
import { useDictation } from "@/lib/use-dictation";
import {
  fetchPromptSuggestions,
  SW_PROMPT_SUGGESTIONS,
  type PromptSuggestion,
} from "@/lib/orchestrate";

export const Route = createFileRoute("/_authenticated/research")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Research — Seeger Weiss" },
      {
        name: "description",
        content:
          "Multi-agent litigation research for MDLs, causation science, regulatory actions, and precedent — every answer cited.",
      },
      { property: "og:title", content: "Research — Seeger Weiss" },
      {
        property: "og:description",
        content:
          "Multi-agent litigation research for MDLs, causation science, regulatory actions, and precedent — every answer cited.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ResearchPage,
});

const CATEGORY_META: Record<
  string,
  { icon: typeof BookOpen; tone: "blue" | "orange" }
> = {
  mdl: { icon: Scale, tone: "blue" },
  product_liability: { icon: ShieldCheck, tone: "blue" },
  pharma: { icon: HeartHandshake, tone: "orange" },
  device: { icon: FileCheck, tone: "blue" },
  environmental: { icon: Flag, tone: "orange" },
  settlement: { icon: Briefcase, tone: "blue" },
  discovery: { icon: BookOpen, tone: "blue" },
  causation: { icon: BadgeCheck, tone: "blue" },
  class_action: { icon: Users, tone: "orange" },
  regulatory: { icon: CalendarClock, tone: "orange" },
};

const FALLBACK_SUGGESTIONS: PromptSuggestion[] = SW_PROMPT_SUGGESTIONS;

function pickFour(
  pool: PromptSuggestion[],
  avoid: PromptSuggestion[] = [],
): PromptSuggestion[] {
  if (pool.length <= 4) return pool.slice(0, 4);
  const avoidSet = new Set(avoid.map((s) => s.text));
  const preferred = pool.filter((s) => !avoidSet.has(s.text));
  const base = preferred.length >= 4 ? preferred : pool;
  const shuffled = [...base].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, 4);
}

function getSessionId() {
  if (typeof window === "undefined") return "ssr";
  const KEY = "sw.session_id";
  let id = window.sessionStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    window.sessionStorage.setItem(KEY, id);
  }
  return id;
}

function ResearchPage() {
  const sessionId = useMemo(() => getSessionId(), []);
  const { messages, send, busy, reset, open, conversationId } =
    useChat(sessionId);
  const inChat = messages.length > 0;
  const [prefill, setPrefill] = useState("");
  const [matter, setMatter] = useState<MatterScope | null>(null);

  const openConversation = useCallback(
    async (id: string) => {
      const loaded = await open(id);
      if (loaded) setMatter(loaded.matter);
    },
    [open],
  );

  const sendScoped = useCallback(
    (text: string) => send(text, matter),
    [send, matter],
  );

  // Open a conversation handed off from the Library page (sessionStorage key set
  // there, then a navigate to /research). Runs once on mount.
  useEffect(() => {
    try {
      const openId = sessionStorage.getItem("sw:open-conversation");
      if (openId) {
        sessionStorage.removeItem("sw:open-conversation");
        void openConversation(openId);
      }
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pick up a seeded prompt from the Home dashboard's Quick Start tiles,
  // or a matter-scoped question that should only prefill (not auto-send).
  useEffect(() => {
    if (inChat || busy) return;
    try {
      const fill = sessionStorage.getItem("sw:prefill-prompt");
      if (fill) {
        sessionStorage.removeItem("sw:prefill-prompt");
        setPrefill(fill);
        return;
      }
      const seed = sessionStorage.getItem("sw:initial-prompt");
      if (seed) {
        sessionStorage.removeItem("sw:initial-prompt");
        send(seed);
      }
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <AppShell showHeaderLogo={inChat}>
      <AnimatePresence mode="wait">
        {!inChat ? (
          <motion.main
            key="hero"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.4 }}
            className="flex h-full w-full items-center justify-center overflow-y-auto px-4 py-6 sm:px-6"
          >
            <div className="mx-auto flex w-full max-w-[680px] flex-col items-center">
              <div className="w-full">
                <HeroComposer
                  onSubmit={sendScoped}
                  disabled={busy}
                  initialValue={prefill}
                  matter={matter}
                  onMatterChange={setMatter}
                  onOpenConversation={openConversation}
                />
              </div>

              <div className="mt-6 w-full">
                <StarterSuggestions onPick={sendScoped} />
              </div>

              <div className="mt-5 flex items-center gap-2 text-[11px] text-muted-foreground">
                <Lock className="h-3 w-3" strokeWidth={2} />
                <span>Your data is secure and confidential.</span>
                <span className="text-muted-foreground/60">·</span>
                <span>Legal research, not legal advice.</span>
              </div>
            </div>
          </motion.main>
        ) : (
          <motion.div
            key="chat"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35 }}
            className="h-full min-h-0"
          >
            <ChatView
              messages={messages}
              busy={busy}
              onSend={sendScoped}
              onNewChat={reset}
              sessionId={sessionId}
              matter={matter}
              onMatterChange={setMatter}
              onOpenConversation={openConversation}
              conversationId={conversationId}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </AppShell>
  );
}

function HeroComposer({
  onSubmit,
  disabled,
  initialValue = "",
  matter,
  onMatterChange,
  onOpenConversation,
}: {
  onSubmit: (t: string) => void;
  disabled: boolean;
  initialValue?: string;
  matter: MatterScope | null;
  onMatterChange: (m: MatterScope | null) => void;
  onOpenConversation: (id: string) => void;
}) {
  const [v, setV] = useState(initialValue);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (initialValue) setV(initialValue);
  }, [initialValue]);

  const dictation = useDictation((text) => {
    const sep = v && !v.endsWith(" ") ? " " : "";
    const next = v + sep + text;
    setV(next);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (el) {
        el.focus();
        el.setSelectionRange(next.length, next.length);
      }
    });
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, [v]);

  function submit() {
    if (!v.trim() || disabled) return;
    onSubmit(v.trim());
    setV("");
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="w-full"
    >
      <div className="rounded-lg border border-border bg-card shadow-sm transition-all focus-within:border-primary/40 focus-within:shadow-md">
        <div className="flex items-end gap-2 px-3 pt-2.5">
          <textarea
            ref={ref}
            autoFocus
            value={v}
            onChange={(e) => setV(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={2}
            placeholder={
              dictation.isRecording
                ? "Listening…"
                : dictation.isTranscribing
                  ? "Transcribing…"
                  : "Ask about MDLs, bellwethers, causation experts, recalls, or settlements…"
            }
            className="block max-h-[200px] min-h-[52px] w-full resize-none bg-transparent px-1 py-1.5 text-[15px] leading-[1.5] text-foreground placeholder:text-muted-foreground/80 focus:outline-none"
          />
          <button
            type="submit"
            disabled={disabled || !v.trim()}
            aria-label="Send"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-brand-navy text-white shadow-sm transition-all hover:bg-brand-navy/90 disabled:opacity-40"
          >
            <ArrowUp className="h-[17px] w-[17px]" strokeWidth={2.4} />
          </button>
        </div>
        <div className="mt-1.5 flex items-center gap-1 border-t border-border/60 px-2 py-1.5">
          <MatterScopePicker
            value={matter}
            onChange={onMatterChange}
            disabled={disabled}
          />
          <span className="mx-0.5 h-4 w-px bg-border/70" />
          <button
            type="button"
            onClick={dictation.toggle}
            disabled={dictation.isTranscribing}
            aria-label={
              dictation.isRecording ? "Stop dictation" : "Start dictation"
            }
            title={dictation.isRecording ? "Stop dictation" : "Start dictation"}
            className={[
              "relative grid h-8 w-8 place-items-center rounded-md transition-colors",
              dictation.isRecording
                ? "bg-red-50 text-red-600 hover:bg-red-100"
                : "text-muted-foreground hover:bg-muted hover:text-brand-navy",
              dictation.isTranscribing ? "opacity-60" : "",
            ].join(" ")}
          >
            {dictation.isTranscribing ? (
              <Loader2 className="h-[15px] w-[15px] animate-spin" />
            ) : dictation.isRecording ? (
              <>
                <Square className="h-[12px] w-[12px] fill-current" strokeWidth={0} />
                <span className="pointer-events-none absolute right-1.5 top-1.5 h-1.5 w-1.5 animate-ping rounded-full bg-red-500" />
              </>
            ) : (
              <Mic className="h-[15px] w-[15px]" strokeWidth={1.85} />
            )}
          </button>
          <ConversationHistory activeId={null} onOpen={onOpenConversation} />
          <span className="ml-auto hidden text-[10.5px] text-muted-foreground/70 sm:block">
            Enter to send · Shift+Enter for a new line
          </span>
        </div>
        {dictation.error && (
          <div className="px-3 pb-2 text-center text-[11px] text-destructive">
            {dictation.error}
          </div>
        )}
      </div>
    </form>
  );
}

function StarterSuggestions({ onPick }: { onPick: (text: string) => void }) {
  const [pool, setPool] = useState<PromptSuggestion[]>([]);
  const [shown, setShown] = useState<PromptSuggestion[]>(FALLBACK_SUGGESTIONS.slice(0, 4));
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchPromptSuggestions().then((rows) => {
      if (cancelled) return;
      const effective = rows.length > 0 ? rows : FALLBACK_SUGGESTIONS;
      setPool(effective);
      setShown(pickFour(effective));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function shuffle() {
    const source = pool.length > 0 ? pool : FALLBACK_SUGGESTIONS;
    setShown((prev) => pickFour(source, prev));
    setNonce((n) => n + 1);
  }

  return (
    <div className="w-full max-w-2xl">
      <div className="mb-2.5 flex items-center justify-between px-0.5">
        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Suggested research
        </p>
        <button
          type="button"
          onClick={shuffle}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:border-primary/30 hover:text-brand-navy"
        >
          <Shuffle className="h-3 w-3" strokeWidth={2} />
          Shuffle
        </button>
      </div>
      <AnimatePresence mode="wait">
        <motion.div
          key={nonce}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
          className="grid grid-cols-1 gap-2 sm:grid-cols-2"
        >
          {shown.map((s, i) => {
            const meta = CATEGORY_META[s.category] ?? {
              icon: BookOpen,
              tone: "blue" as const,
            };
            const Icon = meta.icon;
            return (
              <button
                key={`${nonce}-${i}-${s.text}`}
                type="button"
                onClick={() => onPick(s.text)}
                className="group flex h-[64px] items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 text-left transition-colors hover:border-primary/30 hover:bg-muted/40"
              >
                <span
                  className={[
                    "grid h-8 w-8 shrink-0 place-items-center rounded-md",
                    meta.tone === "orange"
                      ? "bg-brand-orange-soft text-brand-orange"
                      : "bg-brand-blue-soft text-primary",
                  ].join(" ")}
                >
                  <Icon className="h-[15px] w-[15px]" strokeWidth={2} />
                </span>
                <p className="line-clamp-2 min-w-0 flex-1 text-[12.5px] leading-snug text-brand-navy">
                  {s.text}
                </p>
                <ArrowRight className="h-3.5 w-3.5 shrink-0 text-brand-navy/0 transition-colors group-hover:text-brand-navy/60" />
              </button>
            );
          })}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
