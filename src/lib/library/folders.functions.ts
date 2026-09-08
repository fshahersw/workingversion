// Client-callable server functions for Library folders, gated by requireAuth
// and scoped to the authenticated Cognito principal.
import { createServerFn } from "@tanstack/react-start";

import { requireAuth } from "@/lib/auth/require-auth";
import type { SwUser } from "@/lib/auth/cognito.server";
import { isFolderCategory, ROOT_FOLDER, type FolderCategory } from "@/lib/library/folder-tree";

function principalOf(context: unknown): string {
  return (context as { user: SwUser }).user.sub;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

function requireCategory(value: unknown): FolderCategory {
  if (!isFolderCategory(value)) throw new Error("valid category required");
  return value;
}

function requireFolderId(value: unknown, allowRoot = false): string {
  const id = String(value ?? "").trim();
  if (allowRoot && (id === "" || id === ROOT_FOLDER)) return ROOT_FOLDER;
  if (!ID.test(id)) throw new Error("valid folderId required");
  return id;
}

export const listFoldersFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { category: FolderCategory }) => ({ category: requireCategory(d?.category) }))
  .handler(async ({ context, data }) => {
    const m = await import("@/lib/library/folders.server");
    return m.listFolders(principalOf(context), data.category);
  });

export const createFolderFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { category: FolderCategory; name: string; parentId?: string }) => ({
    category: requireCategory(d?.category),
    name: String(d?.name ?? ""),
    parentId: requireFolderId(d?.parentId, true),
  }))
  .handler(async ({ context, data }) => {
    const m = await import("@/lib/library/folders.server");
    return m.createFolder(principalOf(context), data);
  });

export const renameFolderFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { category: FolderCategory; folderId: string; name: string }) => ({
    category: requireCategory(d?.category),
    folderId: requireFolderId(d?.folderId),
    name: String(d?.name ?? ""),
  }))
  .handler(async ({ context, data }) => {
    const m = await import("@/lib/library/folders.server");
    return m.renameFolder(principalOf(context), data);
  });

export const moveFolderFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { category: FolderCategory; folderId: string; parentId: string }) => ({
    category: requireCategory(d?.category),
    folderId: requireFolderId(d?.folderId),
    parentId: requireFolderId(d?.parentId, true),
  }))
  .handler(async ({ context, data }) => {
    const m = await import("@/lib/library/folders.server");
    return m.moveFolder(principalOf(context), data);
  });

export const deleteFolderFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { category: FolderCategory; folderId: string }) => ({
    category: requireCategory(d?.category),
    folderId: requireFolderId(d?.folderId),
  }))
  .handler(async ({ context, data }) => {
    const m = await import("@/lib/library/folders.server");
    return m.deleteFolder(principalOf(context), data);
  });

export const moveContentFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { category: FolderCategory; targetId: string; folderId: string }) => {
    const targetId = String(d?.targetId ?? "").trim();
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(targetId)) throw new Error("valid targetId required");
    return {
      category: requireCategory(d?.category),
      targetId,
      folderId: requireFolderId(d?.folderId, true),
    };
  })
  .handler(async ({ context, data }) => {
    const m = await import("@/lib/library/folders.server");
    return m.moveContent(principalOf(context), data);
  });
