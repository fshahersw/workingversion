// ============================================================================
// Drafts persistence (server-only). Owner-scoped like every Library row:
//   PK = USER#<principal>, SK = ITEM#<draftId>, type = "draft"
// with the GSI1 folder key the Library folders use. The body lives in S3 under
// drafts/<principal>/<draftId>/ so it can grow past DynamoDB's item limit and
// is deleted as a prefix with the row. Saves are versioned: a client sends the
// version it loaded and a stale tab is refused rather than clobbering a newer
// save from another tab.
// ============================================================================
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { ulid } from "ulid";

import { deleteItem, getItem, putItem, queryPrefix, updateItem } from "@/lib/data/dynamo.server";
import { bucketName, deletePrefix, s3 } from "@/lib/data/s3.server";
import { ROOT_FOLDER } from "@/lib/library/folder-tree";
import {
  cleanDraftTitle,
  countWords,
  isDraftKind,
  isDraftStyle,
  MAX_DRAFT_CONTENT_BYTES,
  type DraftContent,
  type DraftDetail,
  type DraftKind,
  type DraftStyle,
  type DraftSummary,
  type JsonValue,
} from "./types";

const userPK = (p: string) => `USER#${p}`;
const itemSK = (id: string) => `ITEM#${id}`;

type Item = Record<string, unknown>;
const s = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const n = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);

const PRINCIPAL = /^[A-Za-z0-9+=,.@_-]{1,160}$/;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function assertPrincipal(principal: string): void {
  if (!PRINCIPAL.test(principal)) throw new Error("invalid owner principal");
}

function assertDraftId(draftId: string): void {
  if (!ULID.test(draftId)) throw new Error("invalid draft id");
}

/** Every object for a draft lives under this prefix (deleted as a unit). */
export function draftPrefix(principal: string, draftId: string): string {
  assertPrincipal(principal);
  assertDraftId(draftId);
  return `drafts/${principal}/${draftId}/`;
}

export function draftContentKey(principal: string, draftId: string): string {
  return `${draftPrefix(principal, draftId)}doc.json`;
}

/** Key for an imported original; extension kept so downloads keep their type. */
export function draftSourceKey(principal: string, draftId: string, ext: "docx" | "pdf"): string {
  return `${draftPrefix(principal, draftId)}source.${ext}`;
}

function mapDraft(i: Item): DraftSummary {
  return {
    draftId: s(i.itemId),
    kind: isDraftKind(i.kind) ? i.kind : "word",
    title: cleanDraftTitle(i.name),
    style: isDraftStyle(i.style) ? i.style : "legal",
    folderId: s(i.folderId, ROOT_FOLDER) || ROOT_FOLDER,
    version: n(i.version, 0),
    wordCount: n(i.wordCount, 0),
    createdAt: s(i.createdAt),
    updatedAt: s(i.updatedAt),
    ...(s(i.convId) ? { convId: s(i.convId) } : {}),
    ...(s(i.sourceName) ? { sourceName: s(i.sourceName) } : {}),
    ...(s(i.sourceKey) ? { sourceKey: s(i.sourceKey) } : {}),
  };
}

async function loadRow(principal: string, draftId: string): Promise<Item> {
  assertDraftId(draftId);
  const row = await getItem(userPK(principal), itemSK(draftId));
  if (!row || s(row.type) !== "draft" || s(row.owner) !== principal) {
    throw new Error("Draft not found");
  }
  return row;
}

