// Client-callable server functions for saved KB workspaces, gated by requireAuth
// and scoped to the Cognito principal. Save orchestrates: ingest each file's
// pages (chunks+embeddings -> Aurora, scoped to a fresh per-workspace kb id),
// store the pages in S3 for reload, then write the workspace record.
import { createServerFn } from "@tanstack/react-start";

import { requireAuth } from "@/lib/auth/require-auth";
import type { SwUser } from "@/lib/auth/cognito.server";
import type { WorkspaceSurface } from "@/lib/kb/workspace.server";

function principalOf(context: unknown): string {
  return (context as { user: SwUser }).user.sub;
}

const SURFACES = new Set<WorkspaceSurface>(["workingset", "deposition", "review"]);

type SaveFile = {
  fileName: string;
  mime?: string;
  sha256?: string;
  byteSize?: number;
  bytesKey?: string;
  pages: { page: number; text: string }[];
};

export const saveWorkspaceFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator(
    (d: {
      name: string;
      surface: WorkspaceSurface;
      folderId?: string;
      files: SaveFile[];
    }) => {
      const surface = d?.surface;
      if (!SURFACES.has(surface)) throw new Error("valid surface required");
      const files = Array.isArray(d?.files) ? d.files : [];
      if (!files.length) throw new Error("no files to save");
      return {
        name: (d.name || "Untitled workspace").slice(0, 120),
        surface,
        folderId: d.folderId || "ROOT",
        files,
      };
    },
  )
  .handler(async ({ context, data }) => {
    const sub = principalOf(context);
    const { ingestPages } = await import("@/lib/kb/ingest.server");
    const { putWorkspacePages, saveWorkspace } = await import("@/lib/kb/workspace.server");
    const kbWorkspaceId = crypto.randomUUID();

    const out: {
      docId: string;
      fileName: string;
      pageCount: number;
      chunkCount: number;
      pagesKey: string;
      bytesKey?: string;
      mime?: string;
      size?: number;
    }[] = [];
    for (const f of data.files) {
      const pages = (f.pages ?? []).filter((p) => p && Number(p.page) > 0 && String(p.text).trim());
      if (!pages.length) continue;
      const res = await ingestPages(sub, {
        workspaceId: kbWorkspaceId,
        surface: data.surface,
        fileName: f.fileName,
        ...(f.mime ? { mime: f.mime } : {}),
        ...(f.sha256 ? { sha256: f.sha256 } : {}),
        ...(f.byteSize !== undefined ? { byteSize: f.byteSize } : {}),
        pages,
      });
      const pagesKey = await putWorkspacePages(sub, res.docId, pages);
      out.push({
        docId: res.docId,
        fileName: f.fileName,
        pageCount: res.pageCount,
        chunkCount: res.chunkCount,
        pagesKey,
        ...(f.bytesKey ? { bytesKey: f.bytesKey } : {}),
        ...(f.mime ? { mime: f.mime } : {}),
        ...(f.byteSize !== undefined ? { size: f.byteSize } : {}),
      });
    }
    if (!out.length) throw new Error("nothing to save (no extractable pages)");
    const { itemId } = await saveWorkspace(sub, {
      name: data.name,
      surface: data.surface,
      kbWorkspaceId,
      folderId: data.folderId,
      docs: out,
    });
    return {
      itemId,
      kbWorkspaceId,
      docCount: out.length,
      chunkCount: out.reduce((n, d) => n + d.chunkCount, 0),
    };
  });

export const listWorkspacesFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { surface?: WorkspaceSurface }) => ({
    surface: d?.surface && SURFACES.has(d.surface) ? d.surface : undefined,
  }))
  .handler(async ({ context, data }) => {
    const { listWorkspaces } = await import("@/lib/kb/workspace.server");
    return listWorkspaces(principalOf(context), data.surface);
  });

export const getWorkspaceFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { itemId: string }) => {
    if (!d?.itemId) throw new Error("itemId required");
    return { itemId: d.itemId };
  })
  .handler(async ({ context, data }) => {
    const { getWorkspace } = await import("@/lib/kb/workspace.server");
    return getWorkspace(principalOf(context), data.itemId);
  });

export const getWorkspacePagesFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { itemId: string; docId: string }) => {
    if (!d?.itemId || !d?.docId) throw new Error("itemId and docId required");
    return { itemId: d.itemId, docId: d.docId };
  })
  .handler(async ({ context, data }) => {
    const { getWorkspacePages } = await import("@/lib/kb/workspace.server");
    return getWorkspacePages(principalOf(context), data.itemId, data.docId);
  });

export const deleteWorkspaceFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { itemId: string }) => {
    if (!d?.itemId) throw new Error("itemId required");
    return { itemId: d.itemId };
  })
  .handler(async ({ context, data }) => {
    const { deleteWorkspace } = await import("@/lib/kb/workspace.server");
    return deleteWorkspace(principalOf(context), data.itemId);
  });
