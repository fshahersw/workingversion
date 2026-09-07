// Saved KB workspaces (server-only). A workspace is a named, reloadable unit:
//  - chunks + embeddings live in Aurora kb.chunks (queryable; written by ingest)
//  - extracted pages live in S3 (kb/pages/...) for one-click pile rehydrate
//  - original bytes live in S3 (optional; uploaded via the presigned flow)
//  - the record is a DynamoDB library item (type=workspace) with folders (GSI1),
//    reusing the existing library layer.
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { PutCommand } from "@aws-sdk/lib-dynamodb";

import {
  putItem,
  putItemIfAbsent,
  getItem,
  queryPrefix,
  deleteItem,
  batchDelete,
  doc as dynamo,
  tableName,
} from "@/lib/data/dynamo.server";
import { bucketName, s3, presignGet, deleteObject, deletePrefix } from "@/lib/data/s3.server";
import { deleteWorkspaceDocuments } from "@/lib/kb/aurora.server";
import {
  decideIngestTransition,
  isIngestStatus,
  isSha256,
  terminalErrorSummary,
  type IngestStatus,
  type TerminalErrorKind,
} from "@/lib/kb/ingest-state";
import { aggregateWorkspaceCheckpoints, isUuid } from "@/lib/kb/workspace-lifecycle";
import { requireClientFileId, requireJobLookupId } from "@/lib/kb/ingest-keys";
import { mapPool, withRetry } from "@/lib/pile/async";

const userPK = (p: string) => `USER#${p}`;
const itemSK = (id: string) => `ITEM#${id}`;

export type WorkspaceSurface = "workingset" | "deposition" | "review";
export type WorkspaceStatus = "saving" | "ready" | "error";

export type WorkspaceDoc = {
  docId: string;
  /** Browser pile id used only to reconstruct the save response after a retry. */
  sourceFileId?: string;
  fileName: string;
  pageCount: number;
  chunkCount: number;
  pagesKey: string;
  bytesKey?: string;
  mime?: string;
  size?: number;
};

export type WorkspaceSummary = {
  itemId: string;
  name: string;
  surface: WorkspaceSurface;
  folderId: string;
  createdAt: string;
  docCount: number;
  pageCount: number;
  status: WorkspaceStatus;
  pendingCount: number;
  errorSummary?: string;
};

export type WorkspaceDetail = WorkspaceSummary & { kbWorkspaceId: string; docs: WorkspaceDoc[] };

export type WorkspaceDocumentProgress = {
  clientFileId: string;
  fileName: string;
  status: IngestStatus;
  docId?: string;
  pageCount: number;
  chunkCount: number;
  errorSummary?: string;
};

export type WorkspaceDetailWithProgress = WorkspaceDetail & {
  documentProgress: WorkspaceDocumentProgress[];
};

type PageText = { page: number; text: string };

type WorkspacePayload = {
  surface: WorkspaceSurface;
  kbWorkspaceId: string;
  requestFingerprint?: string;
  expectedDocCount: number;
  docs: WorkspaceDoc[];
  cleanupKeys: string[];
};

const WORKSPACE_STATUSES = new Set<WorkspaceStatus>(["saving", "ready", "error"]);

export function workspacePagesKey(principal: string, docId: string): string {
  return `kb/pages/${principal}/${docId}.json`;
}

function storageKeyOwnedBy(principal: string, key: string): boolean {
  const parts = key.split("/");
  const hasUnsafeCharacter = [...key].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 || character === "\\";
  });
  if (
    !key ||
    key.length > 1024 ||
    hasUnsafeCharacter ||
    parts.some(
      (part, index) => (!part && index !== parts.length - 1) || part === "." || part === "..",
    )
  ) {
    return false;
  }
  return (
    key.startsWith(`kb/pages/${principal}/`) ||
    key.startsWith(`kb/bda-output/${principal}/`) ||
    key.startsWith(`uploads/${principal}/`)
  );
}

function requireOwnedStorageKeys(principal: string, keys: Array<string | undefined>): string[] {
  const out = [...new Set(keys.filter((key): key is string => Boolean(key)))];
  if (out.some((key) => !storageKeyOwnedBy(principal, key))) {
    throw new Error("workspace contains an invalid storage key");
  }
  return out;
}

function safeErrorSummary(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean ? clean.slice(0, 240) : undefined;
}

function parseWorkspacePayload(row: Record<string, unknown>): WorkspacePayload {
  let parsed: Partial<WorkspacePayload> = {};
  try {
    parsed = JSON.parse((row.workspace as string) || "{}") as Partial<WorkspacePayload>;
  } catch {
    parsed = {};
  }
  return {
    surface:
      (parsed.surface as WorkspaceSurface) ?? (row.surface as WorkspaceSurface) ?? "workingset",
    kbWorkspaceId: (parsed.kbWorkspaceId as string) ?? (row.kbWorkspaceId as string) ?? "",
    requestFingerprint:
      (parsed.requestFingerprint as string | undefined) ??
      (row.requestFingerprint as string | undefined),
    expectedDocCount:
      typeof parsed.expectedDocCount === "number"
        ? parsed.expectedDocCount
        : typeof row.expectedDocCount === "number"
          ? (row.expectedDocCount as number)
          : Array.isArray(parsed.docs)
            ? parsed.docs.length
            : 0,
    docs: Array.isArray(parsed.docs) ? parsed.docs : [],
    cleanupKeys: Array.isArray(parsed.cleanupKeys)
      ? parsed.cleanupKeys.filter((key): key is string => typeof key === "string")
      : [],
  };
}