export async function listDrafts(principal: string, kind?: DraftKind): Promise<DraftSummary[]> {
  const rows = await queryPrefix(userPK(principal), "ITEM#");
  return rows
    .filter((r) => s(r.type) === "draft" && (!kind || s(r.kind) === kind))
    .map(mapDraft)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function createDraft(
  principal: string,
  input: { kind: DraftKind; title?: string; style?: DraftStyle; folderId?: string },
): Promise<DraftSummary> {
  assertPrincipal(principal);
  const draftId = ulid();
  const now = new Date().toISOString();
  const folderId = input.folderId && input.folderId !== ROOT_FOLDER ? input.folderId : ROOT_FOLDER;
  const row: Item = {
    PK: userPK(principal),
    SK: itemSK(draftId),
    entity: "item",
    type: "draft",
    owner: principal,
    itemId: draftId,
    kind: input.kind,
    name: cleanDraftTitle(input.title),
    style: isDraftStyle(input.style) ? input.style : "legal",
    folderId,
    version: 0,
    wordCount: 0,
    saved: true,
    createdAt: now,
    updatedAt: now,
    GSI1PK: `FLD#${principal}#${folderId}`,
    GSI1SK: `ITEM#${now}#${draftId}`,
  };
  await putItem(row);
  return mapDraft(row);
}

async function readContent(principal: string, draftId: string): Promise<DraftContent | null> {
  try {
    const r = await s3().send(
      new GetObjectCommand({ Bucket: bucketName(), Key: draftContentKey(principal, draftId) }),
    );
    const text = await r.Body?.transformToString("utf8");
    if (!text) return null;
    const parsed = JSON.parse(text) as Partial<DraftContent>;
    if (parsed.format !== "tiptap" || parsed.doc === undefined) return null;
    return { format: "tiptap", doc: parsed.doc as JsonValue, text: s(parsed.text) };
  } catch (err) {
    if ((err as { name?: string })?.name === "NoSuchKey") return null;
    throw err;
  }
}

export async function getDraft(principal: string, draftId: string): Promise<DraftDetail> {
  const row = await loadRow(principal, draftId);
  const summary = mapDraft(row);
  const content = summary.version > 0 ? await readContent(principal, draftId) : null;
  return { ...summary, content };
}

/**
 * Save the body. `expectedVersion` is the version the client loaded; when the
 * row has moved past it (another tab saved), the save is refused and the
 * caller reloads. Returns the new version.
 */
export async function saveDraftContent(
  principal: string,
  input: {
    draftId: string;
    expectedVersion: number;
    content: DraftContent;
    title?: string;
    /** Overwrite whatever another tab saved (the user chose to keep this copy). */
    force?: boolean;
  },
): Promise<{ version: number; wordCount: number; updatedAt: string }> {
  const row = await loadRow(principal, input.draftId);
  const current = n(row.version, 0);
  if (!input.force && input.expectedVersion !== current) {
    const err = new Error("This document was saved elsewhere; reload to continue.");
    err.name = "DraftVersionConflict";
    throw err;
  }
  if (input.content.format !== "tiptap" || input.content.doc === undefined) {
    throw new Error("invalid draft content");
  }
  const text = s(input.content.text).slice(0, 2_000_000);
  const body = JSON.stringify({ format: "tiptap", doc: input.content.doc, text });
  if (Buffer.byteLength(body, "utf8") > MAX_DRAFT_CONTENT_BYTES) {
    throw new Error("Document is too large to save");
  }
  await s3().send(
    new PutObjectCommand({
      Bucket: bucketName(),
      Key: draftContentKey(principal, input.draftId),
      Body: body,
      ContentType: "application/json",
    }),
  );
  const now = new Date().toISOString();
  const version = current + 1;
  const wordCount = countWords(text);
  const set: Record<string, unknown> = { version, wordCount, updatedAt: now };
  if (input.title !== undefined) set.name = cleanDraftTitle(input.title);
  await updateItem(userPK(principal), itemSK(input.draftId), { set });
  return { version, wordCount, updatedAt: now };
}

export async function updateDraftMeta(
  principal: string,
  input: { draftId: string; title?: string; style?: DraftStyle; convId?: string },
): Promise<DraftSummary> {
  const row = await loadRow(principal, input.draftId);
  const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  const remove: string[] = [];
  if (input.title !== undefined) set.name = cleanDraftTitle(input.title);
  if (input.style !== undefined) {
    if (!isDraftStyle(input.style)) throw new Error("invalid style");
    set.style = input.style;
  }
  if (input.convId !== undefined) {
    // Empty string unlinks the conversation (a fresh thread for the draft).
    if (input.convId === "") remove.push("convId");
    else if (!ULID.test(input.convId)) throw new Error("invalid conversation id");
    else set.convId = input.convId;
  }
  await updateItem(userPK(principal), itemSK(input.draftId), {
    set,
    ...(remove.length ? { remove } : {}),
  });
  const next = { ...row, ...set } as Item;
  for (const key of remove) delete next[key];
  return mapDraft(next);
}

/** Record an imported original for the draft (bytes already written by the caller). */
export async function setDraftSource(
  principal: string,
  input: { draftId: string; sourceName: string; sourceKey: string },
): Promise<void> {
  await loadRow(principal, input.draftId);
  if (!input.sourceKey.startsWith(draftPrefix(principal, input.draftId))) {
    throw new Error("source key is not owned by this draft");
  }
  await updateItem(userPK(principal), itemSK(input.draftId), {
    set: {
      sourceName: input.sourceName.replace(/[\r\n\\]/g, "_").slice(0, 200),
      sourceKey: input.sourceKey,
      updatedAt: new Date().toISOString(),
    },
  });
}

/** Store an imported original's bytes under the draft prefix. */
export async function putDraftSource(
  principal: string,
  draftId: string,
  ext: "docx" | "pdf",
  bytes: Uint8Array,
  contentType: string,
): Promise<string> {
  const key = draftSourceKey(principal, draftId, ext);
  await s3().send(
    new PutObjectCommand({ Bucket: bucketName(), Key: key, Body: bytes, ContentType: contentType }),
  );
  return key;
}

export async function deleteDraft(
  principal: string,
  draftId: string,
): Promise<{ ok: true; alreadyDeleted: boolean }> {
  assertDraftId(draftId);
  const row = await getItem(userPK(principal), itemSK(draftId));
  if (!row) return { ok: true, alreadyDeleted: true };
  if (s(row.type) !== "draft" || s(row.owner) !== principal) throw new Error("Draft not found");
  // Objects first, so a failure here leaves a row that can be retried, never
  // an orphaned body with no row pointing at it.
  await deletePrefix(draftPrefix(principal, draftId));
  await deleteItem(userPK(principal), itemSK(draftId));
  return { ok: true, alreadyDeleted: false };
}
