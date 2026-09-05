// Client-side query options + formatting helpers for the matter workspace.
import {
  getDocumentViewUrl,
  getEntryDocuments,
  getMatterDocuments,
  getMatterEntries,
  getMatters,
  getMatterWorkspace,
  getPipelineRuns,
} from "./workspace.functions";
import type { DocumentQuery, EntryQuery } from "./workspace-types";

export const mattersQueryOptions = {
  queryKey: ["workspace", "matters"] as const,
  queryFn: () => getMatters(),
  staleTime: 60_000,
};

export const workspaceQueryOptions = (slug: string) => ({
  queryKey: ["workspace", "matter", slug] as const,
  queryFn: () => getMatterWorkspace({ data: { slug } }),
  staleTime: 60_000,
});

export const entriesQueryOptions = (q: EntryQuery) => ({
  queryKey: ["workspace", "entries", q] as const,
  queryFn: () => getMatterEntries({ data: q }),
  staleTime: 30_000,
  placeholderData: <T,>(prev: T) => prev,
});

export const documentsQueryOptions = (q: DocumentQuery) => ({
  queryKey: ["workspace", "documents", q] as const,
  queryFn: () => getMatterDocuments({ data: q }),
  staleTime: 30_000,
  placeholderData: <T,>(prev: T) => prev,
});

export const entryDocumentsQueryOptions = (slug: string, entryId: string) => ({
  queryKey: ["workspace", "entry-docs", slug, entryId] as const,
  queryFn: () => getEntryDocuments({ data: { slug, entryId } }),
  staleTime: 60_000,
});

export const documentViewUrlQueryOptions = (documentId: string | null) => ({
  queryKey: ["workspace", "view-url", documentId] as const,
  queryFn: () => getDocumentViewUrl({ data: { documentId: documentId! } }),
  enabled: !!documentId,
  staleTime: 25 * 60_000, // presigned URLs live 30 min
});

export const pipelineRunsQueryOptions = {
  queryKey: ["workspace", "pipeline-runs"] as const,
  queryFn: () => getPipelineRuns(),
  staleTime: 30_000,
};

// --- formatting -------------------------------------------------------------

export function formatCorpusDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function formatBytes(n: number | null): string {
  if (!n || n <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function docTypeLabel(t: string | null): string {
  return (t || "other").replace(/_/g, " ");
}
