import { createFileRoute, Link } from "@tanstack/react-router";
import type { Editor } from "@tiptap/react";
import {
  AlertCircle,
  ArrowLeft,
  Check,
  ChevronDown,
  Download,
  Loader2,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { AppShell } from "@/components/app-shell";
import { DraftAssistant } from "@/components/drafts/DraftAssistant";
import { DraftEditor } from "@/components/drafts/DraftEditor";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { DraftMode } from "@/lib/agents/draft-prompts";
import type { Message } from "@/lib/chat-types";
import { materialForDocument, nextReferenceNumber } from "@/lib/drafts/material";
import { DRAFT_STYLES, type DraftStyle } from "@/lib/drafts/types";
import { useDraft, type SaveState } from "@/lib/drafts/use-draft";
import { useDraftChat, type DraftDocumentSnapshot } from "@/lib/drafts/use-draft-chat";

export const Route = createFileRoute("/_authenticated/drafts/$draftId")({
  ssr: false,
  head: () => ({ meta: [{ title: "Draft — Seeger Weiss" }] }),
  component: DraftPage,
});

const STYLE_LABEL: Record<DraftStyle, string> = {
  legal: "Legal",
  modern: "Modern",
  minimal: "Minimal",
};
const ASSISTANT_STORAGE_KEY = "sw.draft.assistant";
const CONTEXT_CHARS = 1_200;

function DraftPage() {
  const { draftId } = Route.useParams();
  const {
    draft,
    loadError,
    saveState,
    wordCount,
    exporting,
    loadCount,
    reload,
    keepMine,
    onChange,
    setTitle,
    setStyle,
    exportAs,
    saveNow,
  } = useDraft(draftId);
  const editorRef = useRef<Editor | null>(null);
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [selectionText, setSelectionText] = useState("");
  const [assistantOpen, setAssistantOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem(ASSISTANT_STORAGE_KEY) !== "closed";
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(ASSISTANT_STORAGE_KEY, assistantOpen ? "open" : "closed");
    } catch {
      /* ignore */
    }
  }, [assistantOpen]);

  const chat = useDraftChat({
    draftId,
    draftTitle: draft?.title ?? "",
    ...(draft?.convId ? { convId: draft.convId } : {}),
  });

  const onReady = useCallback((editor: Editor) => {
    editorRef.current = editor;
  }, []);

  useEffect(() => {
    if (draft) document.title = `${draft.title} — Seeger Weiss`;
  }, [draft]);

  const commitTitle = () => {
    if (titleDraft === null || !draft) return;
    const next = titleDraft.trim() || "Untitled document";
    setTitleDraft(null);
    if (next !== draft.title) void setTitle(next);
  };

  const doExport = async (format: "docx" | "pdf") => {
    const editor = editorRef.current;
    if (!editor) return;
    await saveNow();
    await exportAs(format, editor.getMarkdown());
  };

  /** What the assistant sees: the document, the selection, the cursor context. */
  const snapshot = useCallback((): DraftDocumentSnapshot | null => {
    const editor = editorRef.current;
    if (!editor || !draft) return null;
    const { from, to, empty } = editor.state.selection;
    const doc = editor.state.doc;
    const text = editor.getText({ blockSeparator: "\n" });
    const selection = empty ? "" : doc.textBetween(from, to, "\n");
    const before = doc
      .textBetween(Math.max(1, from - CONTEXT_CHARS * 2), from, "\n")
      .slice(-CONTEXT_CHARS);
    const after = doc
      .textBetween(to, Math.min(doc.content.size, to + CONTEXT_CHARS * 2), "\n")
      .slice(0, CONTEXT_CHARS);
    return {
      title: draft.title,
      text,
      ...(selection ? { selection } : {}),
      before,
      after,
      style: draft.style,
    };
  }, [draft]);

  // The assistant's requests carry the selection they were made with, so the
  // reply can be applied even after the cursor moved.
  const requestSelection = useRef<{ from: number; to: number } | null>(null);

  const onSend = useCallback(
    (instruction: string, mode: DraftMode) => {
      const snap = snapshot();
      if (!snap) return;
      const editor = editorRef.current!;
      const { from, to, empty } = editor.state.selection;
      requestSelection.current = empty ? null : { from, to };
      void chat.send(instruction, mode, snap);
    },
    [chat, snapshot],
  );

  const onApply = useCallback(
    (message: Message, how: "insert" | "replace"): boolean => {
      const editor = editorRef.current;
      const material = message.proposal?.material;
      if (!editor || !material) return false;
      const startAt = nextReferenceNumber(editor.getText({ blockSeparator: "\n" }));
      const { markdown } = materialForDocument(material, message.sources ?? [], startAt);
      const chain = editor.chain().focus();
      if (how === "replace") {
        const sel = editor.state.selection;
        const range = !sel.empty
          ? { from: sel.from, to: sel.to }
          : requestSelection.current && requestSelection.current.to <= editor.state.doc.content.size
            ? requestSelection.current
            : null;
        if (!range) {
          toast.error("Select the passage to replace first.");
          return false;
        }
        chain
          .deleteRange(range)
          .insertContentAt(range.from, markdown, { contentType: "markdown" })
          .run();
      } else {
        chain.insertContent(markdown, { contentType: "markdown" }).run();
      }
      chat.markApplied(message.id);
      onChange(editor.getJSON() as never, editor.getText({ blockSeparator: "\n" }));
      return true;
    },
    [chat, onChange],
  );

  if (loadError) {
    return (
      <AppShell>
        <div className="mx-auto max-w-md px-6 py-16 text-center">
          <AlertCircle className="mx-auto h-6 w-6 text-destructive" />
          <p className="mt-3 text-[13.5px] text-foreground">{loadError}</p>
          <Link
            to="/drafts"
            className="mt-4 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-brand-navy hover:underline"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Back to Drafts
          </Link>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell showHeaderLogo>
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex shrink-0 items-center gap-2 border-b border-border/70 bg-card px-3 py-1.5">
          <Link
            to="/drafts"
            aria-label="Back to Drafts"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          {draft ? (
            <input
              value={titleDraft ?? draft.title}
              onChange={(e) => setTitleDraft(e.target.value)}
              onFocus={() => setTitleDraft(draft.title)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") {
                  setTitleDraft(null);
                  (e.target as HTMLInputElement).blur();
                }
              }}
              aria-label="Document title"
              className="h-8 min-w-0 flex-1 rounded-md bg-transparent px-2 text-[14px] font-semibold text-foreground focus:bg-muted/50 focus:outline-none"
            />
          ) : (
            <div className="h-8 flex-1" />
          )}
          <SaveIndicator
            state={saveState}
            words={wordCount}
            onReload={reload}
            onKeepMine={keepMine}
          />
          {draft ? (
            <select
              value={draft.style}
              onChange={(e) => void setStyle(e.target.value as DraftStyle)}
              aria-label="Document style"
              title="Document style (applies to the page and exports)"
              className="h-8 rounded-md border border-border/70 bg-background px-2 text-[12px] text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {DRAFT_STYLES.map((s) => (
                <option key={s} value={s}>
                  {STYLE_LABEL[s]} style
                </option>
              ))}
            </select>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                disabled={!draft || exporting !== null}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-[12px] font-medium text-foreground transition-colors hover:bg-muted/60 disabled:opacity-50"
              >
                {exporting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="h-3.5 w-3.5" strokeWidth={2} />
                )}
                Export
                <ChevronDown className="h-3 w-3 opacity-80" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[180px]">
              <DropdownMenuItem onSelect={() => void doExport("docx")}>
                Word document (.docx)
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void doExport("pdf")}>PDF</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {!assistantOpen ? (
            <button
              type="button"
              onClick={() => setAssistantOpen(true)}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-brand-navy px-2.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90"
            >
              <Sparkles className="h-3.5 w-3.5" strokeWidth={2} />
              Assistant
            </button>
          ) : null}
        </header>

        <div className="flex min-h-0 flex-1">
          <div className="min-h-0 min-w-0 flex-1">
            {draft ? (
              <DraftEditor
                key={`${draft.draftId}:${loadCount}`}
                initialDoc={draft.content?.doc ?? null}
                style={draft.style}
                readOnly={saveState === "conflict"}
                onChange={onChange}
                onReady={onReady}
                onSelection={setSelectionText}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-[12.5px] text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Opening…
              </div>
            )}
          </div>
          {assistantOpen && draft ? (
            <aside className="hidden h-full w-[400px] shrink-0 border-l border-border/70 lg:block xl:w-[440px]">
              <DraftAssistant
                messages={chat.messages}
                busy={chat.busy}
                ready={chat.ready}
                selectionText={selectionText}
                documentWords={wordCount}
                documentEmpty={wordCount === 0}
                onSend={onSend}
                onStop={chat.stop}
                onNewThread={() => void chat.reset()}
                onApply={onApply}
                onCollapse={() => setAssistantOpen(false)}
              />
            </aside>
          ) : null}
        </div>
      </div>
    </AppShell>
  );
}

