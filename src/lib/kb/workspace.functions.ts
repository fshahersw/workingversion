// Client-callable server functions for saved KB workspaces, gated by requireAuth
// and scoped to the Cognito principal. Save orchestrates: ingest each file's
// pages (chunks+embeddings -> Aurora), store pages in S3 for reload, and
// checkpoint the DynamoDB workspace record that was reserved before ingest.
import { createServerFn } from "@tanstack/react-start";

import { requireAuth } from "@/lib/auth/require-auth";
import type { SwUser } from "@/lib/auth/cognito.server";
import type { WorkspaceDoc, WorkspaceSurface } from "@/lib/kb/workspace.server";

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

    const docs: WorkspaceDoc[] = [];
    for (const file of data.files) {
      const pages = (file.pages ?? []).filter(
        (page) => page && Number(page.page) > 0 && String(page.text).trim(),
      );
      if (!pages.length) continue;
      const res = await ingestPages(sub, {
        workspaceId: kbWorkspaceId,
        surface: data.surface,
        fileName: file.fileName,
        ...(file.mime ? { mime: file.mime } : {}),
        ...(file.sha256 ? { sha256: file.sha256 } : {}),
        ...(file.byteSize !== undefined ? { byteSize: file.byteSize } : {}),
        pages,
      });
      const pagesKey = await putWorkspacePages(sub, res.docId, pages);
      docs.push({
        docId: res.docId,
        fileName: file.fileName,
        pageCount: res.pageCount,
        chunkCount: res.chunkCount,
        pagesKey,
        ...(file.bytesKey ? { bytesKey: file.bytesKey } : {}),
        ...(file.mime ? { mime: file.mime } : {}),
        ...(file.byteSize !== undefined ? { size: file.byteSize } : {}),
      });
    }
    if (!docs.length) throw new Error("nothing to save (no extractable pages)");
    const { itemId } = await saveWorkspace(sub, {
      name: data.name,
      surface: data.surface,
      kbWorkspaceId,
      folderId: data.folderId,
      docs,
    });
    return {
      itemId,
      kbWorkspaceId,
      docCount: docs.length,
      chunkCount: docs.reduce((total, doc) => total + doc.chunkCount, 0),
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
    const result = await deleteWorkspace(principalOf(context), data.itemId);
    if (!result.ok) throw new Error("Workspace deletion did not complete.");
    return result;
  });
