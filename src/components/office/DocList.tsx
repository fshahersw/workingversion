// Shared list pieces for the Office section (Drafts and Sheets tabs).
import { Loader2, Trash2, type LucideIcon } from "lucide-react";

import type { OfficeDocSummary } from "@/lib/office/types";

export function DocRow({
  doc,
  icon: Icon,
  onOpen,
  onDelete,
  deleting,
}: {
  doc: OfficeDocSummary;
  icon: LucideIcon;
  onOpen: () => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  return (
    <li className="group flex items-start gap-3 rounded-lg border border-border/70 bg-card px-3.5 py-3 transition-colors hover:border-brand-navy/30">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-start gap-3 text-left"
      >
        <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md bg-brand-blue-soft/70 text-brand-navy">
          <Icon className="h-4 w-4" strokeWidth={1.9} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-medium text-foreground">
            {doc.title}
          </span>
          <span className="mt-0.5 block text-[11.5px] text-muted-foreground">
            {doc.version > 0
              ? `Revision ${doc.version} · ${formatSize(doc.size)} · `
              : "Legacy draft · "}
            edited {relative(doc.updatedAt)}
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={onDelete}
        disabled={deleting}
        aria-label="Delete document"
        className="mt-0.5 shrink-0 text-muted-foreground/50 opacity-0 transition hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100 disabled:opacity-50"
      >
        {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
      </button>
    </li>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  body,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-lg border border-dashed border-border bg-card/60 px-6 py-10 text-center">
      <div className="mx-auto grid h-11 w-11 place-items-center rounded-full bg-brand-blue-soft text-brand-navy">
        <Icon className="h-5 w-5" strokeWidth={1.9} />
      </div>
      <h2 className="mt-3 text-[14px] font-semibold text-foreground">{title}</h2>
      <p className="mx-auto mt-1 max-w-md text-[12.5px] text-muted-foreground">{body}</p>
    </div>
  );
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function relative(iso: string): string {
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
