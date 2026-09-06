// Saved KB workspaces (server-only). A workspace is a named, reloadable unit:
//  - chunks + embeddings live in Aurora kb.chunks (queryable; written by ingest)
//  - extracted pages live in S3 (kb/pages/...) for one-click pile rehydrate
//  - original bytes live in S3 (optional; uploaded via the presigned flow)
//  - the record is a DynamoDB library item (type=workspace) with folders (GSI1),
//    reusing the existing library layer.
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

import {
  putItem,
  putItemIfAbsent,
  getItem,
  queryPrefix,
  deleteItem,
} from "@/lib/data/dynamo.server";
import { bucketName, s3, presignGet, deleteObject } from "@/lib/data/s3.server";
import { deleteWorkspaceDocuments } from "@/lib/kb/aurora.server";
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
  errorSummary?: string;
};

export type WorkspaceDetail = WorkspaceSummary & { kbWorkspaceId: string; docs: WorkspaceDoc[] };

type PageText = { page: number; text: string };

type WorkspacePayload = {
  surface: WorkspaceSurface;
  kbWorkspaceId: string;
  requestFingerprint?: string;
  docs: WorkspaceDoc[];
  cleanupKeys: string[];
};

const WORKSPACE_STATUSES = new Set<WorkspaceStatus>(["saving", "ready", "error"]);

export function workspacePagesKey(principal: string, docId: string): string {
  return `kb/pages/${principal}/${docId}.json`;
}

function storageKeyOwnedBy(principal: string, key: string): boolean {
  return (
    key.startsWith(`kb/pages/${principal}/`) ||
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
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
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
      (parsed.surface as WorkspaceSurface) ??
      (row.surface as WorkspaceSurface) ??
      "workingset",
    kbWorkspaceId:
      (parsed.kbWorkspaceId as string) ?? (row.kbWorkspaceId as string) ?? "",
    requestFingerprint:
      (parsed.requestFingerprint as string | undefined) ??
      (row.requestFingerprint as string | undefined),
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
    workspace: JSON.stringify(payload),
    docCount: 0,
    pageCount: 0,
    status: "saving" as const,
    saved: true,
    createdAt: now,
    updatedAt: now,
    GSI1PK: `FLD#${principal}#${folderId}`,
    GSI1SK: `ITEM#${now}#${itemId}`,
  };

  const created = await withRetry(() => putItemIfAbsent(row));
  if (created) {
    return { itemId, kbWorkspaceId, status: "saving", docs: [] };
  }

  const existing = await withRetry(() =>
    getItem(userPK(principal), itemSK(itemId), { consistent: true }),
  );
  if (!existing || existing.type !== "workspace" || existing.owner !== principal) {
    throw new Error("workspace save reservation is unavailable");
  }
  const existingPayload = parseWorkspacePayload(existing);
  if (
    existingPayload.kbWorkspaceId !== kbWorkspaceId ||
    existingPayload.requestFingerprint !== args.requestFingerprint
  ) {
    throw new Error("workspace save request does not match its reservation");
  }
  const status = WORKSPACE_STATUSES.has(existing.status as WorkspaceStatus)
    ? (existing.status as WorkspaceStatus)
    : "ready";
  if (status !== "ready") {
    const mergedCleanup = requireOwnedStorageKeys(principal, [
      ...existingPayload.cleanupKeys,
      ...cleanupKeys,
    ]);
    await withRetry(() =>
      putItem({
        ...existing,
        status: "saving",
        errorSummary: undefined,
        updatedAt: new Date().toISOString(),
        workspace: JSON.stringify({
          ...existingPayload,
          cleanupKeys: mergedCleanup,
        } satisfies WorkspacePayload),
      }),
    );
  }
  return { itemId, kbWorkspaceId, status, docs: existingPayload.docs };
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
  const pageCount = args.docs.reduce(
    (total, doc) => total + (doc.pageCount || 0),
    0,
  );
  await withRetry(() =>
    putItem({
      ...existing,
      status: args.status,
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
): Promise<WorkspaceDetail | null> {
  return (await getWorkspaceState(principal, itemId))?.detail ?? null;
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
  const r = await s3().send(
    new GetObjectCommand({ Bucket: bucketName(), Key: doc.pagesKey }),
  );
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
  target: "metadata" | "workspace-data" | "pages" | "bytes";
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
): "pages" | "bytes" | undefined {
  if (key.startsWith(`kb/pages/${principal}/`)) return "pages";
  if (key.startsWith(`uploads/${principal}/`)) return "bytes";
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
  let deletedDocuments: Awaited<ReturnType<typeof deleteWorkspaceDocuments>> = [];
  if (!state.detail.kbWorkspaceId) {
    failures.push({
      stage: "aurora",
      target: "workspace-data",
      summary: "Workspace metadata has no KB workspace id.",
    });
  } else {
    try {
      deletedDocuments = await deleteWorkspaceDocuments(
        principal,
        state.detail.kbWorkspaceId,
      );
    } catch {
      failures.push({
        stage: "aurora",
        target: "workspace-data",
        summary: "Could not delete indexed workspace data.",
      });
    }
  }

  const storage = new Map<string, "pages" | "bytes">();
  const addStorageKey = (key: string | undefined, expected?: "pages" | "bytes") => {
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
  for (const doc of deletedDocuments) {
    addStorageKey(workspacePagesKey(principal, doc.doc_id), "pages");
    addStorageKey(doc.s3_key ?? undefined, "pages");
  }

  const storageResults = await mapPool(
    [...storage.entries()],
    3,
    async ([key, target]) => {
      try {
        await withRetry(() => deleteObject(key), { tries: 3, baseMs: 200 });
        return { ok: true as const, target };
      } catch {
        return { ok: false as const, target };
      }
    },
  );
  let s3Objects = 0;
  for (const result of storageResults) {
    if (result.ok) {
      s3Objects += 1;
    } else {
      failures.push({
        stage: "s3",
        target: result.target,
        summary:
          result.target === "pages"
            ? "Could not delete a saved pages object."
            : "Could not delete an original-file object.",
      });
    }
  }

  let metadata = false;
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
