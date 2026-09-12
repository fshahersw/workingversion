// Library / memory items on DynamoDB (saved outputs, prompts, uploads, reviews,
// workspaces). Owner-scoped: keys embed the Cognito principal. Chat
// conversations are handled by chat.server; the library page composes both.
import { ulid } from "ulid";

import { putItem, getItem, queryPrefix, deleteItem } from "@/lib/data/dynamo.server";
import { presignPut, presignGet, deleteObject } from "@/lib/data/s3.server";

const userPK = (p: string) => `USER#${p}`;
const itemSK = (id: string) => `ITEM#${id}`;

/** Cap for original-file preservation (200 MiB). Files go browser -> S3 directly. */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

export type ItemKind = "output" | "prompt" | "file" | "review" | "workspace";
export type LibraryItem = {
  itemId: string;
  kind: ItemKind;
  name: string;
  folderId: string;
  createdAt: string;
  sourceConvId?: string;
  s3Key?: string;
  contentType?: string;
  size?: number;
  preview?: string;
};

/** Persist an arbitrary output/prompt as a library item (memory). */
export async function saveOutputText(
  principal: string,
  args: { name: string; content: string; kind?: ItemKind; folderId?: string },
): Promise<{ itemId: string }> {
  const itemId = ulid();
  const now = new Date().toISOString();
  const folderId = args.folderId ?? "ROOT";
  const kind = args.kind ?? "output";
  await putItem({
    PK: userPK(principal),
    SK: itemSK(itemId),
    entity: "item",
    type: kind,
    owner: principal,
    itemId,
    name: (args.name || "Untitled").slice(0, 120),
    content: args.content,
    folderId,
    saved: true,
    createdAt: now,
    GSI1PK: `FLD#${principal}#${folderId}`,
    GSI1SK: `ITEM#${now}#${itemId}`,
  });
  return { itemId };
}

function toLibraryItem(r: Record<string, unknown>): LibraryItem {
  const content = (r.content as string | undefined) ?? "";
  return {
    itemId: r.itemId as string,
    kind: (r.type as ItemKind) ?? "output",
    name: (r.name as string) ?? "Untitled",
    folderId: (r.folderId as string) ?? "ROOT",
    createdAt: (r.createdAt as string) ?? "",
    sourceConvId: r.sourceConvId as string | undefined,
    s3Key: r.s3Key as string | undefined,
    contentType: r.contentType as string | undefined,
    size: typeof r.size === "number" ? (r.size as number) : undefined,
    preview: content ? content.slice(0, 200) : undefined,
  };
}

function safeName(name: string): string {
  return (name || "file").replace(/[^\w.-]+/g, "_").slice(0, 120) || "file";
}

/**
 * Step 1 of an upload: reserve an item id + S3 key and return a presigned PUT
 * URL. The browser PUTs the file bytes straight to S3; nothing is written to
 * DynamoDB until registerUpload confirms success.
 */
export async function createUpload(
  principal: string,
  args: { name: string; size: number; sha256?: string },
): Promise<{
  itemId: string;
  s3Key: string;
  uploadUrl: string;
  uploadHeaders?: Record<string, string>;
}> {
  if (!Number.isSafeInteger(args.size) || args.size < 1 || args.size > MAX_UPLOAD_BYTES) {
    throw new Error(`File too large (max ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB)`);
  }
  if (args.sha256 !== undefined && !/^[0-9a-f]{64}$/i.test(args.sha256)) {
    throw new Error("Invalid upload SHA-256");
  }
  const itemId = ulid();
  const s3Key = `uploads/${principal}/${itemId}/${safeName(args.name)}`;
  const checksumSha256 = args.sha256
    ? Buffer.from(args.sha256, "hex").toString("base64")
    : undefined;
  const uploadUrl = await presignPut(s3Key, checksumSha256);
  return {
    itemId,
    s3Key,
    uploadUrl,
    ...(checksumSha256 ? { uploadHeaders: { "x-amz-checksum-sha256": checksumSha256 } } : {}),
  };
}

/** Step 2: record the uploaded file as a `file` library item. */
export async function registerUpload(
  principal: string,
  args: { itemId: string; s3Key: string; name: string; contentType?: string; size?: number },
): Promise<{ itemId: string }> {
  const prefix = `uploads/${principal}/${args.itemId}/`;
  if (!args.s3Key.startsWith(prefix)) throw new Error("Invalid upload key");
  const now = new Date().toISOString();
  const folderId = "ROOT";
  await putItem({
    PK: userPK(principal),
    SK: itemSK(args.itemId),
    entity: "item",
    type: "file",
    owner: principal,
    itemId: args.itemId,
    name: (args.name || "file").slice(0, 120),
    s3Key: args.s3Key,
    contentType: args.contentType,
    size: args.size,
    folderId,
    saved: true,
    createdAt: now,
    GSI1PK: `FLD#${principal}#${folderId}`,
    GSI1SK: `ITEM#${now}#${args.itemId}`,
  });
  return { itemId: args.itemId };
}

/** Presigned download URL for an uploaded file item. */
export async function getDownloadUrl(principal: string, itemId: string): Promise<{ url: string }> {
  const r = await getItem(userPK(principal), itemSK(itemId));
  if (!r || !r.s3Key) throw new Error("File not found");
  const url = await presignGet(
    r.s3Key as string,
    r.name as string | undefined,
    r.contentType as string | undefined,
  );
  return { url };
}

/** List the user's library items, most recent first, optionally filtered by kind. */
export async function listItems(principal: string, kind?: ItemKind): Promise<LibraryItem[]> {
  const rows = await queryPrefix(userPK(principal), "ITEM#", { scanForward: false });
  const items = rows.map(toLibraryItem);
  return kind ? items.filter((i) => i.kind === kind) : items;
}

/** Full item including content (for viewing a saved output). */
export async function getLibraryItem(principal: string, itemId: string) {
  const r = await getItem(userPK(principal), itemSK(itemId));
  if (!r) return null;
  return {
    ...toLibraryItem(r),
    content: (r.content as string | undefined) ?? "",
  };
}

export async function deleteLibraryItem(principal: string, itemId: string): Promise<{ ok: true }> {
  const r = await getItem(userPK(principal), itemSK(itemId));
  const key = r?.s3Key as string | undefined;
  if (key) {
    try {
      await deleteObject(key);
    } catch {
      // Best-effort: drop the metadata even if the blob delete fails.
    }
  }
  await deleteItem(userPK(principal), itemSK(itemId));
  return { ok: true };
}
