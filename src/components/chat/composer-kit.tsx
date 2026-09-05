// Shared composer controls used by BOTH the active-chat composer (ChatView) and
// the landing/hero composer (research route), so they stay in lockstep:
// - ModeToggle: Auto / Fast / Think effort selector
// - useUploads + UploadButton + FileChips: upload files into the code sandbox
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Loader2,
  Paperclip,
  Sparkles,
  X,
  type LucideIcon,
} from "lucide-react";
import { uploadFile } from "@/lib/orchestrate";
import type { Attachment } from "@/lib/chat-types";

export type ComposerMode = "auto" | "fast" | "think";

export const MODE_OPTIONS: {
  id: ComposerMode;
  label: string;
  icon: LucideIcon | null;
  hint: string;
}[] = [
  { id: "auto", label: "Auto", icon: Sparkles, hint: "Picks depth automatically per question" },
  { id: "fast", label: "Fast", icon: null, hint: "Quick, concise — fewer sources, no deep dive" },
  { id: "think", label: "Think", icon: null, hint: "Deep research — more sources, verified" },
];

const MODE_STORAGE_KEY = "sw.composer.mode";

/** Read the persisted mode (falls back to "auto"). Safe on the server. */
export function initialMode(): ComposerMode {
  if (typeof window === "undefined") return "auto";
  const v = window.localStorage.getItem(MODE_STORAGE_KEY);
  return v === "fast" || v === "think" || v === "auto" ? v : "auto";
}

export function persistMode(m: ComposerMode) {
  try {
    window.localStorage.setItem(MODE_STORAGE_KEY, m);
  } catch {
    /* ignore */
  }
}

/** ChatGPT-style effort picker: a compact button showing the current mode that
 *  opens an upward menu with each mode + a one-line description. Auto is the
 *  default (dynamic routing); Fast/Think are manual overrides. */
