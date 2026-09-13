// Server functions for the corpus v2 matter workspace.
import { createServerFn } from "@tanstack/react-start";

import { requireAdmin, requireAuth } from "@/lib/auth/require-auth";

import type {
  CourtResourcePage,
  CourtResourceQuery,
  DocumentQuery,
  DocumentsPage,
  EntriesPage,
  EntryQuery,
  MatterListItem,
  MatterWorkspace,
  PipelineRun,
  WorkspaceDocument,
} from "./workspace-types";

export const getMatters = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async (): Promise<MatterListItem[]> => {
    const { listMatters } = await import("./workspace.server");
    return listMatters();
  });

export const getMatterWorkspace = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((data: { slug: string }) => data)
  .handler(async ({ data }): Promise<MatterWorkspace | null> => {
    const { loadWorkspace } = await import("./workspace.server");
    return loadWorkspace(data.slug);
  });

export const getMatterEntries = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((data: EntryQuery) => data)
  .handler(async ({ data }): Promise<EntriesPage> => {
    const { loadEntries } = await import("./workspace.server");
    return loadEntries({ ...data, limit: Math.min(data.limit ?? 50, 200) });
  });

export const getMatterDocuments = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((data: DocumentQuery) => data)
  .handler(async ({ data }): Promise<DocumentsPage> => {
    const { loadDocuments } = await import("./workspace.server");
    return loadDocuments({ ...data, limit: Math.min(data.limit ?? 50, 200) });
  });

export const getEntryDocuments = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((data: { slug: string; entryId: string }) => data)
  .handler(async ({ data }): Promise<WorkspaceDocument[]> => {
    const { loadEntryDocuments } = await import("./workspace.server");
    return loadEntryDocuments(data.slug, data.entryId);
  });

export const getDocumentViewUrl = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((data: { documentId: string }) => data)
  .handler(async ({ data }): Promise<{ url: string | null; error?: string }> => {
    const { documentViewUrl } = await import("./workspace.server");
    return documentViewUrl(data.documentId);
  });

export const getUploadUrls = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator(
    (data: { slug: string; files: { name: string; size: number }[]; namespace?: string }) => data,
  )
  .handler(async ({ data }): Promise<{ name: string; key: string; url: string }[]> => {
    const { uploadUrls } = await import("./workspace.server");
    return uploadUrls(data.slug, data.files, data.namespace);
  });

export const getPipelineRuns = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async (): Promise<PipelineRun[]> => {
    const { loadPipelineRuns } = await import("./workspace.server");
    return loadPipelineRuns();
  });

// Court reference library: rules, standing orders and forms the firm holds for a
// docket's court. listCourtResources sanitises the query server-side (court-key
// pattern, page-size clamp, kind/format whitelist), so the validator is a shape
// pass-through, mirroring the other matter reads above.
export const getCourtResources = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((data: CourtResourceQuery) => data)
  .handler(async ({ data }): Promise<CourtResourcePage> => {
    const { listCourtResources } = await import("./workspace.server");
    return listCourtResources(data);
  });

export const getCourtResourceUrl = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((data: { sha256: string }) => data)
  .handler(async ({ data }): Promise<{ url: string; title: string; format: string } | null> => {
    const { courtResourceUrl } = await import("./workspace.server");
    return courtResourceUrl(data.sha256);
  });
