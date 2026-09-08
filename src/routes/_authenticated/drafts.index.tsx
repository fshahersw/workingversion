import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { FilePlus2, FileUp, Loader2, PenLine, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { AppShell } from "@/components/app-shell";
import {
  attachDraftSourceFn,
  createDraftFn,
  deleteDraftFn,
  listDraftsFn,
} from "@/lib/drafts/drafts.functions";
import { stashDraftImport } from "@/lib/drafts/import";
import type { DraftSummary } from "@/lib/drafts/types";

export const Route = createFileRoute("/_authenticated/drafts/")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Drafts — Seeger Weiss" },
      {
        name: "description",
        content: "Draft memoranda and documents with the research assistant.",
      },
    ],
  }),
  component: DraftsPage,
});

const MAX_IMPORT_BYTES = 30 * 1024 * 1024;

function DraftsPage() {
  const navigate = useNavigate();
  const [drafts, setDrafts] = useState<DraftSummary[] | null>(null);
  const [busy, setBusy] = useState<"new" | "import" | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setDrafts(await listDraftsFn({ data: { kind: "word" } }));
    } catch {
      setDrafts([]);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const open = (draftId: string) => void navigate({ to: "/drafts/$draftId", params: { draftId } });

  const createNew = async () => {
    setBusy("new");
    try {
      const d = await createDraftFn({ data: { kind: "word" } });
      open(d.draftId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create a document");
      setBusy(null);
    }
  };

  const importFile = async (file: File) => {
    if (!/\.docx$/i.test(file.name)) {
      toast.error("Choose a Word file (.docx).");
      return;
    }
    if (file.size > MAX_IMPORT_BYTES) {
      toast.error("That file is over 30 MB.");
      return;
    }
    setBusy("import");
    try {
      const buf = await file.arrayBuffer();
      const mammoth = await import("mammoth/mammoth.browser");
      const { value: html } = await mammoth.convertToHtml({ arrayBuffer: buf });
      const title =
        file.name
          .replace(/\.docx$/i, "")
          .replace(/[_-]+/g, " ")
          .trim() || "Imported document";
      const d = await createDraftFn({ data: { kind: "word", title } });
      // Keep the original with the draft (download later); the editor page
      // picks the converted HTML up from the stash and saves it as content.
      const base64 = bytesToBase64(new Uint8Array(buf));
      await attachDraftSourceFn({
        data: { draftId: d.draftId, name: file.name, ext: "docx", base64 },
      }).catch(() => undefined);
      stashDraftImport(d.draftId, html);
      open(d.draftId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not import that file");
      setBusy(null);
    }
  };

  const remove = async (draftId: string) => {
    setDeleting(draftId);
    try {
      await deleteDraftFn({ data: { draftId } });
      setDrafts((list) => (list ? list.filter((d) => d.draftId !== draftId) : list));
      toast.success("Draft deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete the draft");
    } finally {
      setDeleting(null);
    }
  };

  return (
    <AppShell>
      <div className="mx-auto flex h-full w-full max-w-[900px] flex-col px-4 py-6 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-[19px] font-semibold tracking-[-0.01em] text-foreground">Drafts</h1>
            <p className="mt-1 text-[12.5px] text-muted-foreground">
              Memoranda, letters and reports, written with the research assistant at your side.
              Saved to your account as you type; export to Word or PDF when ready.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void importFile(f);
              }}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={busy !== null}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-card px-3 text-[12.5px] font-medium text-foreground transition-colors hover:bg-muted/60 disabled:opacity-50"
            >
              {busy === "import" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <FileUp className="h-3.5 w-3.5" strokeWidth={1.9} />
              )}
              Import Word file
            </button>
            <button
              type="button"
              onClick={() => void createNew()}
              disabled={busy !== null}
              className="inline-flex h-9 items-center gap-1.5 rounded-md bg-brand-navy px-3 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {busy === "new" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <FilePlus2 className="h-3.5 w-3.5" strokeWidth={1.9} />
              )}
              New document
            </button>
          </div>
        </div>

        <div className="wr-app-scroll mt-5 min-h-0 flex-1 overflow-y-auto">
          {drafts === null ? (
            <div className="flex items-center gap-2 px-1 py-6 text-[12.5px] text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
            </div>
          ) : drafts.length === 0 ? (
            <EmptyDrafts onNew={() => void createNew()} onImport={() => fileRef.current?.click()} />
          ) : (
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {drafts.map((d) => (
                <li
                  key={d.draftId}
                  className="group flex items-start gap-3 rounded-lg border border-border/70 bg-card px-3.5 py-3 transition-colors hover:border-brand-navy/30"
                >
                  <button
                    type="button"
                    onClick={() => open(d.draftId)}
                    className="flex min-w-0 flex-1 items-start gap-3 text-left"
                  >
                    <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md bg-brand-blue-soft/70 text-brand-navy">
                      <PenLine className="h-4 w-4" strokeWidth={1.9} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] font-medium text-foreground">
                        {d.title}
                      </span>
                      <span className="mt-0.5 block text-[11.5px] text-muted-foreground">
                        {d.wordCount.toLocaleString()} words · {styleLabel(d.style)} · edited{" "}
                        {relative(d.updatedAt)}
                      </span>
                      {d.sourceName ? (
                        <span className="mt-0.5 block truncate text-[11px] text-muted-foreground/80">
                          Imported from {d.sourceName}
                        </span>
                      ) : null}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove(d.draftId)}
                    disabled={deleting === d.draftId}
                    aria-label="Delete draft"
                    className="mt-0.5 shrink-0 text-muted-foreground/50 opacity-0 transition hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100 disabled:opacity-50"
                  >
                    {deleting === d.draftId ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </AppShell>
  );
}

function EmptyDrafts({ onNew, onImport }: { onNew: () => void; onImport: () => void }) {
  return (
    <div className="rounded-lg border border-dashed border-border bg-card/60 px-6 py-10 text-center">
      <div className="mx-auto grid h-11 w-11 place-items-center rounded-full bg-brand-blue-soft text-brand-navy">
        <PenLine className="h-5 w-5" strokeWidth={1.9} />
      </div>
      <h2 className="mt-3 text-[14px] font-semibold text-foreground">No drafts yet</h2>
      <p className="mx-auto mt-1 max-w-md text-[12.5px] text-muted-foreground">
        Start a blank document, or import a Word file to keep working on it here with the assistant.
        Everything saves to your account automatically.
      </p>
      <div className="mt-4 flex justify-center gap-2">
        <button
          type="button"
          onClick={onImport}
          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-card px-3 text-[12.5px] font-medium hover:bg-muted/60"
        >
          <FileUp className="h-3.5 w-3.5" strokeWidth={1.9} /> Import Word file
        </button>
        <button
          type="button"
          onClick={onNew}
          className="inline-flex h-9 items-center gap-1.5 rounded-md bg-brand-navy px-3 text-[12.5px] font-medium text-white hover:opacity-90"
        >
          <FilePlus2 className="h-3.5 w-3.5" strokeWidth={1.9} /> New document
        </button>
      </div>
    </div>
  );
}

function styleLabel(style: DraftSummary["style"]): string {
  return style === "modern" ? "Modern" : style === "minimal" ? "Minimal" : "Legal";
}

function relative(iso: string): string {
  if (!iso) return "";
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
