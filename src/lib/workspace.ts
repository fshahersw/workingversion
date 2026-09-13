// Client-side query options + formatting helpers for the matters workspace.
import {
  getCourtResources,
  getDocumentViewUrl,
  getEntryDocuments,
  getMatterDocuments,
  getMatterEntries,
  getMatters,
  getMatterWorkspace,
  getPipelineRuns,
} from "./workspace.functions";
import type {
  CourtResourceKind,
  CourtResourceQuery,
  DocketScope,
  DocumentQuery,
  EntryQuery,
} from "./workspace-types";

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
  placeholderData: <T>(prev: T) => prev,
});

export const documentsQueryOptions = (q: DocumentQuery) => ({
  queryKey: ["workspace", "documents", q] as const,
  queryFn: () => getMatterDocuments({ data: q }),
  staleTime: 30_000,
  placeholderData: <T>(prev: T) => prev,
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

export const courtResourcesQueryOptions = (q: CourtResourceQuery) => ({
  queryKey: ["workspace", "court-resources", q] as const,
  queryFn: () => getCourtResources({ data: q }),
  enabled: q.courtKeys.length > 0,
  staleTime: 60_000,
  placeholderData: <T>(prev: T) => prev,
});

// --- labels -----------------------------------------------------------------

export const SCOPE_LABEL: Record<DocketScope, { title: string; short: string; hint: string }> = {
  federal: {
    title: "Federal transferee docket",
    short: "Federal",
    hint: "The MDL court's master docket where coordinated proceedings are filed.",
  },
  jpml: {
    title: "Judicial Panel on Multidistrict Litigation",
    short: "JPML",
    hint: "Transfer motions, conditional transfer orders, and Panel rulings.",
  },
  member: {
    title: "Member cases",
    short: "Members",
    hint: "Individual actions transferred into or tagged to the MDL. Only publicly available filings are held.",
  },
  state: {
    title: "State court proceedings",
    short: "State",
    hint: "Coordinated state actions tracked alongside the MDL. PDFs are rarely available.",
  },
  appellate: {
    title: "Appellate proceedings",
    short: "Appellate",
    hint: "Appeals and mandamus petitions arising from the MDL.",
  },
};

export const DOC_TYPE_LABEL: Record<string, string> = {
  complaint: "Complaint",
  order: "Order",
  cmo: "Case management order",
  transfer_order: "Transfer order",
  motion: "Motion",
  brief: "Brief",
  notice: "Notice",
  opinion: "Opinion",
  other: "Other",
};

export function docTypeLabel(t: string | null): string {
  const key = (t || "other").toLowerCase();
  return DOC_TYPE_LABEL[key] ?? key.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export const COURT_RESOURCE_LABEL: Record<CourtResourceKind, string> = {
  standing_order: "Standing order",
  local_rule: "Local rule",
  form: "Form",
  instruction: "Instruction",
  order: "Order",
  other: "Other",
};

export function courtResourceKindLabel(k: string | null): string {
  const key = (k || "other") as CourtResourceKind;
  return COURT_RESOURCE_LABEL[key] ?? key.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

// --- formatting -------------------------------------------------------------

export function formatCorpusDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatRelative(iso: string | null): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const mins = Math.round((Date.now() - t) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 60) return `${days} d ago`;
  return formatCorpusDate(iso);
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

export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}