/** Store one doc's extracted pages as JSON in S3 for pile rehydrate. */
export async function putWorkspacePages(
  principal: string,
  docId: string,
  pages: PageText[],
): Promise<string> {
  const key = workspacePagesKey(principal, docId);
  await s3().send(
    new PutObjectCommand({
      Bucket: bucketName(),
      Key: key,
      Body: JSON.stringify(pages),
      ContentType: "application/json",
    }),
  );
  return key;
}

export type WorkspaceReservation = {
  itemId: string;
  kbWorkspaceId: string;
  status: WorkspaceStatus;
  pendingCount: number;
  docs: WorkspaceDoc[];
};

/**
 * Reserve the durable record before Aurora/S3 writes. The request id is also
 * the KB UUID and library item id, so an ambiguous client retry reaches the
 * same record and workspace partition.
 */
export async function reserveWorkspace(
  principal: string,
  args: {
    requestId: string;
    requestFingerprint: string;
    name: string;
    surface: WorkspaceSurface;
    folderId?: string;
    cleanupKeys?: string[];
    expectedDocCount?: number;
  },
): Promise<WorkspaceReservation> {
  const itemId = args.requestId;
  const kbWorkspaceId = args.requestId;
  const now = new Date().toISOString();
  const folderId = args.folderId ?? "ROOT";
  const cleanupKeys = requireOwnedStorageKeys(principal, args.cleanupKeys ?? []);
  const payload: WorkspacePayload = {
    surface: args.surface,
    kbWorkspaceId,
    requestFingerprint: args.requestFingerprint,
    expectedDocCount: Math.max(0, args.expectedDocCount ?? 0),
    docs: [],
    cleanupKeys,
  };
  const row = {
    PK: userPK(principal),
    SK: itemSK(itemId),
    entity: "item",
    type: "workspace",
    owner: principal,
    itemId,
    name: (args.name || "Untitled workspace").slice(0, 120),
    surface: args.surface,
    folderId,
    kbWorkspaceId,
    requestFingerprint: args.requestFingerprint,
    expectedDocCount: payload.expectedDocCount,
    workspace: JSON.stringify(payload),
    docCount: 0,
    pageCount: 0,
    status: "saving" as const,
    workspaceRevision: 0,
    saved: true,
    createdAt: now,
    updatedAt: now,
    GSI1PK: `FLD#${principal}#${folderId}`,
    GSI1SK: `ITEM#${now}#${itemId}`,
  };

  const created = await withRetry(() => putItemIfAbsent(row));
  if (created) {
    return {
      itemId,
      kbWorkspaceId,
      status: "saving",
      pendingCount: payload.expectedDocCount,
      docs: [],
    };
  }

  for (let attempt = 0; attempt < 4; attempt++) {
    const existing = await withRetry(() =>
      getItem(userPK(principal), itemSK(itemId), { consistent: true }),
    );
    if (!existing || existing.type !== "workspace" || existing.owner !== principal) {
      throw new Error("workspace save reservation is unavailable");
    }
    const existingPayload = parseWorkspacePayload(existing);
    if (
      existingPayload.kbWorkspaceId !== kbWorkspaceId ||
      existingPayload.requestFingerprint !== args.requestFingerprint ||
      (args.expectedDocCount !== undefined &&
        existingPayload.expectedDocCount !== args.expectedDocCount)
    ) {
      throw new Error("workspace save request does not match its reservation");
    }
    const status = WORKSPACE_STATUSES.has(existing.status as WorkspaceStatus)
      ? (existing.status as WorkspaceStatus)
      : "ready";
    if (status !== "saving") {
      return {
        itemId,
        kbWorkspaceId,
        status,
        pendingCount: 0,
        docs: existingPayload.docs,
      };
    }
    const mergedCleanup = requireOwnedStorageKeys(principal, [
      ...existingPayload.cleanupKeys,
      ...cleanupKeys,
    ]);
    const observedRevision =
      typeof existing.workspaceRevision === "number" &&
      Number.isSafeInteger(existing.workspaceRevision) &&
      existing.workspaceRevision >= 0
        ? existing.workspaceRevision
        : undefined;
    if (existing.workspaceRevision !== undefined && observedRevision === undefined) {
      throw new Error("workspace save reservation has an invalid revision");
    }
    const nextPayload = {
      ...existingPayload,
      expectedDocCount: args.expectedDocCount ?? existingPayload.expectedDocCount,
      cleanupKeys: mergedCleanup,
    } satisfies WorkspacePayload;
    try {
      await dynamo().send(
        new PutCommand({
          TableName: tableName(),
          Item: {
            ...existing,
            status: "saving",
            workspaceRevision: (observedRevision ?? 0) + 1,
            errorSummary: undefined,
            updatedAt: new Date().toISOString(),
            workspace: JSON.stringify(nextPayload),
          },
          ConditionExpression:
            observedRevision === undefined
              ? "#status = :saving AND attribute_not_exists(workspaceRevision)"
              : "#status = :saving AND workspaceRevision = :observedRevision",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":saving": "saving",
            ...(observedRevision !== undefined ? { ":observedRevision": observedRevision } : {}),
          },
        }),
      );
      return {
        itemId,
        kbWorkspaceId,
        status: "saving",
        pendingCount: Math.max(0, nextPayload.expectedDocCount - nextPayload.docs.length),
        docs: nextPayload.docs,
      };
    } catch (error) {
      if ((error as { name?: string } | undefined)?.name !== "ConditionalCheckFailedException") {
        throw error;
      }
    }
  }
  throw new Error("workspace save reservation update conflicted");
}