export function ModeDropdown({
  mode,
  onChange,
  disabled,
}: {
  mode: ComposerMode;
  onChange: (m: ComposerMode) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const cur = MODE_OPTIONS.find((o) => o.id === mode) ?? MODE_OPTIONS[0]!;
  const CurIcon = cur.icon;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Research effort"
        className={`flex h-8 items-center gap-1.5 rounded-md border px-2 text-[12.5px] font-medium transition-colors disabled:opacity-50 ${
          open
            ? "border-brand-navy/30 bg-brand-blue-soft/40 text-brand-navy"
            : "border-transparent text-foreground/80 hover:bg-muted"
        }`}
      >
        {CurIcon && <CurIcon className="h-3.5 w-3.5 text-brand-navy" strokeWidth={2} />}
        {cur.label}
        <ChevronDown
          className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute bottom-full left-0 z-50 mb-1.5 w-[16rem] overflow-hidden rounded-xl border border-border bg-card p-1 shadow-[0_12px_32px_-12px_rgba(31,42,94,0.35)]"
        >
          {MODE_OPTIONS.map((o) => {
            const Icon = o.icon;
            const active = o.id === mode;
            return (
              <button
                key={o.id}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => {
                  onChange(o.id);
                  setOpen(false);
                }}
                className={`flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
                  active ? "bg-brand-blue-soft/50" : "hover:bg-muted"
                }`}
              >
                {Icon ? (
                  <Icon className="mt-[3px] h-4 w-4 shrink-0 text-brand-navy" strokeWidth={2} />
                ) : (
                  <span className="mt-[3px] h-4 w-4 shrink-0" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-[13px] font-semibold text-foreground">
                    {o.label}
                    {active && <Check className="h-3.5 w-3.5 text-brand-navy" strokeWidth={2.5} />}
                  </span>
                  <span className="mt-0.5 block text-[11.5px] leading-snug text-muted-foreground">
                    {o.hint}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** File-upload state + logic shared by both composers. Files are uploaded into
 *  the code-interpreter sandbox (text extracted natively server-side); the
 *  resulting Attachment list is passed as `attachments` on send. Can be backed
 *  by external state (lifted to the page) via the optional args. */
export function useUploads(
  external?: { files: Attachment[]; setFiles: (fn: (prev: Attachment[]) => Attachment[]) => void },
) {
  const localState = useState<Attachment[]>([]);
  const files = external ? external.files : localState[0];
  const setFiles = external ? external.setFiles : localState[1];
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const upsert = useCallback(
    (a: Attachment) =>
      setFiles((prev) =>
        prev.some((f) => f.name === a.name)
          ? prev.map((f) => (f.name === a.name ? a : f))
          : [...prev, a],
      ),
    [setFiles],
  );

  const handleFiles = useCallback(
    async (list: FileList | null) => {
      if (!list || !list.length) return;
      setUploadError(null);
      setUploading(true);
      try {
        for (const file of Array.from(list)) {
          const res = await uploadFile(file, { onProcessing: (ph) => upsert(ph) });
          if (res.ok) {
            upsert(res.attachment);
          } else {
            setUploadError(`${res.name}: ${res.error}`);
            // drop any processing placeholder that failed
            setFiles((prev) => prev.filter((f) => !(f.name === res.name && f.status === "processing")));
          }
        }
      } finally {
        setUploading(false);
      }
    },
    [setFiles, upsert],
  );

  const removeFile = useCallback(
    (name: string) => setFiles((prev) => prev.filter((f) => f.name !== name)),
    [setFiles],
  );

  return { files, uploading, uploadError, handleFiles, removeFile };
}

export function UploadButton({
  onFiles,
  uploading,
  disabled,
}: {
  onFiles: (list: FileList | null) => void;
  uploading: boolean;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={ref}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          onFiles(e.target.files);
          e.target.value = ""; // allow re-selecting the same file
        }}
      />
      <button
        type="button"
        onClick={() => ref.current?.click()}
        disabled={disabled || uploading}
        title="Upload file(s) — usable by the code interpreter"
        aria-label="Upload files"
        className="flex h-8 items-center gap-1.5 rounded-md px-2 text-[12.5px] text-muted-foreground transition-colors hover:bg-muted hover:text-brand-navy disabled:opacity-50"
      >
        {uploading ? (
          <Loader2 className="h-[15px] w-[15px] animate-spin" />
        ) : (
          <Paperclip className="h-[15px] w-[15px]" strokeWidth={1.85} />
        )}
        <span className="hidden sm:inline">Upload</span>
      </button>
    </>
  );
}

function humanSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const KIND_LABEL: Record<string, string> = {
  table: "sheet",
  pdf: "PDF",
  docx: "DOC",
  pptx: "PPT",
  html: "HTML",
  image: "image",
};

export function FileChips({
  files,
  onRemove,
  className = "",
}: {
  files: Attachment[];
  onRemove: (name: string) => void;
  className?: string;
}) {
  if (!files.length) return null;
  return (
    <div className={`flex flex-wrap gap-1.5 ${className}`}>
      {files.map((f) => {
        const size = humanSize(f.size);
        const kind = KIND_LABEL[f.kind] ?? f.kind;
        const processing = f.status === "processing";
        return (
          <span
            key={f.name}
            className={`inline-flex max-w-[16rem] items-center gap-1.5 rounded-md border py-1 pl-2 pr-1 text-[11.5px] ${
              processing
                ? "border-brand-orange/30 bg-brand-orange-soft/30 text-foreground/70"
                : "border-border/70 bg-muted/50 text-foreground/80"
            }`}
            title={`${f.name}${size ? ` · ${size}` : ""}${processing ? " · reading…" : f.hasFullText ? " · searchable" : ""}`}
          >
            {processing ? (
              <Loader2 className="h-3 w-3 shrink-0 animate-spin text-brand-orange" />
            ) : (
              <Paperclip className="h-3 w-3 shrink-0 text-brand-navy/60" />
            )}
            <span className="truncate font-medium">{f.name}</span>
            <span
              className={`shrink-0 rounded px-1 py-px text-[9.5px] font-semibold uppercase tracking-wide ${
                processing ? "bg-brand-orange/15 text-brand-orange" : "bg-brand-navy/10 text-brand-navy/70"
              }`}
            >
              {processing ? "reading" : kind}
            </span>
            <button
              type="button"
              onClick={() => onRemove(f.name)}
              className="grid h-4 w-4 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label={`Remove ${f.name}`}
              title="Remove"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        );
      })}
    </div>
  );
}
