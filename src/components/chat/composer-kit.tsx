// Shared composer controls used by BOTH the active-chat composer (ChatView) and
// the landing/hero composer (research route), so they stay in lockstep:
// - ModeToggle: Auto / Fast / Think effort selector
// - useUploads + UploadButton + FileChips: upload files into the code sandbox
import { useCallback, useRef, useState } from "react";
import { Brain, Loader2, Paperclip, Sparkles, X, Zap } from "lucide-react";
import { uploadFile } from "@/lib/orchestrate";

export type ComposerMode = "auto" | "fast" | "think";

const MODE_OPTIONS: {
  id: ComposerMode;
  label: string;
  icon: typeof Zap;
  hint: string;
}[] = [
  { id: "auto", label: "Auto", icon: Sparkles, hint: "Let the agent pick depth" },
  { id: "fast", label: "Fast", icon: Zap, hint: "Quick answer, fewer sources" },
  { id: "think", label: "Think", icon: Brain, hint: "Deep research, full tool loop" },
];

export function ModeToggle({
  mode,
  onChange,
  disabled,
}: {
  mode: ComposerMode;
  onChange: (m: ComposerMode) => void;
  disabled?: boolean;
}) {
  return (
    <div
      className="flex items-center gap-0.5 rounded-md bg-muted/50 p-0.5"
      role="radiogroup"
      aria-label="Research mode"
    >
      {MODE_OPTIONS.map((opt) => {
        const Icon = opt.icon;
        const active = mode === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(opt.id)}
            title={opt.hint}
            className={`flex h-7 items-center gap-1 rounded px-2 text-[12px] font-medium transition-colors disabled:opacity-50 ${
              active
                ? "bg-card text-brand-navy shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Icon className="h-3.5 w-3.5" strokeWidth={2} />
            <span className="hidden sm:inline">{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** File-upload state + logic shared by both composers. Files are uploaded into
 *  the code-interpreter sandbox and referenced by name; the returned `files`
 *  list is passed as `attachments` on send. */
export function useUploads() {
  const [files, setFiles] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const handleFiles = useCallback(async (list: FileList | null) => {
    if (!list || !list.length) return;
    setUploadError(null);
    setUploading(true);
    try {
      for (const file of Array.from(list)) {
        const res = await uploadFile(file);
        if (res.ok) {
          setFiles((prev) => (prev.includes(res.name) ? prev : [...prev, res.name]));
        } else {
          setUploadError(`${file.name}: ${res.error ?? "upload failed"}`);
        }
      }
    } finally {
      setUploading(false);
    }
  }, []);

  const removeFile = useCallback(
    (name: string) => setFiles((prev) => prev.filter((f) => f !== name)),
    [],
  );

  const clearFiles = useCallback(() => setFiles([]), []);

  return { files, uploading, uploadError, handleFiles, removeFile, clearFiles };
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

export function FileChips({
  files,
  onRemove,
  className = "",
}: {
  files: string[];
  onRemove: (name: string) => void;
  className?: string;
}) {
  if (!files.length) return null;
  return (
    <div className={`flex flex-wrap gap-1.5 ${className}`}>
      {files.map((name) => (
        <span
          key={name}
          className="inline-flex max-w-[14rem] items-center gap-1 rounded-md border border-border/70 bg-muted/50 py-0.5 pl-2 pr-1 text-[11.5px] text-foreground/80"
        >
          <Paperclip className="h-3 w-3 shrink-0 text-brand-navy/60" />
          <span className="truncate">{name}</span>
          <button
            type="button"
            onClick={() => onRemove(name)}
            className="grid h-4 w-4 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={`Remove ${name}`}
            title="Remove"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
    </div>
  );
}