function SaveIndicator({
  state,
  words,
  onReload,
  onKeepMine,
}: {
  state: SaveState;
  words: number;
  onReload: () => void;
  onKeepMine: () => void;
}) {
  const label =
    state === "saving"
      ? "Saving…"
      : state === "dirty"
        ? "Unsaved changes"
        : state === "saved"
          ? "Saved"
          : state === "error"
            ? "Save failed, retrying"
            : state === "conflict"
              ? "Saved elsewhere"
              : "";
  return (
    <div className="flex shrink-0 items-center gap-2 px-1 text-[11px] tabular-nums text-muted-foreground">
      <span>{words.toLocaleString()} words</span>
      {label ? (
        <span className="inline-flex items-center gap-1">
          <span className="text-muted-foreground/50">·</span>
          {state === "saving" ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : state === "saved" ? (
            <Check className="h-3 w-3 text-emerald-600" strokeWidth={2.5} />
          ) : state === "error" || state === "conflict" ? (
            <AlertCircle className="h-3 w-3 text-amber-600" />
          ) : null}
          <span className={state === "conflict" ? "text-amber-700" : ""}>{label}</span>
          {state === "conflict" ? (
            <>
              <button
                type="button"
                onClick={onReload}
                title="Discard this tab's changes and load the version saved elsewhere"
                className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10.5px] font-medium text-foreground hover:bg-muted"
              >
                <RefreshCw className="h-3 w-3" /> Take theirs
              </button>
              <button
                type="button"
                onClick={onKeepMine}
                title="Overwrite the version saved elsewhere with this tab's content"
                className="inline-flex items-center gap-1 rounded bg-brand-navy px-1.5 py-0.5 text-[10.5px] font-medium text-white hover:opacity-90"
              >
                Keep mine
              </button>
            </>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}