const workspaceDocPrefix = (itemId: string) => `WSDOC#${itemId}#`;
const workspaceDocSK = (itemId: string, clientFileId: string) =>
  `${workspaceDocPrefix(itemId)}${encodeURIComponent(clientFileId)}`;

export type WorkspaceDocumentCheckpoint = {
  itemId: string;
  clientFileId: string;
  status: IngestStatus;
  docId?: string;
  jobId?: string;
  fileName: string;
  mime?: string;
  size?: number;
  bytesKey?: string;
  pagesKey?: string;
  outputPrefix?: string;
  pageCount: number;
  chunkCount: number;
  errorSummary?: string;
  createdAt: string;
  updatedAt: string;
};

function toDocumentCheckpoint(row: Record<string, unknown>): WorkspaceDocumentCheckpoint {
  if (!isIngestStatus(row.status)) {
    throw new Error("workspace document checkpoint has an invalid status");
  }
  return {
    itemId: String(row.itemId ?? ""),
    clientFileId: String(row.clientFileId ?? ""),
    status: row.status,
    ...(typeof row.docId === "string" ? { docId: row.docId } : {}),
    ...(typeof row.jobId === "string" ? { jobId: row.jobId } : {}),
    fileName: String(row.fileName ?? "document"),
    ...(typeof row.mime === "string" ? { mime: row.mime } : {}),
    ...(typeof row.size === "number" ? { size: row.size } : {}),
    ...(typeof row.bytesKey === "string" ? { bytesKey: row.bytesKey } : {}),
    ...(typeof row.pagesKey === "string" ? { pagesKey: row.pagesKey } : {}),
    ...(typeof row.outputPrefix === "string" ? { outputPrefix: row.outputPrefix } : {}),
    pageCount: typeof row.pageCount === "number" ? row.pageCount : 0,
    chunkCount: typeof row.chunkCount === "number" ? row.chunkCount : 0,
    ...(safeErrorSummary(row.errorSummary)
      ? { errorSummary: safeErrorSummary(row.errorSummary) }
      : {}),
    createdAt: String(row.createdAt ?? ""),
    updatedAt: String(row.updatedAt ?? ""),
  };
}

function toDocumentProgress(checkpoint: WorkspaceDocumentCheckpoint): WorkspaceDocumentProgress {
  return {
    clientFileId: checkpoint.clientFileId,
    fileName: checkpoint.fileName,
    status: checkpoint.status,
    ...(checkpoint.docId ? { docId: checkpoint.docId } : {}),
    pageCount: checkpoint.pageCount,
    chunkCount: checkpoint.chunkCount,
    ...(checkpoint.errorSummary ? { errorSummary: checkpoint.errorSummary } : {}),
  };
}

function legacyReadyProgress(docs: WorkspaceDoc[]): WorkspaceDocumentProgress[] {
  return docs.map((document) => ({
    clientFileId: document.sourceFileId ?? document.docId,
    fileName: document.fileName,
    status: "ready",
    docId: document.docId,
    pageCount: document.pageCount,
    chunkCount: document.chunkCount,
  }));
}

/** Reserve one owner-scoped document checkpoint before any external work. */
export async function reserveWorkspaceDocument(
  principal: string,
  args: {
    itemId: string;
    clientFileId: string;
    fileName: string;
    mime?: string;
    size?: number;
    bytesKey?: string;
  },
): Promise<void> {
  requireClientFileId(args.clientFileId);
  const parent = await getItem(userPK(principal), itemSK(args.itemId), {
    consistent: true,
  });
  if (!parent || parent.type !== "workspace" || parent.owner !== principal) {
    throw new Error("workspace save reservation was not found");
  }
  const [bytesKey] = requireOwnedStorageKeys(principal, [args.bytesKey]);
  const now = new Date().toISOString();
  const row = {
    PK: userPK(principal),
    SK: workspaceDocSK(args.itemId, args.clientFileId),
    entity: "workspace-document",
    owner: principal,
    itemId: args.itemId,
    clientFileId: args.clientFileId,
    fileName: (args.fileName || "document").slice(0, 240),
    ...(args.mime ? { mime: args.mime.slice(0, 200) } : {}),
    ...(args.size !== undefined ? { size: args.size } : {}),
    ...(bytesKey ? { bytesKey } : {}),
    status: "queued" as const,
    pageCount: 0,
    chunkCount: 0,
    checkpointRevision: 0,
    createdAt: now,
    updatedAt: now,
  };
  const created = await putItemIfAbsent(row);
  if (created) return;
  const existing = await getItem(
    userPK(principal),
    workspaceDocSK(args.itemId, args.clientFileId),
    { consistent: true },
  );
  if (
    !existing ||
    existing.owner !== principal ||
    existing.itemId !== args.itemId ||
    existing.clientFileId !== args.clientFileId ||
    existing.fileName !== row.fileName ||
    (existing.mime ?? undefined) !== (row.mime ?? undefined) ||
    (existing.size ?? undefined) !== (row.size ?? undefined) ||
    (existing.bytesKey ?? undefined) !== (bytesKey ?? undefined)
  ) {
    throw new Error("workspace document reservation conflict");
  }
}

