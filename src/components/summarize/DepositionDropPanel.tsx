import { useRef, useState } from "react";
import { FileText, Loader2, UploadCloud, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { DEP_MAX_FILES, DEP_MAX_PAGES } from "@/lib/pile/limits";

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
  const inputRef = useRef<HTMLInputElement>(null);

  const add = (list: FileList | null) => {
    if (!list) return;
    const next = Array.from(list).filter(isTranscriptFile);
    if (!next.length) return;
    setPicked((p) => [...p, ...next].slice(0, DEP_MAX_FILES));
  };

  if (busy) {
    return (
      <div className="space-y-2">
        {files.map((f) => (
          <div key={f.name} className="flex items-center justify-between gap-3 text-[12.5px]">
            <span className="min-w-0 truncate text-foreground">{f.name}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {f.done}/{f.pages || "…"}
            </span>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-border bg-card p-5">
      <div
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
        className={`flex cursor-pointer flex-col items-center rounded-xl border border-dashed px-6 py-10 text-center transition-colors ${
          dragging
            ? "border-brand-orange/60 bg-brand-orange-soft/40"
            : "border-border bg-muted/20 hover:border-brand-navy/25"
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
        <UploadCloud className="mb-3 h-8 w-8 text-brand-navy/35" />
        <p className="text-[15px] font-semibold text-foreground">Drop deposition transcripts</p>
        <p className="mt-1.5 max-w-[28rem] text-[12px] leading-relaxed text-muted-foreground">
          PDF, Word, or TXT · up to {DEP_MAX_FILES} transcripts · {DEP_MAX_PAGES.toLocaleString()}{" "}
          pages · each file analyzed in parallel, then cross-checked · stays in this tab
        </p>
        <div className="mt-4 flex flex-wrap justify-center gap-1.5">
          <span className="inline-flex items-center gap-1 rounded-full border border-border bg-background/70 px-2.5 py-1 text-[10.5px] font-medium text-muted-foreground">
            <FileText className="h-3 w-3" /> PDF
          </span>
          <span className="inline-flex items-center gap-1 rounded-full border border-border bg-background/70 px-2.5 py-1 text-[10.5px] font-medium text-muted-foreground">
            <FileText className="h-3 w-3" /> Word
          </span>
          <span className="inline-flex items-center gap-1 rounded-full border border-border bg-background/70 px-2.5 py-1 text-[10.5px] font-medium text-muted-foreground">
            <FileText className="h-3 w-3" /> TXT
          </span>
        </div>
      </div>

      {picked.length > 0 && (
        <ul className="mt-4 divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70">
          {picked.map((f, i) => (
            <li key={`${f.name}-${i}`} className="flex items-center gap-3 px-3 py-2">
              <FileText className="h-4 w-4 shrink-0 text-brand-navy/60" />
              <span className="min-w-0 flex-1 truncate text-[12.5px]">{f.name}</span>
              <button
                type="button"
                aria-label={`Remove ${f.name}`}
                onClick={() => setPicked((p) => p.filter((_, j) => j !== i))}
                className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4">
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
          className="min-h-[68px] resize-none rounded-lg border-slate-200 bg-white text-[13px] text-slate-900 shadow-none placeholder:text-slate-400 focus-visible:border-brand-navy/40 focus-visible:ring-2 focus-visible:ring-brand-navy/10"
        />
      </div>

      <Button
        disabled={!picked.length}
        onClick={() => onStart(picked, instructions)}
        className="mt-3 h-11 w-full rounded-xl disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100"
      >
        {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
        {picked.length
          ? `Read ${picked.length} transcript${picked.length === 1 ? "" : "s"}`
          : "Read transcript"}
      </Button>
    </div>
  );
}
