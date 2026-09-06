// Saved KB workspaces (server-only). A workspace is a named, reloadable unit:
//  - chunks + embeddings live in Aurora kb.chunks (queryable; written by ingest)
//  - extracted pages live in S3 (kb/pages/...) for one-click pile rehydrate
//  - original bytes live in S3 (optional; uploaded via the presigned flow)
//  - the record is a DynamoDB library item (type=workspace) with folders (GSI1),
//    reusing the existing library layer.
import { ulid } from "ulid";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

import {
  putItem,
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

export type WorkspaceDoc = {
  docId: string;
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
};

export type WorkspaceDetail = WorkspaceSummary & { kbWorkspaceId: string; docs: WorkspaceDoc[] };

type PageText = { page: number; text: string };

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

/** Create a completed workspace record after all document artifacts are saved. */
export async function saveWorkspace(
  principal: string,
  args: {
    name: string;
    surface: WorkspaceSurface;
    kbWorkspaceId: string;
    folderId?: string;
    docs: WorkspaceDoc[];
  },
): Promise<{ itemId: string }> {
  requireOwnedStorageKeys(
    principal,
    args.docs.flatMap((doc) => [doc.pagesKey, doc.bytesKey]),
  );
  const itemId = ulid();
  const now = new Date().toISOString();
  const folderId = args.folderId ?? "ROOT";
  const pageCount = args.docs.reduce((total, doc) => total + (doc.pageCount || 0), 0);
  await putItem({
    PK: userPK(principal),
    SK: itemSK(itemId),
    entity: "item",
    type: "workspace",
    owner: principal,
    itemId,
    name: (args.name || "Untitled workspace").slice(0, 120),
    surface: args.surface,
    folderId,
    kbWorkspaceId: args.kbWorkspaceId,
    workspace: JSON.stringify({
      surface: args.surface,
      kbWorkspaceId: args.kbWorkspaceId,
      docs: args.docs,
    }),
    docCount: args.docs.length,
    pageCount,
    saved: true,
    createdAt: now,
    GSI1PK: `FLD#${principal}#${folderId}`,
    GSI1SK: `ITEM#${now}#${itemId}`,
  });
  return { itemId };
}

function toSummary(r: Record<string, unknown>): WorkspaceSummary {
  return {
    itemId: r.itemId as string,
    name: (r.name as string) ?? "Untitled workspace",
    surface: (r.surface as WorkspaceSurface) ?? "workingset",
    folderId: (r.folderId as string) ?? "ROOT",
    createdAt: (r.createdAt as string) ?? "",
    docCount: typeof r.docCount === "number" ? (r.docCount as number) : 0,
    pageCount: typeof r.pageCount === "number" ? (r.pageCount as number) : 0,
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
): Promise<WorkspaceDetail | null> {
  const row = await getItem(userPK(principal), itemSK(itemId));
  if (!row || row.type !== "workspace" || row.owner !== principal) return null;
  let docs: WorkspaceDoc[] = [];
  try {
    docs = (JSON.parse((row.workspace as string) || "{}") as { docs?: WorkspaceDoc[] }).docs ?? [];
  } catch {
    docs = [];
  }
  return {
    ...toSummary(row),
    kbWorkspaceId: (row.kbWorkspaceId as string) ?? "",
    docs,
  };
}

/** Full workspace including its doc manifest (for reload / download). */
export async function getWorkspace(
  principal: string,
  itemId: string,
): Promise<WorkspaceDetail | null> {
  return getWorkspaceState(principal, itemId);
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
  if (!state.kbWorkspaceId) {
    failures.push({
      stage: "aurora",
      target: "workspace-data",
      summary: "Workspace metadata has no KB workspace id.",
    });
  } else {
    try {
      deletedDocuments = await deleteWorkspaceDocuments(
        principal,
        state.kbWorkspaceId,
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

  for (const doc of state.docs) {
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