export async function listWorkspaceDocumentCheckpoints(
  principal: string,
  itemId: string,
): Promise<WorkspaceDocumentCheckpoint[]> {
  const rows = await queryPrefix(userPK(principal), workspaceDocPrefix(itemId), {
    consistent: true,
  });
  return rows
    .filter(
      (row) =>
        row.entity === "workspace-document" && row.owner === principal && row.itemId === itemId,
    )
    .map(toDocumentCheckpoint);
}

export async function checkpointWorkspaceDocument(
  principal: string,
  patch: {
    itemId: string;
    clientFileId: string;
    status: IngestStatus;
    docId?: string;
    jobId?: string;
    fileName?: string;
    mime?: string;
    size?: number;
    bytesKey?: string;
    pagesKey?: string;
    outputPrefix?: string;
    pageCount?: number;
    chunkCount?: number;
    errorKind?: TerminalErrorKind;
  },
): Promise<void> {
  requireClientFileId(patch.clientFileId);
  if (!isIngestStatus(patch.status)) throw new Error("invalid workspace document status");
  if (patch.docId !== undefined && !isUuid(patch.docId)) {
    throw new Error("invalid workspace document id");
  }
  if (patch.jobId !== undefined) requireJobLookupId(patch.jobId);
  const key = {
    PK: userPK(principal),
    SK: workspaceDocSK(patch.itemId, patch.clientFileId),
  };
  requireOwnedStorageKeys(principal, [patch.bytesKey, patch.pagesKey, patch.outputPrefix]);
  for (let attempt = 0; attempt < 4; attempt++) {
    const current = await getItem(key.PK, key.SK, { consistent: true });
    if (
      !current ||
      current.entity !== "workspace-document" ||
      current.owner !== principal ||
      current.itemId !== patch.itemId ||
      !isIngestStatus(current.status)
    ) {
      throw new Error("workspace document checkpoint was not found");
    }
    if (patch.fileName !== undefined && current.fileName !== patch.fileName.slice(0, 240)) {
      throw new Error("workspace document metadata conflict");
    }
    for (const [field, value] of [
      ["docId", patch.docId],
      ["jobId", patch.jobId],
      ["bytesKey", patch.bytesKey],
      ["pagesKey", patch.pagesKey],
      ["outputPrefix", patch.outputPrefix],
    ] as const) {
      if (value !== undefined && current[field] !== undefined && current[field] !== value) {
        throw new Error("workspace document metadata conflict");
      }
    }
    const decision = decideIngestTransition(current.status, patch.status);
    // At-least-once deliveries can arrive after a newer worker has advanced
    // this document. Validate immutable correlation above, then ignore stale
    // transitions so ready/error can never be overwritten.
    if (
      decision === "reject" ||
      (decision === "noop" && (current.status === "ready" || current.status === "error"))
    ) {
      return;
    }
    const observedRevision =
      typeof current.checkpointRevision === "number" &&
      Number.isSafeInteger(current.checkpointRevision) &&
      current.checkpointRevision >= 0
        ? current.checkpointRevision
        : undefined;
    if (current.checkpointRevision !== undefined && observedRevision === undefined) {
      throw new Error("workspace document checkpoint has an invalid revision");
    }
    const next = {
      ...current,
      fileName: String(current.fileName ?? "document"),
      status: patch.status,
      checkpointRevision: (observedRevision ?? 0) + 1,
      updatedAt: new Date().toISOString(),
      ...(patch.docId !== undefined ? { docId: patch.docId } : {}),
      ...(patch.jobId !== undefined ? { jobId: patch.jobId } : {}),
      ...(patch.mime !== undefined ? { mime: patch.mime.slice(0, 200) } : {}),
      ...(patch.size !== undefined ? { size: patch.size } : {}),
      ...(patch.bytesKey !== undefined ? { bytesKey: patch.bytesKey } : {}),
      ...(patch.pagesKey !== undefined ? { pagesKey: patch.pagesKey } : {}),
      ...(patch.outputPrefix !== undefined ? { outputPrefix: patch.outputPrefix } : {}),
      ...(patch.pageCount !== undefined ? { pageCount: Math.max(0, patch.pageCount) } : {}),
      ...(patch.chunkCount !== undefined ? { chunkCount: Math.max(0, patch.chunkCount) } : {}),
      ...(patch.errorKind ? { errorSummary: terminalErrorSummary(patch.errorKind) } : {}),
    };
    if (patch.status === "ready" && (!next.docId || !next.pagesKey || !next.fileName)) {
      throw new Error("ready workspace document is incomplete");
    }
    try {
      await dynamo().send(
        new PutCommand({
          TableName: tableName(),
          Item: next,
          ConditionExpression:
            observedRevision === undefined
              ? "#status = :observed AND attribute_not_exists(checkpointRevision)"
              : "#status = :observed AND checkpointRevision = :observedRevision",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":observed": current.status,
            ...(observedRevision !== undefined ? { ":observedRevision": observedRevision } : {}),
          },
        }),
      );
      return;
    } catch (error) {
      if ((error as { name?: string } | undefined)?.name !== "ConditionalCheckFailedException") {
        throw error;
      }
    }
  }
  throw new Error("workspace document checkpoint update conflicted");
}

