// Saved KB workspaces (server-only). A workspace is a named, reloadable unit:
//  - chunks + embeddings live in Aurora kb.chunks (queryable; written by ingest)
//  - extracted pages live in S3 (kb/pages/...) for one-click pile rehydrate
//  - original bytes live in S3 (optional; uploaded via the presigned flow)
//  - the record is a DynamoDB library item (type=workspace) with folders (GSI1),
//    reusing the existing library layer.
import { ulid } from "ulid";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

import { putItem, getItem, queryPrefix, deleteItem } from "@/lib/data/dynamo.server";
import { BUCKET, s3, presignGet, deleteObject } from "@/lib/data/s3.server";

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

/** Store one doc's extracted pages as JSON in S3 for pile rehydrate. */
export async function putWorkspacePages(
  principal: string,
  docId: string,
  pages: PageText[],
): Promise<string> {
  const key = `kb/pages/${principal}/${docId}.json`;
  await s3().send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: JSON.stringify(pages),
      ContentType: "application/json",
    }),
  );
  return key;
}

/** Create the workspace record (a library item) pointing at the persisted docs. */
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
  const itemId = ulid();
  const now = new Date().toISOString();
  const folderId = args.folderId ?? "ROOT";
  const pageCount = args.docs.reduce((n, d) => n + (d.pageCount || 0), 0);
  await putItem({
    PK: userPK(principal),
    SK: itemSK(itemId),
    entity: "item",
    type: "workspace",
    owner: principal,
    itemId,
    name: (args.name || "Untitled workspace").slice(0, 120),
    surface: args.surface,
    kbWorkspaceId: args.kbWorkspaceId,
    folderId,
    workspace: JSON.stringify({ surface: args.surface, kbWorkspaceId: args.kbWorkspaceId, docs: args.docs }),
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

/** Full workspace including its doc manifest (for reload / download). */
export async function getWorkspace(
  principal: string,
  itemId: string,
): Promise<WorkspaceDetail | null> {
  const r = await getItem(userPK(principal), itemSK(itemId));
  if (!r || r.type !== "workspace") return null;
  let docs: WorkspaceDoc[] = [];
  try {
    docs = (JSON.parse((r.workspace as string) || "{}") as { docs?: WorkspaceDoc[] }).docs ?? [];
  } catch {
    docs = [];
  }
  return { ...toSummary(r), kbWorkspaceId: (r.kbWorkspaceId as string) ?? "", docs };
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
  if (!doc.pagesKey.startsWith(`kb/pages/${principal}/`)) throw new Error("invalid pages key");
  const r = await s3().send(new GetObjectCommand({ Bucket: BUCKET, Key: doc.pagesKey }));
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
  const url = await presignGet(doc.bytesKey, doc.fileName, doc.mime);
  return { url };
}

/** Delete a workspace: its S3 pages + bytes, then the record. Best-effort blobs. */
export async function deleteWorkspace(principal: string, itemId: string): Promise<{ ok: true }> {
  const ws = await getWorkspace(principal, itemId);
  if (ws) {
    for (const d of ws.docs) {
      for (const key of [d.pagesKey, d.bytesKey]) {
        if (key) await deleteObject(key).catch(() => undefined);
      }
    }
  }
  await deleteItem(userPK(principal), itemSK(itemId));
  return { ok: true };
}
