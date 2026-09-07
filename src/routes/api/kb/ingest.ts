import { createFileRoute } from "@tanstack/react-router";

import { kbIngestAction } from "@/lib/kb/ingest-route";
import { requireClientFileId, requireOwnedUploadKey } from "@/lib/kb/ingest-keys";
import { isUuid } from "@/lib/kb/workspace-lifecycle";
import {
  ASYNC_INGEST_MAX_BYTES,
  SYNC_INGEST_MAX_CHARS,
  SYNC_INGEST_MAX_PAGES,
  isSha256,
  terminalErrorSummary,
} from "@/lib/kb/ingest-state";

// Synchronous KB ingest for the Working Set MVP: the browser sends the pages it
// already extracted; the server chunks + embeds (Titan) + persists to Aurora,
// scoped to the verified Cognito principal. Gated by apiAuthMiddleware; we also
// derive the principal here. Discriminated actions expose the async BDA lane
// while action-less callers retain the original synchronous behavior.

const SURFACES = new Set(["workingset", "deposition", "review"]);
const SAFE_METADATA = /^[^\p{Cc}]{1,256}$/u;
const UPLOAD_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

type Body = {
  action?: "sync" | "prepare" | "start" | "status" | "status-batch";
  workspaceId?: string;
  workspaceItemId?: string;
  workspaceItemIds?: string[];
  uploadId?: string;
  clientFileId?: string;
  inputKey?: string;
  surface?: string;
  fileName?: string;
  mime?: string;
  sha256?: string;
  byteSize?: number;
  pages?: { page?: number; text?: string }[];
};

