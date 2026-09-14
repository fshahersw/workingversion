// Client-callable server functions for saved KB workspaces, gated by requireAuth
// and scoped to the Cognito principal. Save orchestrates: ingest each file's
// pages (chunks+embeddings -> Aurora), store pages in S3 for reload, and
// checkpoint the DynamoDB workspace record that was reserved before ingest.
import { createServerFn } from "@tanstack/react-start";

import { requireAuth } from "@/lib/auth/require-auth";
import type { SwUser } from "@/lib/auth/cognito.server";
import { parseDepositionRecord } from "@/lib/kb/deposition-record";
import { requireClientFileId } from "@/lib/kb/ingest-keys";
import { isUuid, workspaceSaveFingerprint } from "@/lib/kb/workspace-lifecycle";
import {
  ASYNC_INGEST_MAX_MARKDOWN_CHARS,
  isSha256,
  selectIngestLane,
  validateSaveByteSize,
} from "@/lib/kb/ingest-state";
import type { WorkspaceSurface } from "@/lib/kb/workspace.server";

function principalOf(context: unknown): string {
  return (context as { user: SwUser }).user.sub;
}

const SURFACES = new Set<WorkspaceSurface>(["workingset", "deposition", "review"]);
const MAX_WORKSPACE_FILES = 120;
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
      /** Reserve the owned workspace before slow indexing so analysis can be saved independently. */
      prepareOnly?: boolean;
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
        validateSaveByteSize(file.byteSize, "sync");
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
        prepareOnly: d.prepareOnly === true,
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
      { registerTextIngest },
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
      import("@/lib/kb/ingest-text.server"),
      import("@/lib/kb/workspace.server"),
      import("@/lib/pile/async"),
    ]);

    // Text-first ingest: index extracted page text (small inline, large via the
    // background worker) instead of routing to Bedrock Data Automation. Enabled
    // by default; KB_TEXT_BACKGROUND_LANE=0 restores the legacy sync/BDA split.
    // Gated on the ingest queue being configured, since the large-doc path
    // enqueues; without it, fall back to the legacy lanes.
    let textBackground = process.env["KB_TEXT_BACKGROUND_LANE"] !== "0";
    if (textBackground) {
      try {
        const { kbAsyncIngestConfigured } = await import("@/lib/config.server");
        textBackground = kbAsyncIngestConfigured();
      } catch {
        textBackground = false;
      }
    }

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
        lane: selectIngestLane(
          {
            readablePages: file.pages.length,
            totalChars,
            ...(file.bytesKey ? { bytesKey: file.bytesKey } : {}),
            ...(file.sha256 ? { sha256: file.sha256 } : {}),
          },
          { textBackground },
        ),
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
    for (const file of prepared) {
      if (file.lane.lane !== "reject") validateSaveByteSize(file.byteSize, file.lane.lane);
    }
    if (prepared.some((file) => file.lane.lane === "async")) {
      const { kbAsyncIngestConfigured } = await import("@/lib/config.server");
      let available = false;
      try {
        available = kbAsyncIngestConfigured();
      } catch {
        /* configuration is deliberately not exposed */
      }
      if (!available)
        throw new Error(
          "Background document conversion is unavailable in this environment. Use a searchable transcript within the text limits, or ask an administrator to configure the ingest workers. Your analysis remains in this tab.",
        );
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
    if (data.prepareOnly) return responseFromStatus();
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
        if (file.lane.lane === "text") {
          // Large text document: store the extracted pages and hand embedding
          // to the background worker so the save request cannot time out. The
          // fingerprint is the dedup key, so an idempotent client retry reuses
          // the same document row instead of creating a duplicate.
          await registerTextIngest({
            ownerSub: sub,
            workspaceItemId: reservation.itemId,
            workspaceId: reservation.kbWorkspaceId,
            clientFileId: file.clientFileId,
            fileName: file.fileName,
            surface: data.surface,
            ...(file.mime ? { mime: file.mime } : {}),
            sha256: fileFingerprints[index]!,
            ...(file.byteSize !== undefined ? { byteSize: file.byteSize } : {}),
            pages: file.pages,
          });
          return;
        }
        await checkpointWorkspaceDocument(sub, {
          itemId: reservation.itemId,
          clientFileId: file.clientFileId,
          status: "embedding",
        });
        let pagesKey = "";
        const res = await ingestPages(sub, {
          workspaceId: reservation.kbWorkspaceId,
          surface: data.surface,
          fileName: file.fileName,
          ...(file.mime ? { mime: file.mime } : {}),
          sha256: fileFingerprints[index],
          ...(file.byteSize !== undefined ? { byteSize: file.byteSize } : {}),
          pages: file.pages,
          onRegistered: async (docId) => {
            // Preserve the source text before embeddings. Index failure must
            // not prevent reopening an already analysed deposition.
            pagesKey = await putWorkspacePages(sub, docId, file.pages);
            await checkpointWorkspaceDocument(sub, {
              itemId: reservation.itemId,
              clientFileId: file.clientFileId,
              status: "embedding",
              docId,
              pagesKey,
              pageCount: file.pages.length,
            });
          },
        });
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
      } catch (error) {
        // The user sees a bounded summary; the server log keeps the cause so a
        // schema drift or a Bedrock/Aurora outage is diagnosable. No document
        // text or principal is written here.
        const cause = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        console.error(
          `[kb] workspace ingest failed lane=${file.lane.lane} item=${reservation.itemId} file=${file.clientFileId}: ${cause.slice(0, 400)}`,
        );
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

/**
 * Store the verified deposition analysis for an owned deposition workspace.
 * Called after each pass lands so a refresh mid-analysis loses nothing; the
 * server keeps only the newest run and rejects writes from superseded runs.
 */
export const saveWorkspaceAnalysisFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { itemId: string; record: unknown }) => {
    const itemId = String(d?.itemId ?? "").trim();
    if (!isUuid(itemId)) throw new Error("valid itemId required");
    const record = parseDepositionRecord(d?.record);
    if (!record) throw new Error("invalid deposition record");
    return { itemId, record };
  })
  .handler(async ({ context, data }) => {
    const { putWorkspaceAnalysis } = await import("@/lib/kb/workspace.server");
    return putWorkspaceAnalysis(principalOf(context), data.itemId, data.record);
  });

export const getWorkspaceAnalysisFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { itemId: string }) => {
    const itemId = String(d?.itemId ?? "").trim();
    if (!isUuid(itemId)) throw new Error("valid itemId required");
    return { itemId };
  })
  .handler(async ({ context, data }) => {
    const { getWorkspaceAnalysis } = await import("@/lib/kb/workspace.server");
    return getWorkspaceAnalysis(principalOf(context), data.itemId);
  });

export const deleteWorkspaceFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { itemId: string }) => {
    if (!d?.itemId) throw new Error("itemId required");
    return { itemId: d.itemId };
  })
  .handler(async ({ context, data }) => {
    const sub = principalOf(context);
    const { deleteWorkspace } = await import("@/lib/kb/workspace.server");
    const result = await deleteWorkspace(sub, data.itemId);
    if (!result.ok) {
      const why = result.failures[0]?.summary;
      throw new Error(
        why
          ? `Workspace deletion did not complete: ${why}`
          : "Workspace deletion did not complete.",
      );
    }
    // Tabular Review tables that read from this workspace keep their grid but
    // lose the binding; their rows now ask for the document again.
    const { detachWorkspaceFromTables } = await import("@/lib/review/review.server");
    await detachWorkspaceFromTables(sub, data.itemId).catch(() => undefined);
    return result;
  });