/**
 * Aggregate child checkpoints into the parent without allowing an older
 * worker's saving snapshot to overwrite a ready/error terminal parent.
 */
export async function finalizeWorkspaceFromCheckpoints(
  principal: string,
  itemId: string,
): Promise<WorkspaceDetailWithProgress> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const [parent, checkpoints] = await Promise.all([
      getItem(userPK(principal), itemSK(itemId), { consistent: true }),
      listWorkspaceDocumentCheckpoints(principal, itemId),
    ]);
    if (!parent || parent.type !== "workspace" || parent.owner !== principal) {
      throw new Error("workspace save reservation was not found");
    }
    const payload = parseWorkspacePayload(parent);
    const expectedDocCount = payload.expectedDocCount || checkpoints.length;
    const aggregate = aggregateWorkspaceCheckpoints(expectedDocCount, checkpoints);
    const currentStatus = WORKSPACE_STATUSES.has(parent.status as WorkspaceStatus)
      ? (parent.status as WorkspaceStatus)
      : "saving";
    const status =
      currentStatus === "ready" || currentStatus === "error" ? currentStatus : aggregate.status;
    const docs: WorkspaceDoc[] = checkpoints
      .filter(
        (
          checkpoint,
        ): checkpoint is WorkspaceDocumentCheckpoint & {
          docId: string;
          pagesKey: string;
        } =>
          checkpoint.status === "ready" &&
          Boolean(checkpoint.docId) &&
          Boolean(checkpoint.pagesKey),
      )
      .map((checkpoint) => ({
        docId: checkpoint.docId,
        sourceFileId: checkpoint.clientFileId,
        fileName: checkpoint.fileName,
        pageCount: checkpoint.pageCount,
        chunkCount: checkpoint.chunkCount,
        pagesKey: checkpoint.pagesKey,
        ...(checkpoint.bytesKey ? { bytesKey: checkpoint.bytesKey } : {}),
        ...(checkpoint.mime ? { mime: checkpoint.mime } : {}),
        ...(checkpoint.size !== undefined ? { size: checkpoint.size } : {}),
      }));
    const cleanupKeys = requireOwnedStorageKeys(principal, [
      ...payload.cleanupKeys,
      ...checkpoints.flatMap((checkpoint) => [
        checkpoint.bytesKey,
        checkpoint.pagesKey,
        checkpoint.outputPrefix,
      ]),
    ]);
    const errorSummary =
      status === "error"
        ? `Workspace ingest failed for ${aggregate.failedCount} of ${expectedDocCount} documents.`
        : undefined;
    const observedRevision =
      typeof parent.workspaceRevision === "number" &&
      Number.isSafeInteger(parent.workspaceRevision) &&
      parent.workspaceRevision >= 0
        ? parent.workspaceRevision
        : undefined;
    if (parent.workspaceRevision !== undefined && observedRevision === undefined) {
      throw new Error("workspace save reservation has an invalid revision");
    }
    const next = {
      ...parent,
      status,
      workspaceRevision: (observedRevision ?? 0) + 1,
      pendingCount: status === "ready" ? 0 : aggregate.pendingCount,
      errorSummary,
      docCount: docs.length,
      pageCount: docs.reduce((total, document) => {
        return total + document.pageCount;
      }, 0),
      updatedAt: new Date().toISOString(),
      workspace: JSON.stringify({
        ...payload,
        expectedDocCount,
        docs,
        cleanupKeys,
      } satisfies WorkspacePayload),
    };
    try {
      await dynamo().send(
        new PutCommand({
          TableName: tableName(),
          Item: next,
          ConditionExpression:
            observedRevision === undefined
              ? "#status = :observed AND attribute_not_exists(workspaceRevision)"
              : "#status = :observed AND workspaceRevision = :observedRevision",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":observed": parent.status,
            ...(observedRevision !== undefined ? { ":observedRevision": observedRevision } : {}),
          },
        }),
      );
      return {
        ...toSummary(next),
        kbWorkspaceId: payload.kbWorkspaceId,
        docs,
        documentProgress: checkpoints.map(toDocumentProgress),
      };
    } catch (error) {
      if ((error as { name?: string } | undefined)?.name !== "ConditionalCheckFailedException") {
        throw error;
      }
    }
  }
  throw new Error("workspace aggregation update conflicted");
}