export const Route = createFileRoute("/api/kb/ingest")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { getUserFromRequest } = await import("@/lib/auth/cognito.server");
        const user = await getUserFromRequest(request);
        if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

        let body: Body = {};
        try {
          body = (await request.json()) as Body;
        } catch {
          return Response.json({ error: "invalid JSON" }, { status: 400 });
        }
        let action;
        try {
          action = kbIngestAction(body);
        } catch {
          return Response.json({ error: "invalid ingest action" }, { status: 400 });
        }

        if (action === "prepare") {
          const [{ kbConfigured }, { kbAsyncIngestConfigured }] = await Promise.all([
            import("@/lib/kb/aurora.server"),
            import("@/lib/config.server"),
          ]);
          let configured = false;
          try {
            configured = kbConfigured() && kbAsyncIngestConfigured();
          } catch {
            configured = false;
          }
          if (!configured) {
            return Response.json({ error: terminalErrorSummary("configuration") }, { status: 503 });
          }
          const fileName = String(body.fileName ?? "").trim();
          const byteSize = Number(body.byteSize);
          const sha256 = String(body.sha256 ?? "").toLowerCase();
          if (
            !SAFE_METADATA.test(fileName) ||
            !Number.isSafeInteger(byteSize) ||
            byteSize < 1 ||
            byteSize > ASYNC_INGEST_MAX_BYTES ||
            !isSha256(sha256)
          ) {
            return Response.json(
              { error: "fileName, byteSize, and sha256 are required" },
              { status: 400 },
            );
          }
          try {
            const { createUpload } = await import("@/lib/library/library.server");
            const prepared = await createUpload(user.sub, {
              name: fileName,
              size: byteSize,
              sha256,
            });
            return Response.json({
              uploadId: prepared.itemId,
              inputKey: prepared.s3Key,
              uploadUrl: prepared.uploadUrl,
              uploadHeaders: prepared.uploadHeaders,
            });
          } catch {
            return Response.json({ error: terminalErrorSummary("configuration") }, { status: 500 });
          }
        }

        if (action === "status-batch") {
          const itemIds = Array.isArray(body.workspaceItemIds)
            ? [...new Set(body.workspaceItemIds.map((value) => String(value).trim()))]
            : [];
          if (!itemIds.length || itemIds.length > 25 || itemIds.some((itemId) => !isUuid(itemId))) {
            return Response.json(
              { error: "one to 25 valid workspaceItemIds are required" },
              { status: 400 },
            );
          }
          const [{ getWorkspaceIngestStatus }, { mapPool }] = await Promise.all([
            import("@/lib/kb/workspace.server"),
            import("@/lib/pile/async"),
          ]);
          const statuses = await mapPool(itemIds, 5, (itemId) =>
            getWorkspaceIngestStatus(user.sub, itemId),
          );
          return Response.json({ workspaces: statuses.filter(Boolean) });
        }

        if (action === "status") {
          const itemId = String(body.workspaceItemId ?? "").trim();
          if (!isUuid(itemId)) {
            return Response.json({ error: "workspaceItemId is required" }, { status: 400 });
          }
          const { getWorkspaceIngestStatus } = await import("@/lib/kb/workspace.server");
          const status = await getWorkspaceIngestStatus(user.sub, itemId);
          return status
            ? Response.json(status)
            : Response.json({ error: "workspace not found" }, { status: 404 });
        }

        const { kbConfigured } = await import("@/lib/kb/aurora.server");
        if (!kbConfigured()) {
          return Response.json({ error: "KB is not configured" }, { status: 503 });
        }

        if (action === "start") {
          const workspaceItemId = String(body.workspaceItemId ?? "").trim();
          const clientFileId = String(body.clientFileId ?? "").trim();
          const fileName = String(body.fileName ?? "").trim();
          const inputKey = String(body.inputKey ?? "").trim();
          const uploadId = String(body.uploadId ?? "").trim();
          const sha256 = String(body.sha256 ?? "").toLowerCase();
          const byteSize = Number(body.byteSize);
          const mime = body.mime === undefined ? undefined : String(body.mime).trim();
          let ownedInputKey = "";
          let uploadObjectName = "";
          try {
            requireClientFileId(clientFileId);
            ownedInputKey = requireOwnedUploadKey(user.sub, inputKey);
            uploadObjectName = ownedInputKey.slice(`uploads/${user.sub}/${uploadId}/`.length);
          } catch {
            return Response.json({ error: "invalid async ingest metadata" }, { status: 400 });
          }
          if (
            !isUuid(workspaceItemId) ||
            !SAFE_METADATA.test(fileName) ||
            !UPLOAD_ID.test(uploadId) ||
            !ownedInputKey.startsWith(`uploads/${user.sub}/${uploadId}/`) ||
            !uploadObjectName ||
            uploadObjectName.includes("/") ||
            !isSha256(sha256) ||
            !Number.isSafeInteger(byteSize) ||
            byteSize < 1 ||
            byteSize > ASYNC_INGEST_MAX_BYTES ||
            (mime !== undefined &&
              (!SAFE_METADATA.test(mime) || !/^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/.test(mime)))
          ) {
            return Response.json(
              {
                error: "valid workspace, upload, file metadata, size, and SHA-256 are required",
              },
              { status: 400 },
            );
          }
          try {
            const [{ getWorkspaceIngestReservation }, { registerAsyncIngest }] = await Promise.all([
              import("@/lib/kb/workspace.server"),
              import("@/lib/kb/ingest-async.server"),
            ]);
            const workspace = await getWorkspaceIngestReservation(user.sub, workspaceItemId);
            if (!workspace || workspace.status !== "saving") {
              return Response.json({ error: "workspace is not accepting ingest" }, { status: 409 });
            }
            const started = await registerAsyncIngest({
              ownerSub: user.sub,
              workspaceItemId,
              workspaceId: workspace.kbWorkspaceId,
              clientFileId,
              fileName,
              surface: workspace.surface,
              ...(mime ? { mime } : {}),
              requestFingerprint: workspace.requestFingerprint,
              sha256,
              byteSize,
              inputKey: ownedInputKey,
            });
            return Response.json(started, { status: 202 });
          } catch {
            return Response.json({ error: terminalErrorSummary("processing") }, { status: 500 });
          }
        }

        const workspaceId = String(body.workspaceId ?? "").trim();
        const surface = String(body.surface ?? "").trim();
        const fileName = String(body.fileName ?? "").trim();
        const syncMime = body.mime === undefined ? undefined : String(body.mime).trim();
        const syncByteSize = body.byteSize === undefined ? undefined : Number(body.byteSize);
        const syncSha256 =
          body.sha256 === undefined ? undefined : String(body.sha256).toLowerCase();
        if (
          !isUuid(workspaceId) ||
          !SURFACES.has(surface) ||
          !SAFE_METADATA.test(fileName) ||
          (syncSha256 !== undefined && !isSha256(syncSha256)) ||
          (syncByteSize !== undefined &&
            (!Number.isSafeInteger(syncByteSize) ||
              syncByteSize < 1 ||
              syncByteSize > ASYNC_INGEST_MAX_BYTES)) ||
          (syncMime !== undefined &&
            (!SAFE_METADATA.test(syncMime) || !/^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/.test(syncMime)))
        ) {
          return Response.json(
            { error: "workspaceId, valid surface, and fileName are required" },
            { status: 400 },
          );
        }

        const pages = (body.pages ?? [])
          .map((p) => ({ page: Number(p.page), text: String(p.text ?? "") }))
          .filter((p) => Number.isSafeInteger(p.page) && p.page > 0 && p.text.trim());
        if (!pages.length) {
          return Response.json({ error: "no non-empty pages" }, { status: 400 });
        }
        if (pages.length > SYNC_INGEST_MAX_PAGES) {
          return Response.json(
            {
              error: `too many pages for the sync path (max ${SYNC_INGEST_MAX_PAGES}); use the async lane`,
            },
            { status: 413 },
          );
        }
        const totalChars = pages.reduce((n, p) => n + p.text.length, 0);
        if (totalChars > SYNC_INGEST_MAX_CHARS) {
          return Response.json(
            { error: "document too large for the sync path; use the async lane" },
            { status: 413 },
          );
        }

        try {
          const { ingestPages } = await import("@/lib/kb/ingest.server");
          const result = await ingestPages(user.sub, {
            workspaceId,
            surface: surface as "workingset" | "deposition" | "review",
            fileName,
            ...(syncMime ? { mime: syncMime } : {}),
            ...(syncSha256 ? { sha256: syncSha256 } : {}),
            ...(syncByteSize !== undefined ? { byteSize: syncByteSize } : {}),
            pages,
          });
          return Response.json(result);
        } catch {
          return Response.json({ error: terminalErrorSummary("processing") }, { status: 500 });
        }
      },
    },
  },
});
