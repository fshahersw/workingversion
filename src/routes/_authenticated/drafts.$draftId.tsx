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
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { AppShell } from "@/components/app-shell";
import { DraftEditor } from "@/components/drafts/DraftEditor";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { takeDraftImport } from "@/lib/drafts/import";
import { DRAFT_STYLES, type DraftStyle } from "@/lib/drafts/types";
import { useDraft, type SaveState } from "@/lib/drafts/use-draft";

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

function DraftPage() {
  const { draftId } = Route.useParams();
  const {
    draft,
    loadError,
    saveState,
    wordCount,
    exporting,
    reload,
    onChange,
    setTitle,
    setStyle,
    exportAs,
    saveNow,
  } = useDraft(draftId);
  const editorRef = useRef<Editor | null>(null);
  const [titleDraft, setTitleDraft] = useState<string | null>(null);

  // An import hand-off (Drafts page converted a DOCX) lands here once the
  // editor exists: set the HTML as content and let autosave persist it.
  const onReady = useCallback(
    (editor: Editor) => {
      editorRef.current = editor;
      const html = takeDraftImport(draftId);
      if (html) {
        editor.commands.setContent(html, { contentType: "html" });
        onChange(editor.getJSON() as never, editor.getText({ blockSeparator: "\n" }));
      }
    },
    [draftId, onChange],
  );

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
          <SaveIndicator state={saveState} words={wordCount} onReload={reload} />
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
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-brand-navy px-2.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
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
        </header>

        <div className="min-h-0 flex-1">
          {draft ? (
            <DraftEditor
              key={draft.draftId}
              initialDoc={draft.content?.doc ?? null}
              style={draft.style}
              readOnly={saveState === "conflict"}
              onChange={onChange}
              onReady={onReady}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-[12.5px] text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Opening…
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}

function SaveIndicator({
  state,
  words,
  onReload,
}: {
  state: SaveState;
  words: number;
  onReload: () => void;
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
            <button
              type="button"
              onClick={onReload}
              className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10.5px] font-medium text-foreground hover:bg-muted"
            >
              <RefreshCw className="h-3 w-3" /> Reload
            </button>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}