/** Checkpoint a terminal state after all bounded file tasks settle. */
export async function finalizeWorkspace(
  principal: string,
  args: {
    itemId: string;
    requestFingerprint: string;
    status: "ready" | "error";
    docs: WorkspaceDoc[];
    cleanupKeys?: string[];
    errorSummary?: string;
  },
): Promise<void> {
  const existing = await withRetry(() =>
    getItem(userPK(principal), itemSK(args.itemId), { consistent: true }),
  );
  if (!existing || existing.type !== "workspace" || existing.owner !== principal) {
    throw new Error("workspace save reservation was not found");
  }
  const payload = parseWorkspacePayload(existing);
  if (payload.requestFingerprint !== args.requestFingerprint) {
    throw new Error("workspace save request does not match its reservation");
  }
  const cleanupKeys = requireOwnedStorageKeys(principal, [
    ...payload.cleanupKeys,
    ...(args.cleanupKeys ?? []),
    ...args.docs.flatMap((doc) => [doc.pagesKey, doc.bytesKey]),
  ]);
  const pageCount = args.docs.reduce((total, doc) => total + (doc.pageCount || 0), 0);
  await withRetry(() =>
    putItem({
      ...existing,
      status: args.status,
      pendingCount: 0,
      errorSummary: safeErrorSummary(args.errorSummary),
      docCount: args.docs.length,
      pageCount,
      updatedAt: new Date().toISOString(),
      workspace: JSON.stringify({
        ...payload,
        docs: args.docs,
        cleanupKeys,
      } satisfies WorkspacePayload),
    }),
  );
}

function toSummary(r: Record<string, unknown>): WorkspaceSummary {
  const status = WORKSPACE_STATUSES.has(r.status as WorkspaceStatus)
    ? (r.status as WorkspaceStatus)
    : "ready";
  const summary = safeErrorSummary(r.errorSummary);
  return {
    itemId: r.itemId as string,
    name: (r.name as string) ?? "Untitled workspace",
    surface: (r.surface as WorkspaceSurface) ?? "workingset",
    folderId: (r.folderId as string) ?? "ROOT",
    createdAt: (r.createdAt as string) ?? "",
    docCount: typeof r.docCount === "number" ? (r.docCount as number) : 0,
    pageCount: typeof r.pageCount === "number" ? (r.pageCount as number) : 0,
    status,
    pendingCount: typeof r.pendingCount === "number" ? (r.pendingCount as number) : 0,
    ...(summary ? { errorSummary: summary } : {}),
  };
}

/** List the user's workspaces, most recent first, optionally by surface. */
export async function listWorkspaces(
  principal: string,
  surface?: WorkspaceSurface,
): Promise<WorkspaceSummary[]> {
  const rows = await queryPrefix(userPK(principal), "ITEM#", { scanForward: false });
  return rows
    .filter((r) => r.type === "workspace" && (!surface || r.surface === surface))
    .map(toSummary);
}

async function getWorkspaceState(
  principal: string,
  itemId: string,
): Promise<{
  detail: WorkspaceDetail;
  payload: WorkspacePayload;
} | null> {
  const row = await getItem(userPK(principal), itemSK(itemId), {
    consistent: true,
  });
  if (!row || row.type !== "workspace" || row.owner !== principal) return null;
  const payload = parseWorkspacePayload(row);
  return {
    detail: {
      ...toSummary(row),
      kbWorkspaceId: payload.kbWorkspaceId,
      docs: payload.docs,
    },
    payload,
  };
}

/** Full workspace including its doc manifest (for reload / download). */
export async function getWorkspace(
  principal: string,
  itemId: string,
): Promise<WorkspaceDetailWithProgress | null> {
  const state = await getWorkspaceState(principal, itemId);
  if (!state) return null;
  const checkpoints = await listWorkspaceDocumentCheckpoints(principal, itemId);
  return {
    ...state.detail,
    documentProgress: checkpoints.length
      ? checkpoints.map(toDocumentProgress)
      : legacyReadyProgress(state.detail.docs),
  };
}

/** Internal owner-scoped reservation view used by authenticated async start. */
export async function getWorkspaceIngestReservation(
  principal: string,
  itemId: string,
): Promise<{
  itemId: string;
  kbWorkspaceId: string;
  surface: WorkspaceSurface;
  status: WorkspaceStatus;
  requestFingerprint: string;
} | null> {
  const state = await getWorkspaceState(principal, itemId);
  if (!state) return null;
  const requestFingerprint = state.payload.requestFingerprint;
  if (!requestFingerprint || !isSha256(requestFingerprint)) return null;
  return {
    itemId: state.detail.itemId,
    kbWorkspaceId: state.detail.kbWorkspaceId,
    surface: state.detail.surface,
    status: state.detail.status,
    requestFingerprint,
  };
}

export type WorkspaceIngestStatus = {
  itemId: string;
  status: WorkspaceStatus;
  stage: IngestStatus;
  pendingCount: number;
  docCount: number;
  chunkCount: number;
  documents: {
    clientFileId: string;
    fileName: string;
    status: IngestStatus;
    docId?: string;
    pageCount: number;
    chunkCount: number;
    errorSummary?: string;
  }[];
  errorSummary?: string;
};

