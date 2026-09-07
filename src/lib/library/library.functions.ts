// Client-callable server functions for the library, gated by requireAuth.
// Scoped to the authenticated Cognito principal.
import { createServerFn } from "@tanstack/react-start";

import { requireAuth } from "@/lib/auth/require-auth";
import type { SwUser } from "@/lib/auth/cognito.server";
import type { ItemKind } from "@/lib/library/library.server";

function principalOf(context: unknown): string {
  return (context as { user: SwUser }).user.sub;
}

export const saveOutputTextFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { name: string; content: string; kind?: ItemKind; folderId?: string }) => {
    if (!d?.content) throw new Error("content required");
    return { name: d.name ?? "Untitled", content: d.content, kind: d.kind, folderId: d.folderId };
  })
  .handler(async ({ context, data }) => {
    const { saveOutputText } = await import("@/lib/library/library.server");
    return saveOutputText(principalOf(context), data);
  });

export const listItemsFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { kind?: ItemKind }) => ({ kind: d?.kind }))
  .handler(async ({ context, data }) => {
    const { listItems } = await import("@/lib/library/library.server");
    return listItems(principalOf(context), data.kind);
  });

export const getLibraryItemFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { itemId: string }) => {
    if (!d?.itemId) throw new Error("itemId required");
    return { itemId: d.itemId };
  })
  .handler(async ({ context, data }) => {
    const { getLibraryItem } = await import("@/lib/library/library.server");
    return getLibraryItem(principalOf(context), data.itemId);
  });

export const deleteLibraryItemFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { itemId: string }) => {
    if (!d?.itemId) throw new Error("itemId required");
    return { itemId: d.itemId };
  })
  .handler(async ({ context, data }) => {
    const { deleteLibraryItem } = await import("@/lib/library/library.server");
    return deleteLibraryItem(principalOf(context), data.itemId);
  });

// --- Uploads (browser -> S3 via presigned URLs) ---

export const createUploadFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { name: string; size: number; sha256?: string }) => {
    if (!d?.name) throw new Error("name required");
    const size = Number(d.size);
    if (!Number.isSafeInteger(size) || size < 1) throw new Error("invalid size");
    const sha256 = d.sha256 === undefined ? undefined : String(d.sha256).toLowerCase();
    if (sha256 !== undefined && !/^[0-9a-f]{64}$/.test(sha256)) {
      throw new Error("invalid sha256");
    }
    return { name: d.name, size, ...(sha256 ? { sha256 } : {}) };
  })
  .handler(async ({ context, data }) => {
    const { createUpload } = await import("@/lib/library/library.server");
    return createUpload(principalOf(context), data);
  });

export const registerUploadFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator(
    (d: { itemId: string; s3Key: string; name: string; contentType?: string; size?: number }) => {
      if (!d?.itemId || !d?.s3Key) throw new Error("itemId and s3Key required");
      return {
        itemId: d.itemId,
        s3Key: d.s3Key,
        name: d.name ?? "file",
        contentType: d.contentType,
        size: typeof d.size === "number" ? d.size : undefined,
      };
    },
  )
  .handler(async ({ context, data }) => {
    const { registerUpload } = await import("@/lib/library/library.server");
    return registerUpload(principalOf(context), data);
  });

export const getDownloadUrlFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { itemId: string }) => {
    if (!d?.itemId) throw new Error("itemId required");
    return { itemId: d.itemId };
  })
  .handler(async ({ context, data }) => {
    const { getDownloadUrl } = await import("@/lib/library/library.server");
    return getDownloadUrl(principalOf(context), data.itemId);
  });
