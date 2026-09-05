import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  FileSpreadsheet,
  FileText,
  FileType2,
  Loader2,
  Presentation,
  UploadCloud,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { fileKind } from "@/lib/extract-text";
import { MAX_BYTES, MAX_FILES } from "@/lib/pile/limits";

const FOCUS_EXAMPLES = [
  "Causation experts and Daubert exposure",
  "Every deadline and hearing date",
  "Damages theories and settlement posture",
];

function bytes(n: number) {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

type Kind = ReturnType<typeof fileKind>;

function KindIcon({ kind }: { kind: Kind }) {
  const cls = "h-4 w-4 shrink-0";
  if (kind === "xlsx") return <FileSpreadsheet className={`${cls} text-emerald-600`} />;
  if (kind === "pptx") return <Presentation className={`${cls} text-brand-orange`} />;
  if (kind === "docx") return <FileType2 className={`${cls} text-sky-600`} />;
  if (kind === "txt") return <FileText className={`${cls} text-muted-foreground`} />;
  return <FileText className={`${cls} text-brand-navy/60`} />;
}

type Row = { file: File; kind: Kind; reason: string | null };

type AddResult = {
  added: number;
  alreadyPresent: number;
  unsupported: number;
  overFileLimit: number;
  overByteLimit: number;
};

export function DropPanel({
  onStart,
  busy,
}: {
  onStart: (files: File[], instructions: string) => void;
  busy: boolean;
}) {
  const [dragging, setDragging] = useState(false);
  const [picked, setPicked] = useState<File[]>([]);
  const [instructions, setInstructions] = useState("");
  const [focusOpen, setFocusOpen] = useState(true);
  const [lastAdd, setLastAdd] = useState<AddResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pickedRef = useRef<File[]>([]);
  useEffect(() => {
    pickedRef.current = picked;
  }, [picked]);

  const fileKey = useCallback((f: File) => `${f.name}:${f.size}:${f.lastModified}`, []);

  const rows: Row[] = useMemo(() => {
    return picked.map((file) => {
      const kind = fileKind(file);
      let reason: string | null = null;
      if (!kind) reason = "unsupported type";
      return { file, kind, reason };
    });
  }, [picked]);

  const usable = rows.filter((r) => !r.reason);
  const totalBytes = usable.reduce((n, r) => n + r.file.size, 0);
  const skipped = rows.length - usable.length;

  const mergeFiles = useCallback(
    (incoming: File[]) => {
      const prev = pickedRef.current;
      const existing = new Map(prev.map((f) => [fileKey(f), f]));
      const accepted: File[] = [...prev];
      let runningBytes = accepted.reduce((n, f) => n + f.size, 0);
      const result: AddResult = {
        added: 0,
        alreadyPresent: 0,
        unsupported: 0,
        overFileLimit: 0,
        overByteLimit: 0,
      };

      for (const file of incoming) {
        const kind = fileKind(file);
        if (!kind) {
          result.unsupported += 1;
          continue;
        }

        const key = fileKey(file);
        if (existing.has(key)) {
          result.alreadyPresent += 1;
          continue;
        }

        if (accepted.length >= MAX_FILES) {
          result.overFileLimit += 1;
          continue;
        }

        if (runningBytes + file.size > MAX_BYTES) {
          result.overByteLimit += 1;
          continue;
        }

        existing.set(key, file);
        accepted.push(file);
        runningBytes += file.size;
        result.added += 1;
      }

      setPicked(accepted);
      setLastAdd(result);
      // Clear the confirmation after a few seconds so it doesn't stale.
      window.setTimeout(() => setLastAdd((current) => (current === result ? null : current)), 5000);
    },
    [fileKey],
  );

  const handleFiles = useCallback(
    (list: FileList | null) => {
      if (!list || !list.length) return;
      mergeFiles(Array.from(list));
    },
    [mergeFiles],
  );

  const traverseEntry = async (entry: FileSystemEntry): Promise<File[]> => {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve) =>
        (entry as FileSystemFileEntry).file(resolve),
      );
      return [file];
    }
    if (entry.isDirectory) {
      const dirReader = (entry as FileSystemDirectoryEntry).createReader();
      const entries = await new Promise<FileSystemEntry[]>((resolve) =>
        dirReader.readEntries(resolve),
      );
      const nested = await Promise.all(entries.map(traverseEntry));
      return nested.flat();
    }
    return [];
  };

  const handleDrop = useCallback(
    async (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragging(false);
      if (!e.dataTransfer.items?.length) {
        handleFiles(e.dataTransfer.files);
        return;
      }
      const entries = Array.from(e.dataTransfer.items)
        .map((item) => item.webkitGetAsEntry())
        .filter(Boolean) as FileSystemEntry[];
      const files = (await Promise.all(entries.map(traverseEntry))).flat();
      mergeFiles(files);
    },
    [handleFiles, mergeFiles],
  );

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-[0_1px_2px_rgba(15,23,42,0.05),0_8px_24px_-16px_rgba(15,23,42,0.25)]">
      <div className="p-5">
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          className={`flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-8 text-center transition-colors duration-200 sm:flex-row sm:justify-between sm:text-left ${
            dragging
              ? "border-brand-orange/60 bg-brand-orange-soft/40"
              : "border-border bg-muted/25 hover:border-brand-navy/25"
          }`}
        >
          <input
            ref={inputRef}
            type="file"
            multiple
            accept=".pdf,.docx,.xlsx,.xlsm,.xls,.pptx,.pptm,.txt,.md"
            className="hidden"
            onChange={(e) => {
              handleFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-background text-brand-navy/45 ring-1 ring-border">
              <UploadCloud className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <p className="text-[14px] font-semibold text-foreground">
                Ask questions across a working set
              </p>
              <p className="mt-0.5 text-[11.5px] text-muted-foreground">
                Answers are cited to the page. PDF · Word · Excel · PowerPoint · text — up to{" "}
                {MAX_FILES} files and {bytes(MAX_BYTES)}. Kept on this device until you clear the
                session.
              </p>
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            className="h-9 shrink-0 rounded-lg text-[12.5px]"
            onClick={() => inputRef.current?.click()}
          >
            Browse files
          </Button>
        </div>

        {lastAdd &&
          (lastAdd.added > 0 || lastAdd.alreadyPresent > 0 || lastAdd.unsupported > 0) && (
            <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-border/70 bg-muted/20 px-3 py-2 text-[11.5px] text-muted-foreground">
              {lastAdd.added > 0 && (
                <span className="rounded-full bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                  Added {lastAdd.added} file{lastAdd.added === 1 ? "" : "s"}
                </span>
              )}
              {lastAdd.alreadyPresent > 0 && <span>{lastAdd.alreadyPresent} already selected</span>}
              {lastAdd.unsupported > 0 && <span>{lastAdd.unsupported} unsupported</span>}
              {lastAdd.overFileLimit > 0 && (
                <span className="text-destructive">
                  {lastAdd.overFileLimit} over the {MAX_FILES} file limit
                </span>
              )}
              {lastAdd.overByteLimit > 0 && (
                <span className="text-destructive">
                  {lastAdd.overByteLimit} over the {bytes(MAX_BYTES)} cap
                </span>
              )}
            </div>
          )}

        {rows.length > 0 && (
          <div className="mt-4 overflow-hidden rounded-xl border border-border/70">
            <div className="flex items-center justify-between border-b border-border/70 bg-muted/30 px-3 py-2">
              <span className="text-[11px] font-medium tabular-nums text-muted-foreground">
                {usable.length} file{usable.length === 1 ? "" : "s"} · {bytes(totalBytes)}
                {skipped ? ` · ${skipped} unsupported` : ""}
              </span>
              <button
                type="button"
                onClick={() => {
                  setPicked([]);
                  setLastAdd(null);
                }}
                className="text-[11px] font-medium text-muted-foreground transition hover:text-foreground"
              >
                Clear all
              </button>
            </div>
            <ul className="max-h-[15rem] divide-y divide-border/60 overflow-y-auto">
              {rows.map((r, i) => (
                <li
                  key={`${r.file.name}-${i}`}
                  className={`group flex items-center gap-3 px-3 py-2 ${
                    r.reason ? "bg-muted/25" : "bg-card"
                  }`}
                >
                  <KindIcon kind={r.kind} />
                  <span
                    className={`min-w-0 flex-1 truncate text-[12.5px] ${
                      r.reason ? "text-muted-foreground line-through" : "text-foreground"
                    }`}
                  >
                    {r.file.name}
                  </span>
                  {r.reason ? (
                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      {r.reason}
                    </span>
                  ) : (
                    <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                      {bytes(r.file.size)}
                    </span>
                  )}
                  <button
                    type="button"
                    aria-label={`Remove ${r.file.name}`}
                    onClick={() => setPicked((p) => p.filter((_, j) => j !== i))}
                    className="rounded-md p-1 text-muted-foreground opacity-0 transition hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-4 rounded-xl border border-border/70 bg-muted/20">
          <button
            type="button"
            onClick={() => setFocusOpen((v) => !v)}
            className="flex w-full items-center justify-between px-3 py-2.5 text-left"
          >
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-brand-navy/60">
              What should we pay attention to?{instructions.trim() ? " · set" : ""}
            </span>
            <ChevronDown
              className={`h-4 w-4 text-muted-foreground transition-transform ${focusOpen ? "rotate-180" : ""}`}
            />
          </button>
          {focusOpen && (
            <div className="border-t border-border/70 p-3">
              <Textarea
                id="summarize-focus"
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder="e.g. concentrate on causation experts and Daubert exposure"
                className="min-h-[64px] resize-none rounded-lg border-border/70 bg-card text-[13px] shadow-none"
              />
              <div className="mt-2 flex flex-wrap gap-1.5">
                {FOCUS_EXAMPLES.map((ex) => (
                  <button
                    key={ex}
                    type="button"
                    onClick={() => setInstructions(ex)}
                    className="rounded-full border border-border bg-card px-2.5 py-1 text-[10.5px] font-medium text-muted-foreground transition hover:border-brand-navy/25 hover:text-foreground"
                  >
                    {ex}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-border bg-muted/25 px-5 py-3.5">
        <span className="min-w-0 truncate text-[11.5px] text-muted-foreground">
          {usable.length
            ? `${usable.length} file${usable.length === 1 ? "" : "s"} · kept on this device, never uploaded`
            : "Nothing is uploaded to the server"}
        </span>
        <Button
          disabled={!usable.length || busy}
          onClick={() =>
            onStart(
              usable.map((r) => r.file),
              instructions,
            )
          }
          className="h-10 shrink-0 rounded-lg px-5 disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100"
        >
          {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          Open working set{usable.length ? ` · ${usable.length}` : ""}
        </Button>
      </div>
    </div>
  );
}