/** Owner-scoped polling shape. It exposes no job id, invocation ARN, or key. */
export async function getWorkspaceIngestStatus(
  principal: string,
  itemId: string,
): Promise<WorkspaceIngestStatus | null> {
  const current = await getWorkspace(principal, itemId);
  if (!current) return null;
  const detail =
    current.status === "saving"
      ? await finalizeWorkspaceFromCheckpoints(principal, itemId)
      : current;
  const checkpoints = detail.documentProgress;
  const stage: IngestStatus =
    detail.status === "ready"
      ? "ready"
      : detail.status === "error"
        ? "error"
        : checkpoints.some((checkpoint) => checkpoint.status === "embedding")
          ? "embedding"
          : checkpoints.some((checkpoint) => checkpoint.status === "converting")
            ? "converting"
            : "queued";
  return {
    itemId: detail.itemId,
    status: detail.status,
    stage,
    pendingCount: detail.pendingCount,
    docCount: detail.docs.length,
    chunkCount: detail.docs.reduce((total, document) => total + document.chunkCount, 0),
    documents: checkpoints,
    ...(detail.errorSummary ? { errorSummary: detail.errorSummary } : {}),
  };
}

/** Fetch a doc's stored pages for pile rehydrate (ownership-checked). */
export async function getWorkspacePages(
  principal: string,
  itemId: string,
  docId: string,
): Promise<PageText[]> {
  const ws = await getWorkspace(principal, itemId);
  const doc = ws?.docs.find((d) => d.docId === docId);
  if (!doc) throw new Error("document not found in workspace");
  if (!doc.pagesKey.startsWith(`kb/pages/${principal}/`)) {
    throw new Error("invalid pages key");
  }
  const r = await s3().send(new GetObjectCommand({ Bucket: bucketName(), Key: doc.pagesKey }));
  const text = await r.Body?.transformToString();
  return text ? (JSON.parse(text) as PageText[]) : [];
}

/** Presigned download for a doc's original bytes, if stored. */
export async function getWorkspaceDownloadUrl(
  principal: string,
  itemId: string,
  docId: string,
): Promise<{ url: string } | null> {
  const ws = await getWorkspace(principal, itemId);
  const doc = ws?.docs.find((d) => d.docId === docId);
  if (!doc?.bytesKey) return null;
  if (!doc.bytesKey.startsWith(`uploads/${principal}/`)) {
    throw new Error("invalid download key");
  }
  const url = await presignGet(doc.bytesKey, doc.fileName, doc.mime);
  return { url };
}

export type WorkspaceDeleteFailure = {
  stage: "dynamo" | "aurora" | "s3";
  target:
    | "metadata"
    | "workspace-data"
    | "pages"
    | "bytes"
    | "bda-output"
    | "checkpoints"
    | "job-correlation";
  summary: string;
};

export type WorkspaceDeleteResult = {
  ok: boolean;
  alreadyDeleted: boolean;
  deleted: {
    auroraDocuments: number;
    s3Objects: number;
    metadata: boolean;
  };
  failures: WorkspaceDeleteFailure[];
};

function storageTarget(
  principal: string,
  key: string,
): "pages" | "bytes" | "bda-output" | undefined {
  if (key.startsWith(`kb/pages/${principal}/`)) return "pages";
  if (key.startsWith(`uploads/${principal}/`)) return "bytes";
  if (key.startsWith(`kb/bda-output/${principal}/`)) return "bda-output";
  return undefined;
}

/**
 * Delete in dependency order: Aurora documents (chunks cascade), S3 objects,
 * then DynamoDB metadata. Metadata is retained whenever an earlier stage fails
 * so an identical delete request can safely resume.
 */
