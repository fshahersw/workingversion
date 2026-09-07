// Client-callable server functions for saved KB workspaces, gated by requireAuth
// and scoped to the Cognito principal. Save orchestrates: ingest each file's
// pages (chunks+embeddings -> Aurora), store pages in S3 for reload, and
// checkpoint the DynamoDB workspace record that was reserved before ingest.
import { createServerFn } from "@tanstack/react-start";

import { requireAuth } from "@/lib/auth/require-auth";
import type { SwUser } from "@/lib/auth/cognito.server";
import { requireClientFileId } from "@/lib/kb/ingest-keys";
import { isUuid, workspaceSaveFingerprint } from "@/lib/kb/workspace-lifecycle";
import {
  ASYNC_INGEST_MAX_BYTES,
  ASYNC_INGEST_MAX_MARKDOWN_CHARS,
  isSha256,
  selectIngestLane,
} from "@/lib/kb/ingest-state";
import type { WorkspaceSurface } from "@/lib/kb/workspace.server";

function principalOf(context: unknown): string {
  return (context as { user: SwUser }).user.sub;
}

const SURFACES = new Set<WorkspaceSurface>(["workingset", "deposition", "review"]);
const MAX_WORKSPACE_FILES = 100;
const SAFE_METADATA = /^[^\p{Cc}]{1,256}$/u;

type SaveFile = {
  clientFileId: string;
  fileName: string;
  mime?: string;
  sha256?: string;
  byteSize?: number;
  bytesKey?: string;
  pages?: { page: number; text: string }[];
};

