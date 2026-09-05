// Renders code-interpreter (run_python) output in the chat: charts inline as
// images, and created files (xlsx/docx/pdf/csv/…) as download chips. Payloads
// are base64 carried on the live SSE stream — not persisted across reload (v1),
// so this only shows for the turn that produced them.
import { useState } from "react";
import {
  Download,
  FileSpreadsheet,
  FileText,
  FileImage,
  FileArchive,
  File as FileIcon,
  ChevronDown,
} from "lucide-react";
import type { Artifact } from "@/lib/chat-types";

function humanSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileIcon(mime: string, name: string) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (mime.startsWith("image/")) return FileImage;
  if (mime.includes("spreadsheet") || ext === "xlsx" || ext === "xls" || ext === "csv")
    return FileSpreadsheet;
  if (mime === "application/zip" || ext === "zip") return FileArchive;
  if (
    mime.includes("word") ||
    mime === "application/pdf" ||
    mime.startsWith("text/") ||
    ["docx", "doc", "pdf", "txt", "md", "json", "html"].includes(ext)
  )
    return FileText;
  return FileIcon;
}

function dataUrl(a: Artifact): string | null {
  return a.dataB64 ? `data:${a.mime};base64,${a.dataB64}` : null;
}

export function ArtifactPanel({ artifacts }: { artifacts: Artifact[] }) {
  if (!artifacts.length) return null;
  // Anything image-typed renders inline as a chart (covers both plt.show inline
  // images and savefig'd .png files); everything else is a download chip.
  const isImage = (a: Artifact) => a.kind === "image" || a.mime.startsWith("image/");
  const images = artifacts.filter(isImage);
  const files = artifacts.filter((a) => !isImage(a));

  return (
    <div className="not-prose mt-3 space-y-2">
      {images.map((a) => (
        <ChartCard key={a.id} artifact={a} />
      ))}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {files.map((a) => {
            const Icon = fileIcon(a.mime, a.name);
            const href = dataUrl(a);
            const size = humanSize(a.size);
            const chip = (
              <>
                <Icon className="h-4 w-4 shrink-0 text-brand-navy/70" />
                <span className="truncate font-medium text-foreground/85">{a.name}</span>
                {size && <span className="shrink-0 text-muted-foreground/70">{size}</span>}
                {href ? (
                  <Download className="h-3.5 w-3.5 shrink-0 text-brand-navy/60 group-hover:text-brand-navy" />
                ) : (
                  <span className="shrink-0 text-[10px] text-amber-700/80">too large</span>
                )}
              </>
            );
            return href ? (
              <a
                key={a.id}
                href={href}
                download={a.name}
                className="group flex max-w-[16rem] items-center gap-2 rounded-lg border border-border/70 bg-card px-3 py-2 text-[12.5px] transition-colors hover:border-brand-navy/40 hover:bg-brand-blue-soft/30"
                title={`Download ${a.name}${size ? ` (${size})` : ""}`}
              >
                {chip}
              </a>
            ) : (
              <div
                key={a.id}
                className="flex max-w-[16rem] items-center gap-2 rounded-lg border border-border/70 bg-muted/40 px-3 py-2 text-[12.5px]"
                title={`${a.name} exceeds the inline download limit`}
              >
                {chip}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ChartCard({ artifact }: { artifact: Artifact }) {
  const [open, setOpen] = useState(true);
  const href = dataUrl(artifact);
  if (!href) return null;
  const ext = artifact.name.split(".").pop()?.toUpperCase() ?? "IMG";
  return (
    <div className="overflow-hidden rounded-xl border border-border/70 bg-card">
      <div className="flex items-center justify-between border-b border-border/60 px-3 py-1.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 text-[12px] font-medium text-foreground/70 hover:text-foreground"
        >
          <ChevronDown
            className={`h-3.5 w-3.5 transition-transform ${open ? "" : "-rotate-90"}`}
          />
          {artifact.name}
        </button>
        <a
          href={href}
          download={artifact.name}
          className="flex items-center gap-1 text-[11.5px] text-brand-navy/70 hover:text-brand-navy"
          title="Download chart"
        >
          <Download className="h-3.5 w-3.5" />
          {ext}
        </a>
      </div>
      {open && (
        <div className="bg-white p-2">
          <img src={href} alt={artifact.name} className="mx-auto max-h-[28rem] w-auto" />
        </div>
      )}
    </div>
  );
}