export async function deleteWorkspace(
  principal: string,
  itemId: string,
): Promise<WorkspaceDeleteResult> {
  let state: Awaited<ReturnType<typeof getWorkspaceState>>;
  try {
    state = await withRetry(() => getWorkspaceState(principal, itemId));
  } catch {
    return {
      ok: false,
      alreadyDeleted: false,
      deleted: { auroraDocuments: 0, s3Objects: 0, metadata: false },
      failures: [
        {
          stage: "dynamo",
          target: "metadata",
          summary: "Could not read workspace metadata.",
        },
      ],
    };
  }
  if (!state) {
    return {
      ok: true,
      alreadyDeleted: true,
      deleted: { auroraDocuments: 0, s3Objects: 0, metadata: true },
      failures: [],
    };
  }
  const failures: WorkspaceDeleteFailure[] = [];
  let checkpoints: WorkspaceDocumentCheckpoint[];
  try {
    checkpoints = await listWorkspaceDocumentCheckpoints(principal, itemId);
  } catch {
    return {
      ok: false,
      alreadyDeleted: false,
      deleted: { auroraDocuments: 0, s3Objects: 0, metadata: false },
      failures: [
        {
          stage: "dynamo",
          target: "checkpoints",
          summary: "Could not read workspace document checkpoints.",
        },
      ],
    };
  }

  // Remove exact correlation rows first so newly delivered events cannot begin
  // owner-scoped processing after artifacts are deleted. BDA itself has no
  // reliable cancellation contract here and may finish writing output later.
  const jobIds = [
    ...new Set(checkpoints.flatMap((checkpoint) => (checkpoint.jobId ? [checkpoint.jobId] : []))),
  ];
  if (jobIds.length) {
    try {
      const [{ loadKbAsyncIngestConfig }, { createIngestJobStore }] = await Promise.all([
        import("@/lib/config.server"),
        import("@/lib/kb/ingest-job-store.server"),
      ]);
      const config = loadKbAsyncIngestConfig();
      if (!config.jobsTable) throw new Error("async ingest is not configured");
      const jobs = createIngestJobStore({ config });
      await mapPool(jobIds, 3, (jobId) => jobs.delete(jobId));
    } catch {
      return {
        ok: false,
        alreadyDeleted: false,
        deleted: { auroraDocuments: 0, s3Objects: 0, metadata: false },
        failures: [
          {
            stage: "dynamo",
            target: "job-correlation",
            summary: "Could not delete ingest-job correlation records.",
          },
        ],
      };
    }
  }

  let deletedDocuments: Awaited<ReturnType<typeof deleteWorkspaceDocuments>> = [];
  if (!state.detail.kbWorkspaceId) {
    failures.push({
      stage: "aurora",
      target: "workspace-data",
      summary: "Workspace metadata has no KB workspace id.",
    });
  } else {
    try {
      deletedDocuments = await deleteWorkspaceDocuments(principal, state.detail.kbWorkspaceId);
    } catch {
      failures.push({
        stage: "aurora",
        target: "workspace-data",
        summary: "Could not delete indexed workspace data.",
      });
    }
  }
  if (failures.length) {
    return {
      ok: false,
      alreadyDeleted: false,
      deleted: {
        auroraDocuments: deletedDocuments.length,
        s3Objects: 0,
        metadata: false,
      },
      failures,
    };
  }

  const storage = new Map<string, "pages" | "bytes" | "bda-output">();
  const addStorageKey = (key: string | undefined, expected?: "pages" | "bytes" | "bda-output") => {
    if (!key) return;
    const target = storageTarget(principal, key);
    if (!target || (expected && target !== expected)) {
      failures.push({
        stage: "s3",
        target: expected ?? "pages",
        summary: "Workspace metadata contains an invalid storage key.",
      });
      return;
    }
    storage.set(key, target);
  };

  for (const key of state.payload.cleanupKeys) addStorageKey(key);
  for (const doc of state.detail.docs) {
    addStorageKey(doc.pagesKey, "pages");
    addStorageKey(doc.bytesKey, "bytes");
  }
  for (const checkpoint of checkpoints) {
    addStorageKey(checkpoint.pagesKey, "pages");
    addStorageKey(checkpoint.bytesKey, "bytes");
    addStorageKey(checkpoint.outputPrefix, "bda-output");
  }
  for (const doc of deletedDocuments) {
    addStorageKey(workspacePagesKey(principal, doc.doc_id), "pages");
    addStorageKey(doc.s3_key ?? undefined, "pages");
    addStorageKey(doc.bda_input_key ?? undefined, "bytes");
    addStorageKey(doc.bda_output_prefix ?? undefined, "bda-output");
  }

  const storageResults = await mapPool([...storage.entries()], 3, async ([key, target]) => {
    try {
      const count =
        target === "bda-output"
          ? await withRetry(() => deletePrefix(key), {
              tries: 3,
              baseMs: 200,
            })
          : await withRetry(
              async () => {
                await deleteObject(key);
                return 1;
              },
              { tries: 3, baseMs: 200 },
            );
      return { ok: true as const, target, count };
    } catch {
      return { ok: false as const, target, count: 0 };
    }
  });
  let s3Objects = 0;
  for (const result of storageResults) {
    if (result.ok) {
      s3Objects += result.count;
    } else {
      failures.push({
        stage: "s3",
        target: result.target,
        summary:
          result.target === "pages"
            ? "Could not delete a saved pages object."
            : result.target === "bda-output"
              ? "Could not delete BDA output objects."
              : "Could not delete an original-file object.",
      });
    }
  }

  let metadata = false;
  if (!failures.length) {
    try {
      await batchDelete(
        checkpoints.map((checkpoint) => ({
          PK: userPK(principal),
          SK: workspaceDocSK(itemId, checkpoint.clientFileId),
        })),
      );
    } catch {
      failures.push({
        stage: "dynamo",
        target: "checkpoints",
        summary: "Could not delete workspace document checkpoints.",
      });
    }
  }
  if (!failures.length) {
    try {
      await withRetry(() => deleteItem(userPK(principal), itemSK(itemId)), {
        tries: 3,
        baseMs: 200,
      });
      metadata = true;
    } catch {
      failures.push({
        stage: "dynamo",
        target: "metadata",
        summary: "Could not delete workspace metadata.",
      });
    }
  }

  return {
    ok: failures.length === 0,
    alreadyDeleted: false,
    deleted: {
      auroraDocuments: deletedDocuments.length,
      s3Objects,
      metadata,
    },
    failures,
  };
}
