import {
  AlertCircle,
  ArrowUp,
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  Loader2,
  Replace,
  Sparkles,
  Square,
  SquarePen,
  TextCursorInput,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { ActivityPanel } from "@/components/chat/ActivityPanel";
import { AnswerMarkdown } from "@/components/chat/AnswerMarkdown";
import type { DraftMode } from "@/lib/agents/draft-prompts";
import type { Message, Source } from "@/lib/chat-types";
import { splitMaterial, hasPartialMarker } from "@/lib/drafts/material";
import { draftStarters } from "@/lib/drafts/starters";

const MODES: { id: DraftMode; label: string; hint: string }[] = [
  { id: "write", label: "Write", hint: "Draft new material at the cursor or over the selection" },
  { id: "edit", label: "Edit", hint: "Rewrite the selected passage" },
  { id: "ask", label: "Ask", hint: "Answer a question; never edits the document" },
  { id: "review", label: "Review", hint: "Read-only critique of the document or selection" },
  { id: "research", label: "Research", hint: "Full research, written as document material" },
];

const MODE_STORAGE_KEY = "sw.draft.mode";

export type DraftAssistantProps = {
  messages: Message[];
  busy: boolean;
  ready: boolean;
  /** Current selection (plain text) and document word count, for the context line. */
  selectionText: string;
  documentWords: number;
  documentEmpty: boolean;
  onSend: (instruction: string, mode: DraftMode) => void;
  onStop: () => void;
  onNewThread: () => void;
  /** Apply material to the document. Returns false when it could not be applied. */
  onApply: (message: Message, how: "insert" | "replace") => boolean;
  onCollapse: () => void;
};

export function DraftAssistant({
  messages,
  busy,
  ready,
  selectionText,
  documentWords,
  documentEmpty,
  onSend,
  onStop,
  onNewThread,
  onApply,
  onCollapse,
}: DraftAssistantProps) {
  const [mode, setMode] = useState<DraftMode>(() => {
    if (typeof window === "undefined") return "write";
    const saved = window.localStorage.getItem(MODE_STORAGE_KEY);
    return MODES.some((m) => m.id === saved) ? (saved as DraftMode) : "write";
  });
  const [input, setInput] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(MODE_STORAGE_KEY, mode);
    } catch {
      /* ignore */
    }
  }, [mode]);

  const hasSelection = selectionText.trim().length > 0;
  const selectionWords = useMemo(
    () => (hasSelection ? selectionText.trim().split(/\s+/).length : 0),
    [hasSelection, selectionText],
  );
  const starters = useMemo(
    () => draftStarters(mode, hasSelection, documentEmpty),
    [mode, hasSelection, documentEmpty],
  );

  // Follow new content unless the reader scrolled up.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onScroll = () => {
      followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    const el = listRef.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const submit = useCallback(() => {
    const text = input.trim();
    if (busy) return;
    if (!text && mode !== "edit" && mode !== "review") return;
    if (mode === "edit" && !hasSelection) {
      toast.error("Select the passage to rewrite first.");
      return;
    }
    onSend(text, mode);
    setInput("");
  }, [busy, input, mode, hasSelection, onSend]);

  const last = messages[messages.length - 1];
  const lastBusy =
    last?.role === "assistant" && (last.status === "thinking" || last.status === "writing");

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div className="flex shrink-0 items-center gap-1 border-b border-border/70 bg-card px-2 py-1.5">
        <Sparkles className="ml-1 h-3.5 w-3.5 text-brand-orange" strokeWidth={2} />
        <span className="text-[12.5px] font-semibold text-foreground">Assistant</span>
        <span className="ml-auto" />
        <button
          type="button"
          onClick={onNewThread}
          disabled={busy || messages.length === 0}
          title="New thread"
          aria-label="New thread"
          className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
        >
          <SquarePen className="h-3.5 w-3.5" strokeWidth={1.9} />
        </button>
        <button
          type="button"
          onClick={onCollapse}
          title="Hide assistant"
          aria-label="Hide assistant"
          className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ChevronDown className="h-3.5 w-3.5 -rotate-90" strokeWidth={1.9} />
        </button>
      </div>

      <div className="flex shrink-0 items-center gap-0.5 border-b border-border/60 bg-card px-2 py-1">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => setMode(m.id)}
            title={m.hint}
            aria-pressed={mode === m.id}
            className={`h-7 rounded-md px-2 text-[11.5px] font-medium transition-colors ${
              mode === m.id
                ? "bg-brand-navy text-white"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div ref={listRef} className="wr-app-scroll min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {!ready ? (
          <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading the thread…
          </div>
        ) : messages.length === 0 ? (
          <Starters
            mode={mode}
            starters={starters}
            onPick={(prompt) => {
              setInput(prompt);
              textareaRef.current?.focus();
            }}
          />
        ) : (
          messages.map((m) =>
            m.role === "user" ? (
              <div key={m.id} className="mb-2 flex justify-end">
                <div className="max-w-[92%] rounded-lg rounded-br-sm bg-brand-navy px-3 py-1.5 text-[12.5px] leading-relaxed text-white">
                  {m.text}
                </div>
              </div>
            ) : (
              <AssistantTurn key={m.id} msg={m} onApply={onApply} hasSelection={hasSelection} />
            ),
          )
        )}
      </div>

      <div className="shrink-0 border-t border-border/70 bg-card px-2 pb-2 pt-1.5">
        <div className="mb-1 flex items-center gap-1.5 px-1 text-[10.5px] text-muted-foreground">
          <TextCursorInput className="h-3 w-3" strokeWidth={2} />
          {hasSelection
            ? `Selection · ${selectionWords} word${selectionWords === 1 ? "" : "s"}`
            : documentEmpty
              ? "Empty document"
              : `Whole document · ${documentWords.toLocaleString()} words · cursor`}
          {mode === "edit" && !hasSelection ? (
            <span className="text-amber-700">· select a passage to edit</span>
          ) : null}
        </div>
        <div className="flex items-end gap-1.5 rounded-md border border-border bg-background px-2 py-1.5 focus-within:border-primary/40">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={2}
            disabled={busy}
            placeholder={placeholderFor(mode, hasSelection)}
            className="max-h-[160px] min-h-[40px] w-full resize-none bg-transparent text-[12.5px] leading-[1.5] placeholder:text-muted-foreground/70 focus:outline-none"
          />
          {lastBusy ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop"
              title="Stop"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-border bg-card text-foreground hover:bg-muted"
            >
              <Square className="h-3.5 w-3.5" strokeWidth={2.2} />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={busy || (!input.trim() && mode !== "edit" && mode !== "review")}
              aria-label="Send"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-brand-navy text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              <ArrowUp className="h-4 w-4" strokeWidth={2.4} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function placeholderFor(mode: DraftMode, hasSelection: boolean): string {
  switch (mode) {
    case "write":
      return hasSelection ? "What should replace the selection?" : "What should I draft here?";
    case "edit":
      return hasSelection
        ? "How should I rewrite the selection? (Enter for a general improvement)"
        : "Select a passage, then say how to rewrite it";
    case "ask":
      return "Ask about the document or the law…";
    case "review":
      return "What should the review focus on? (Enter for a full pass)";
    case "research":
      return "What should I research for this document?";
  }
}

function Starters({
  mode,
  starters,
  onPick,
}: {
  mode: DraftMode;
  starters: { label: string; prompt: string }[];
  onPick: (prompt: string) => void;
}) {
  const meta = MODES.find((m) => m.id === mode)!;
  return (
    <div className="px-1 pt-2">
      <p className="text-[12px] leading-relaxed text-muted-foreground">{meta.hint}.</p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {starters.map((s) => (
          <button
            key={s.label}
            type="button"
            onClick={() => onPick(s.prompt)}
            title={s.prompt}
            className="rounded-md border border-border bg-card px-2 py-1 text-[11.5px] text-foreground transition-colors hover:border-brand-navy/30 hover:bg-muted/50"
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function AssistantTurn({
  msg,
  onApply,
  hasSelection,
}: {
  msg: Message;
  onApply: (message: Message, how: "insert" | "replace") => boolean;
  hasSelection: boolean;
}) {
  const streaming = msg.status === "writing";
  const settled = msg.status === "done" || msg.status === "error";
  // Split live so the material grows in its own card while streaming.
  const { note, material } = useMemo(() => splitMaterial(msg.answer), [msg.answer]);
  // A half-streamed marker ("<<<CON") must not flash in the note.
  const noteText = hasPartialMarker(msg.answer)
    ? note.replace(/<{1,3}[A-Z]*$/, "").trimEnd()
    : note;
  const finalMaterial = msg.proposal?.material ?? material;
  const target = msg.proposal?.target ?? (hasSelection ? "selection" : "cursor");
  const applied = Boolean(msg.proposal?.appliedAt);
  const quietStart =
    msg.status === "thinking" && msg.rounds.length === 0 && !(msg.thinking ?? "").trim();

  return (
    <div className="mb-3">
      {quietStart && (
        <div className="mb-2 flex h-[11px] items-center">
          <span className="h-[7px] w-[7px] animate-pulse rounded-full bg-brand-orange" />
        </div>
      )}
      <ActivityPanel msg={msg} />
      {noteText ? (
        <div className="text-[12.5px]">
          <AnswerMarkdown
            text={noteText}
            onCite={() => {}}
            streaming={streaming && !finalMaterial}
          />
        </div>
      ) : null}
      {finalMaterial ? (
        <div className="mt-2 overflow-hidden rounded-md border border-border/80 bg-card">
          <div className="flex items-center gap-2 border-b border-border/60 bg-surface px-2.5 py-1.5">
            <span className="text-[11px] font-medium text-foreground/80">
              {applied ? "Placed in the document" : streaming ? "Drafting…" : "Proposed material"}
            </span>
            <span className="ml-auto" />
            {!streaming && settled ? (
              <>
                <MaterialButton
                  icon={TextCursorInput}
                  label="Insert"
                  title="Insert at the cursor"
                  onClick={() => onApply(msg, "insert")}
                  primary={target === "cursor" && !applied}
                />
                <MaterialButton
                  icon={Replace}
                  label="Replace"
                  disabled={!hasSelection}
                  title={
                    hasSelection
                      ? "Replace the selected passage"
                      : "Select a passage in the document first"
                  }
                  onClick={() => onApply(msg, "replace")}
                  primary={target === "selection" && !applied && hasSelection}
                />
                <MaterialButton
                  icon={Copy}
                  label="Copy"
                  onClick={() => {
                    void navigator.clipboard.writeText(finalMaterial).then(
                      () => toast.success("Copied"),
                      () => toast.error("Could not copy"),
                    );
                  }}
                />
              </>
            ) : null}
            {applied ? <Check className="h-3.5 w-3.5 text-emerald-700" strokeWidth={2.5} /> : null}
          </div>
          <div className="wr-app-scroll max-h-[320px] overflow-y-auto px-3 py-2 text-[12.5px]">
            <AnswerMarkdown text={finalMaterial} onCite={() => {}} streaming={streaming} />
          </div>
        </div>
      ) : null}
      {msg.status === "error" ? (
        <div className="mt-2 flex items-start gap-2 text-[12px] text-red-600">
          <AlertCircle className="mt-[2px] h-3.5 w-3.5 shrink-0" />
          <span>{msg.error || "Something went wrong."}</span>
        </div>
      ) : null}
      {settled && msg.sources?.length ? <SourcesFold sources={msg.sources} /> : null}
      {msg.status === "done" && msg.verification && msg.verification.factsChecked > 0 ? (
        <p className="mt-1.5 text-[10.5px] text-muted-foreground/70">
          {msg.verification.factsVerified}/{msg.verification.factsChecked} specifics verified
          against sources
          {msg.verification.unverified.length + msg.verification.orphanRefs.length > 0
            ? ` · ${msg.verification.unverified.length + msg.verification.orphanRefs.length} to confirm`
            : ""}
        </p>
      ) : null}
    </div>
  );
}

function MaterialButton({
  icon: Icon,
  label,
  onClick,
  primary,
  disabled,
  title,
}: {
  icon: typeof Copy;
  label: string;
  onClick: () => void;
  primary?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title ?? label}
      className={`inline-flex h-6 items-center gap-1 rounded px-1.5 text-[10.5px] font-medium transition-colors disabled:opacity-40 ${
        primary
          ? "bg-brand-navy text-white hover:opacity-90"
          : "border border-border bg-card text-foreground hover:bg-muted"
      }`}
    >
      <Icon className="h-3 w-3" strokeWidth={2} />
      {label}
    </button>
  );
}

function SourcesFold({ sources }: { sources: Source[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-[10.5px] font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronDown className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} />
        {sources.length} source{sources.length === 1 ? "" : "s"}
      </button>
      {open ? (
        <ol className="mt-1 space-y-1 border-l border-border/70 pl-2.5">
          {sources.map((s) => (
            <li key={s.ref} className="text-[11px] leading-snug text-foreground/80">
              <span className="mr-1 tabular-nums text-muted-foreground/70">{s.ref}</span>
              {s.source_url ? (
                <a
                  href={s.source_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 hover:underline"
                >
                  {s.citation}
                  <ExternalLink className="h-2.5 w-2.5 shrink-0 opacity-60" />
                </a>
              ) : (
                s.citation
              )}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