export const saveWorkspaceFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator(
    (d: {
      requestId: string;
      name: string;
      surface: WorkspaceSurface;
      folderId?: string;
      files: SaveFile[];
    }) => {
      const surface = d?.surface;
      if (!SURFACES.has(surface)) throw new Error("valid surface required");
      const requestId = String(d?.requestId ?? "").trim();
      if (!isUuid(requestId)) throw new Error("valid requestId required");
      const files = Array.isArray(d?.files) ? d.files : [];
      if (!files.length) throw new Error("no files to save");
      if (files.length > MAX_WORKSPACE_FILES) throw new Error("too many files to save");
      const clientFileIds = files.map((file) => String(file?.clientFileId ?? "").trim());
      for (const id of clientFileIds) requireClientFileId(id);
      if (new Set(clientFileIds).size !== clientFileIds.length) {
        throw new Error("clientFileId must be unique for every file");
      }
      const fileNames = files.map((file) => String(file?.fileName ?? "").trim());
      if (fileNames.some((name) => !SAFE_METADATA.test(name))) {
        throw new Error("fileName required for every file");
      }
      for (const file of files) {
        if (file.sha256 !== undefined && !isSha256(file.sha256)) {
          throw new Error("invalid raw file sha256");
        }
        if (
          file.byteSize !== undefined &&
          (!Number.isSafeInteger(file.byteSize) ||
            file.byteSize < 1 ||
            file.byteSize > ASYNC_INGEST_MAX_BYTES)
        ) {
          throw new Error("invalid file byte size");
        }
        if (
          file.mime !== undefined &&
          (!SAFE_METADATA.test(file.mime) || !/^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/.test(file.mime))
        ) {
          throw new Error("invalid file MIME type");
        }
        if (file.bytesKey !== undefined && typeof file.bytesKey !== "string") {
          throw new Error("invalid file storage key");
        }
        const submittedChars = (Array.isArray(file.pages) ? file.pages : []).reduce(
          (total, page) => total + String(page?.text ?? "").length,
          0,
        );
        if (submittedChars > ASYNC_INGEST_MAX_MARKDOWN_CHARS) {
          throw new Error("submitted page text exceeds the request limit");
        }
      }
      const folderId = String(d.folderId || "ROOT").trim();
      if (!SAFE_METADATA.test(folderId)) throw new Error("valid folderId required");
      return {
        requestId,
        name: (d.name || "Untitled workspace").slice(0, 120),
        surface,
        folderId,
        files: files.map((file, index) => ({
          ...file,
          clientFileId: clientFileIds[index]!,
          fileName: fileNames[index]!,
          ...(file.sha256 ? { sha256: file.sha256.toLowerCase() } : {}),
          pages: Array.isArray(file.pages) ? file.pages : [],
        })),
      };
    },
  )
  .handler(async ({ context, data }) => {
    const sub = principalOf(context);
    const [
      { ingestPages },
      { updateDocumentIngest },
      { registerAsyncIngest },
      {
        checkpointWorkspaceDocument,
        finalizeWorkspaceFromCheckpoints,
        getWorkspaceIngestStatus,
        listWorkspaceDocumentCheckpoints,
        putWorkspacePages,
        reserveWorkspace,
        reserveWorkspaceDocument,
      },
      { mapPool },
    ] = await Promise.all([
      import("@/lib/kb/ingest.server"),
      import("@/lib/kb/aurora.server"),
      import("@/lib/kb/ingest-async.server"),
      import("@/lib/kb/workspace.server"),
      import("@/lib/pile/async"),
    ]);

    const files = data.files.map((file) => {
      const pages = (file.pages ?? []).filter(
        (page) => page && Number(page.page) > 0 && String(page.text).trim(),
      );
      return { ...file, pages };
    });
    const prepared = files.map((file) => {
      const totalChars = file.pages.reduce((total, page) => total + page.text.length, 0);
      return {
        ...file,
        lane: selectIngestLane({
          readablePages: file.pages.length,
          totalChars,
          ...(file.bytesKey ? { bytesKey: file.bytesKey } : {}),
          ...(file.sha256 ? { sha256: file.sha256 } : {}),
        }),
      };
    });
    const rejected = prepared.filter((file) => file.lane.lane === "reject");
    if (rejected.length) {
      throw new Error(
        `Cannot save: ${rejected.length} document${rejected.length === 1 ? "" : "s"} require original bytes and a raw SHA-256 for asynchronous ingest.`,
      );
    }
    const incompleteAsync = prepared.filter(
      (file) =>
        file.lane.lane === "async" &&
        (!file.bytesKey || !file.sha256 || !file.byteSize || file.byteSize < 1),
    );
    if (incompleteAsync.length) {
      throw new Error("Asynchronous ingest requires verified byte size, storage key, and SHA-256.");
    }

    const { requestFingerprint, fileFingerprints } = workspaceSaveFingerprint({
      name: data.name,
      surface: data.surface,
      folderId: data.folderId,
      files: prepared,
    });
    const cleanupKeys = prepared.flatMap((file) => (file.bytesKey ? [file.bytesKey] : []));
    const reservation = await reserveWorkspace(sub, {
      requestId: data.requestId,
      requestFingerprint,
      name: data.name,
      surface: data.surface,
      folderId: data.folderId,
      cleanupKeys,
      expectedDocCount: prepared.length,
    });
    const responseFromStatus = async () => {
      const status = await getWorkspaceIngestStatus(sub, reservation.itemId);
      if (!status) throw new Error("workspace save reservation was not found");
      return {
        itemId: reservation.itemId,
        kbWorkspaceId: reservation.kbWorkspaceId,
        status: status.status,
        stage: status.stage,
        pendingCount: status.pendingCount,
        docCount: status.docCount,
        chunkCount: status.chunkCount,
        documents: status.documents,
        ...(status.errorSummary ? { errorSummary: status.errorSummary } : {}),
      };
    };
    if (reservation.status === "ready" || reservation.status === "error") {
      return responseFromStatus();
    }

    await mapPool(prepared, 6, async (file) => {
      await reserveWorkspaceDocument(sub, {
        itemId: reservation.itemId,
        clientFileId: file.clientFileId,
        fileName: file.fileName,
        ...(file.mime ? { mime: file.mime } : {}),
        ...(file.byteSize !== undefined ? { size: file.byteSize } : {}),
        ...(file.bytesKey ? { bytesKey: file.bytesKey } : {}),
      });
    });
    const existing = new Map(
      (await listWorkspaceDocumentCheckpoints(sub, reservation.itemId)).map((checkpoint) => [
        checkpoint.clientFileId,
        checkpoint,
      ]),
    );

    await mapPool(prepared, 3, async (file, index) => {
      const checkpoint = existing.get(file.clientFileId);
      if (checkpoint?.status === "ready" || checkpoint?.status === "error") {
        return;
      }
      try {
        if (file.lane.lane === "async") {
          await registerAsyncIngest({
            ownerSub: sub,
            workspaceItemId: reservation.itemId,
            workspaceId: reservation.kbWorkspaceId,
            clientFileId: file.clientFileId,
            fileName: file.fileName,
            surface: data.surface,
            ...(file.mime ? { mime: file.mime } : {}),
            documentSha256: fileFingerprints[index]!,
            requestFingerprint,
            sha256: file.sha256!,
            byteSize: file.byteSize!,
            inputKey: file.bytesKey!,
          });
          return;
        }
        await checkpointWorkspaceDocument(sub, {
          itemId: reservation.itemId,
          clientFileId: file.clientFileId,
          status: "embedding",
        });
        const res = await ingestPages(sub, {
          workspaceId: reservation.kbWorkspaceId,
          surface: data.surface,
          fileName: file.fileName,
          ...(file.mime ? { mime: file.mime } : {}),
          sha256: fileFingerprints[index],
          ...(file.byteSize !== undefined ? { byteSize: file.byteSize } : {}),
          pages: file.pages,
        });
        const pagesKey = await putWorkspacePages(sub, res.docId, file.pages);
        await updateDocumentIngest(
          sub,
          res.docId,
          {
            status: "ready",
            pageCount: res.pageCount,
            s3Key: pagesKey,
            markCompleted: true,
          },
          ["ready"],
        );
        await checkpointWorkspaceDocument(sub, {
          itemId: reservation.itemId,
          clientFileId: file.clientFileId,
          status: "ready",
          docId: res.docId,
          fileName: file.fileName,
          ...(file.mime ? { mime: file.mime } : {}),
          ...(file.byteSize !== undefined ? { size: file.byteSize } : {}),
          ...(file.bytesKey ? { bytesKey: file.bytesKey } : {}),
          pagesKey,
          pageCount: res.pageCount,
          chunkCount: res.chunkCount,
        });
      } catch {
        await checkpointWorkspaceDocument(sub, {
          itemId: reservation.itemId,
          clientFileId: file.clientFileId,
          status: "error",
          errorKind: file.lane.lane === "async" ? "configuration" : "processing",
        }).catch(() => {});
      }
    });
    await finalizeWorkspaceFromCheckpoints(sub, reservation.itemId);
    return responseFromStatus();
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

export const getWorkspaceStatusFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { itemId: string }) => {
    if (!d?.itemId) throw new Error("itemId required");
    return { itemId: d.itemId };
  })
  .handler(async ({ context, data }) => {
    const { getWorkspaceIngestStatus } = await import("@/lib/kb/workspace.server");
    return getWorkspaceIngestStatus(principalOf(context), data.itemId);
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
