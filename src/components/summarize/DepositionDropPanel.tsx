import { useRef, useState } from "react";
import { FileText, Loader2, UploadCloud, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { DEP_MAX_BYTES, DEP_MAX_FILES, DEP_MAX_PAGES } from "@/lib/pile/limits";

function bytes(value: number): string {
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(value / 1024))} KB`;
}

function isTranscriptFile(file: File) {
  const n = file.name.toLowerCase();
  return (
    n.endsWith(".pdf") ||
    n.endsWith(".docx") ||
    n.endsWith(".txt") ||
    n.endsWith(".md") ||
    file.type === "application/pdf" ||
    file.type === "application/x-pdf" ||
    file.type.startsWith("text/")
  );
}

export function DepositionDropPanel({
  onStart,
  busy,
  files,
}: {
  onStart: (files: File[], instructions: string) => void;
  busy: boolean;
  files: { name: string; pages: number; done: number; status: string }[];
}) {
  const [dragging, setDragging] = useState(false);
  const [picked, setPicked] = useState<File[]>([]);
  const [instructions, setInstructions] = useState("");
  const [intakeError, setIntakeError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const add = (list: FileList | null) => {
    if (!list) return;
    const incoming = Array.from(list);
    // Computed against the current queue outside the updater so the updater
    // stays pure (React may invoke updaters twice in development).
    const next = [...picked];
    const keys = new Set(picked.map((file) => `${file.name}:${file.size}:${file.lastModified}`));
    let total = picked.reduce((sum, file) => sum + file.size, 0);
    let unsupported = 0;
    let rejected = 0;
    for (const file of incoming) {
      if (!isTranscriptFile(file)) {
        unsupported += 1;
        continue;
      }
      const key = `${file.name}:${file.size}:${file.lastModified}`;
      if (keys.has(key)) continue;
      if (next.length >= DEP_MAX_FILES || total + file.size > DEP_MAX_BYTES) {
        rejected += 1;
        continue;
      }
      keys.add(key);
      total += file.size;
      next.push(file);
    }
    setPicked(next);
    setIntakeError(
      unsupported || rejected
        ? [
            unsupported ? `${unsupported} unsupported` : "",
            rejected ? `${rejected} over the file or size limit` : "",
          ]
            .filter(Boolean)
            .join(" · ")
        : null,
    );
  };

  if (busy) {
    const done = files.reduce((sum, file) => sum + file.done, 0);
    const total = files.reduce((sum, file) => sum + Math.max(file.pages, file.done), 0);
    const progress = total ? Math.min(100, Math.round((done / total) * 100)) : 4;
    return (
      <div className="border border-border bg-card">
        <div className="border-b border-border px-3 py-2.5">
          <div className="flex items-center justify-between gap-3 text-[11px]">
            <span className="font-semibold uppercase tracking-[0.1em] text-muted-foreground">
              Intake progress
            </span>
            <span className="font-mono tabular-nums text-muted-foreground">
              {total ? `${done}/${total} pages` : "Preparing"}
            </span>
          </div>
          <div className="mt-2 h-1 bg-muted">
            <div
              className="h-full bg-brand-navy transition-[width]"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
        <ul className="divide-y divide-border/70">
          {files.map((file) => (
            <li
              key={file.name}
              className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 px-3 py-2 text-[12px]"
            >
              <span className="min-w-0 truncate text-foreground">{file.name}</span>
              <span className="font-mono tabular-nums text-muted-foreground">
                {file.done}/{file.pages || "…"}
              </span>
              <span className="text-[9.5px] font-semibold uppercase tracking-[0.08em] text-brand-navy">
                {file.status === "ready" ? "Ready" : "Reading"}
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="rounded-sm border border-border bg-card">
      <div
        role="button"
        tabIndex={0}
        aria-label="Choose deposition transcripts"
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          add(e.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            inputRef.current?.click();
          }
        }}
        className={`m-4 flex cursor-pointer items-center gap-3 border px-4 py-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:m-5 ${
          dragging
            ? "border-brand-orange/60 bg-brand-orange-soft/40"
            : "border-border bg-muted/15 hover:bg-muted/25"
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="application/pdf,application/x-pdf,.pdf,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.txt,.md,text/plain"
          className="hidden"
          onChange={(e) => add(e.target.files)}
        />
        <span className="grid h-9 w-9 shrink-0 place-items-center border border-border bg-card">
          <UploadCloud className="h-4 w-4 text-brand-navy/55" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-foreground">Transcript intake</p>
          <p className="mt-1 text-[11.5px] leading-[1.55] text-muted-foreground">
            PDF, DOCX, or TXT. Up to {DEP_MAX_FILES} transcripts,{" "}
            {DEP_MAX_PAGES.toLocaleString()} pages, and {bytes(DEP_MAX_BYTES)} total. Select or drop
            files here.
          </p>
        </div>
      </div>

      {intakeError ? (
        <p className="mx-4 mb-3 border-l-2 border-amber-500 pl-2 text-[11px] text-amber-800 sm:mx-5">
          {intakeError}
        </p>
      ) : null}

      {picked.length > 0 && (
        <div className="mx-4 mb-4 overflow-hidden border border-border/70 sm:mx-5 sm:mb-5">
          <div className="flex items-center justify-between border-b border-border/70 bg-muted/30 px-3 py-2">
            <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
              Intake queue
            </span>
            <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground">
              {picked.length} file{picked.length === 1 ? "" : "s"} ·{" "}
              {bytes(picked.reduce((sum, file) => sum + file.size, 0))}
            </span>
          </div>
          <ul className="wr-app-scroll max-h-64 divide-y divide-border/60 overflow-y-auto">
            {picked.map((file, index) => (
              <li
                key={`${file.name}-${file.size}-${file.lastModified}`}
                className="grid grid-cols-[1rem_minmax(0,1fr)_auto_auto_auto] items-center gap-3 px-3 py-2"
              >
                <FileText className="h-4 w-4 shrink-0 text-brand-navy/60" />
                <span className="min-w-0 truncate text-[12.5px]">{file.name}</span>
                <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground">
                  {bytes(file.size)}
                </span>
                <span className="text-[9.5px] font-semibold uppercase tracking-[0.08em] text-emerald-700">
                  Ready
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${file.name}`}
                  onClick={() => setPicked((current) => current.filter((_, item) => item !== index))}
                  className="p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="border-t border-border px-4 py-3 sm:px-5">
        <label
          htmlFor="deposition-focus"
          className="mb-1.5 block text-[10px] font-semibold uppercase tracking-[0.14em] text-brand-navy/55"
        >
          Focus (optional)
        </label>
        <Textarea
          id="deposition-focus"
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="e.g. what each witness knew about the 2003 safety review, and where they conflict"
          className="min-h-[60px] resize-none rounded-sm border-slate-200 bg-white text-[12.5px] text-slate-900 shadow-none placeholder:text-slate-400 focus-visible:border-brand-navy/40 focus-visible:ring-2 focus-visible:ring-brand-navy/10"
        />
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-border bg-muted/20 px-4 py-3 sm:px-5">
        <span className="text-[11px] text-muted-foreground">
          Files remain in this browser session.
        </span>
        <Button
          disabled={!picked.length}
          onClick={() => onStart(picked, instructions)}
          className="h-9 rounded-sm px-4 text-[12px] disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100"
        >
          {busy ? <Loader2 className="mr-2 h-4 w-4 motion-safe:animate-spin" /> : null}
          {picked.length
            ? `Read ${picked.length} transcript${picked.length === 1 ? "" : "s"}`
            : "Read transcript"}
        </Button>
      </div>
    </div>
  );
}
