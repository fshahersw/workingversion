// ============================================================================
// Writer document persistence (server-only). Owner-scoped Library rows:
//   PK = USER#<principal>, SK = ITEM#<draftId>, type = "draft", kind = "docx"
// with the GSI1 folder key the Library folders use. DOCX bytes live in S3 as
// immutable, content-addressed revisions under drafts/<principal>/<draftId>/.
//
// Concurrency: a save carries the revision the client loaded. The row update
// is conditional on that revision, so two tabs can never both advance the
// same version. A retried save with the same idempotency key returns the
// revision the first attempt produced instead of writing another one.
//
// Legacy rows (kind "word", TipTap JSON body) are converted to a DOCX
// revision the first time they are opened through this module.
// ============================================================================
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { createHash } from "node:crypto";
import { ulid } from "ulid";

import {
  deleteItem,
  doc as dynamo,
  getItem,
  putItem,
  queryPrefix,
  tableName,
  updateItem,
} from "@/lib/data/dynamo.server";
import { bucketName, deletePrefix, s3 } from "@/lib/data/s3.server";
import { ROOT_FOLDER } from "@/lib/library/folder-tree";

import {
  cleanDocName,
  DOCX_MIME,
  DRAFT_ID,
  IDEMPOTENCY_KEY,
  MAX_DOCS_PER_USER,
  MAX_DOCX_BYTES,
  MAX_REVISION_BYTES,
  MAX_REVISIONS,
  SHA256_HEX,
  titleOf,
  type WriterChatMessage,
  type WriterDocDetail,
  type WriterDocSummary,
  type WriterRevision,
} from "./types";

const userPK = (p: string) => `USER#${p}`;
const itemSK = (id: string) => `ITEM#${id}`;
const chatSK = (id: string, seq: number) => `WCHAT#${id}#${String(seq).padStart(8, "0")}`;

type Item = Record<string, unknown>;
const s = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const n = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);

const PRINCIPAL = /^[A-Za-z0-9+=,.@_-]{1,160}$/;

export class WriterError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "WriterError";
    this.status = status;
  }
}

export const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

function assertPrincipal(principal: string): void {
  if (!PRINCIPAL.test(principal)) throw new WriterError(401, "invalid owner principal");
}

export function assertDraftId(draftId: string): string {
  if (!DRAFT_ID.test(draftId)) throw new WriterError(404, "Document not found.");
  return draftId;
}

/** Every object for a document lives under this prefix (deleted as a unit). */
export function docPrefix(principal: string, draftId: string): string {
  assertPrincipal(principal);
  assertDraftId(draftId);
  return `drafts/${principal}/${draftId}/`;
}

const revisionKey = (principal: string, draftId: string, version: number, hash: string) =>
  `${docPrefix(principal, draftId)}r${version}-${hash}.docx`;
const recoveryKey = (principal: string, draftId: string) =>
  `${docPrefix(principal, draftId)}recovery.docx`;

function parseRevisions(v: unknown): WriterRevision[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((r) => {
    const x = r as Item;
    const version = n(x.version);
    const hash = s(x.hash);
    return version > 0 && SHA256_HEX.test(hash)
      ? [{ version, hash, size: n(x.size), createdAt: s(x.createdAt) }]
      : [];
  });
}

function mapSummary(i: Item): WriterDocSummary {
  const name = cleanDocName(i.name);
  const recovery = i.recovery as Item | undefined;
  const version = n(i.version);
  return {
    draftId: s(i.itemId),
    kind: "docx",
    name,
    title: titleOf(name),
    folderId: s(i.folderId, ROOT_FOLDER) || ROOT_FOLDER,
    version,
    hash: s(i.hash),
    size: n(i.size),
    createdAt: s(i.createdAt),
    updatedAt: s(i.updatedAt),
    recovery:
      recovery && n(recovery.baseVersion) === version && s(recovery.at)
        ? { at: s(recovery.at) }
        : null,
  };
}

async function loadRow(principal: string, draftId: string): Promise<Item> {
  assertDraftId(draftId);
  const row = await getItem(userPK(principal), itemSK(draftId), { consistent: true });
  if (!row || s(row.type) !== "draft" || s(row.owner) !== principal) {
    throw new WriterError(404, "Document not found.");
  }
  return row;
}

async function putBytes(key: string, bytes: Uint8Array): Promise<void> {
  await s3().send(
    new PutObjectCommand({ Bucket: bucketName(), Key: key, Body: bytes, ContentType: DOCX_MIME }),
  );
}

async function getBytes(key: string): Promise<Uint8Array | null> {
  try {
    const r = await s3().send(new GetObjectCommand({ Bucket: bucketName(), Key: key }));
    const bytes = await r.Body?.transformToByteArray();
    return bytes ?? null;
  } catch (err) {
    if ((err as { name?: string })?.name === "NoSuchKey") return null;
    throw err;
  }
}

/** Minimal DOCX sanity check: a ZIP container that declares a Word main part. */
export function assertLooksLikeDocx(bytes: Uint8Array): void {
  if (bytes.length < 22 || bytes.length > MAX_DOCX_BYTES) {
    throw new WriterError(
      413,
      `The document must be a DOCX up to ${MAX_DOCX_BYTES / 1024 / 1024} MB.`,
    );
  }
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new WriterError(422, "The file is not a DOCX package.");
  }
  // The [Content_Types].xml part is always present and stored near the start
  // or the end of the archive; both windows are cheap to scan.
  const head = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 4096))).toString("latin1");
  const tail = Buffer.from(bytes.subarray(Math.max(0, bytes.length - 65536))).toString("latin1");
  if (!head.includes("[Content_Types].xml") && !tail.includes("[Content_Types].xml")) {
    throw new WriterError(422, "The file is not a DOCX package.");
  }
  if (!head.includes("word/") && !tail.includes("word/")) {
    throw new WriterError(422, "The file is not a Word document.");
  }
}

// --- Listing / metadata -------------------------------------------------------

export async function listWriterDocs(principal: string): Promise<WriterDocSummary[]> {
  assertPrincipal(principal);
  const rows = await queryPrefix(userPK(principal), "ITEM#");
  return rows
    .filter((r) => s(r.type) === "draft" && s(r.kind) !== "pdf")
    .map((r) => (s(r.kind) === "docx" ? mapSummary(r) : mapLegacySummary(r)))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

/** A legacy TipTap draft, shown as a document until it is opened and converted. */
function mapLegacySummary(i: Item): WriterDocSummary {
  const base = mapSummary({ ...i, name: cleanDocName(s(i.name) || "Untitled document") });
  return { ...base, version: 0, hash: "", size: 0, recovery: null };
}

export async function getWriterDoc(principal: string, draftId: string): Promise<WriterDocDetail> {
  let row = await loadRow(principal, draftId);
  if (s(row.kind) !== "docx") row = await convertLegacyRow(principal, row);
  return { ...mapSummary(row), revisions: parseRevisions(row.revisions) };
}

export async function renameWriterDoc(
  principal: string,
  draftId: string,
  name: string,
): Promise<WriterDocSummary> {
  const row = await loadRow(principal, draftId);
  const set = { name: cleanDocName(name), updatedAt: new Date().toISOString() };
  await updateItem(userPK(principal), itemSK(draftId), { set });
  return mapSummary({ ...row, ...set });
}

// --- Create -----------------------------------------------------------------

export async function createWriterDoc(
  principal: string,
  input: { name?: string; bytes: Uint8Array; folderId?: string },
): Promise<WriterDocSummary> {
  assertPrincipal(principal);
  assertLooksLikeDocx(input.bytes);
  const existing = await queryPrefix(userPK(principal), "ITEM#");
  if (existing.filter((r) => s(r.type) === "draft").length >= MAX_DOCS_PER_USER) {
    throw new WriterError(413, `This account has reached ${MAX_DOCS_PER_USER} documents.`);
  }
  const draftId = ulid();
  const now = new Date().toISOString();
  const hash = sha256(input.bytes);
  const folderId = input.folderId && input.folderId !== ROOT_FOLDER ? input.folderId : ROOT_FOLDER;
  await putBytes(revisionKey(principal, draftId, 1, hash), input.bytes);
  const row: Item = {
    PK: userPK(principal),
    SK: itemSK(draftId),
    entity: "item",
    type: "draft",
    kind: "docx",
    owner: principal,
    itemId: draftId,
    name: cleanDocName(input.name),
    folderId,
    version: 1,
    hash,
    size: input.bytes.length,
    revisions: [{ version: 1, hash, size: input.bytes.length, createdAt: now }],
    operations: {},
    recovery: null,
    saved: true,
    createdAt: now,
    updatedAt: now,
    GSI1PK: `FLD#${principal}#${folderId}`,
    GSI1SK: `ITEM#${now}#${draftId}`,
  };
  await putItem(row);
  return mapSummary(row);
}

// --- Read bytes ---------------------------------------------------------------

export async function readWriterRevision(
  principal: string,
  draftId: string,
  version?: number,
): Promise<{ bytes: Uint8Array; version: number; hash: string; name: string }> {
  const detail = await getWriterDoc(principal, draftId);
  const v = version ?? detail.version;
  const rev = detail.revisions.find((r) => r.version === v);
  if (!rev) throw new WriterError(404, "Document revision not found.");
  const bytes = await getBytes(revisionKey(principal, draftId, rev.version, rev.hash));
  if (!bytes) throw new WriterError(404, "Document revision is missing from storage.");
  if (sha256(bytes) !== rev.hash)
    throw new WriterError(500, "Stored document integrity check failed.");
  return { bytes, version: rev.version, hash: rev.hash, name: detail.name };
}

// --- Save -----------------------------------------------------------------------

export async function saveWriterRevision(
  principal: string,
  input: { draftId: string; expectedVersion: number; bytes: Uint8Array; operationId: string },
): Promise<WriterDocSummary & { replayed?: boolean }> {
  const { draftId } = input;
  if (!IDEMPOTENCY_KEY.test(input.operationId)) {
    throw new WriterError(422, "A unique operation identifier is required.");
  }
  assertLooksLikeDocx(input.bytes);
  let row = await loadRow(principal, draftId);
  if (s(row.kind) !== "docx") row = await convertLegacyRow(principal, row);

  const operations = (row.operations as Record<string, { hash: string; version: number }>) ?? {};
  const hash = sha256(input.bytes);
  const prior = operations[input.operationId];
  if (prior) {
    if (prior.hash !== hash) {
      throw new WriterError(409, "Operation identifier was reused with different content.");
    }
    return { ...mapSummary(row), version: prior.version, hash: prior.hash, replayed: true };
  }
  const current = n(row.version);
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion !== current) {
    throw new WriterError(
      409,
      "Document changed on the server. Save a separate copy or reopen before editing again.",
    );
  }
  const revisions = parseRevisions(row.revisions);
  const total = revisions.reduce((sum, r) => sum + r.size, 0) + input.bytes.length;
  if (current >= MAX_REVISIONS || total > MAX_REVISION_BYTES) {
    throw new WriterError(413, "Document revision quota reached.");
  }

  const next = current + 1;
  const now = new Date().toISOString();
  // Bytes first: a failure here leaves the row untouched and the save retryable.
  await putBytes(revisionKey(principal, draftId, next, hash), input.bytes);

  // Keep the idempotency map bounded (the last 50 operations are plenty for retries).
  const opKeys = Object.keys(operations);
  const trimmed: Record<string, { hash: string; version: number }> = {};
  for (const k of opKeys.slice(-49)) trimmed[k] = operations[k]!;
  trimmed[input.operationId] = { hash, version: next };

  const rev: WriterRevision = { version: next, hash, size: input.bytes.length, createdAt: now };
  try {
    await dynamo().send(
      new UpdateCommand({
        TableName: tableName(),
        Key: { PK: userPK(principal), SK: itemSK(draftId) },
        ConditionExpression: "version = :expected",
        UpdateExpression:
          "SET version = :next, #h = :hash, #sz = :size, updatedAt = :now, revisions = list_append(if_not_exists(revisions, :empty), :rev), operations = :ops, recovery = :none",
        ExpressionAttributeNames: { "#h": "hash", "#sz": "size" },
        ExpressionAttributeValues: {
          ":expected": current,
          ":next": next,
          ":hash": hash,
          ":size": input.bytes.length,
          ":now": now,
          ":empty": [],
          ":rev": [rev],
          ":ops": trimmed,
          ":none": null,
        },
      }),
    );
  } catch (err) {
    if ((err as { name?: string })?.name === "ConditionalCheckFailedException") {
      throw new WriterError(
        409,
        "Document changed on the server. Save a separate copy or reopen before editing again.",
      );
    }
    throw err;
  }
  return mapSummary({
    ...row,
    version: next,
    hash,
    size: input.bytes.length,
    updatedAt: now,
    recovery: null,
  });
}

// --- Recovery copy ------------------------------------------------------------------

export async function putWriterRecovery(
  principal: string,
  input: { draftId: string; baseVersion: number; bytes: Uint8Array },
): Promise<{ ok: true }> {
  assertLooksLikeDocx(input.bytes);
  const row = await loadRow(principal, input.draftId);
  if (n(row.version) !== input.baseVersion) {
    throw new WriterError(409, "The recovery snapshot is based on an older revision.");
  }
  const hash = sha256(input.bytes);
  await putBytes(recoveryKey(principal, input.draftId), input.bytes);
  await updateItem(userPK(principal), itemSK(input.draftId), {
    set: { recovery: { baseVersion: input.baseVersion, hash, at: new Date().toISOString() } },
  });
  return { ok: true };
}

export async function readWriterRecovery(
  principal: string,
  draftId: string,
): Promise<{ bytes: Uint8Array; name: string }> {
  const row = await loadRow(principal, draftId);
  const rec = row.recovery as Item | undefined;
  if (!rec || n(rec.baseVersion) !== n(row.version)) {
    throw new WriterError(404, "The recovery snapshot is unavailable.");
  }
  const bytes = await getBytes(recoveryKey(principal, draftId));
  if (!bytes || sha256(bytes) !== s(rec.hash)) {
    throw new WriterError(404, "The recovery snapshot is unavailable.");
  }
  return { bytes, name: cleanDocName(row.name) };
}

// --- Delete -------------------------------------------------------------------------

export async function deleteWriterDoc(
  principal: string,
  draftId: string,
): Promise<{ ok: true; alreadyDeleted: boolean }> {
  assertDraftId(draftId);
  const row = await getItem(userPK(principal), itemSK(draftId));
  if (!row) return { ok: true, alreadyDeleted: true };
  if (s(row.type) !== "draft" || s(row.owner) !== principal) {
    throw new WriterError(404, "Document not found.");
  }
  // Objects first, so a failure leaves a retryable row, never an orphaned body.
  await deletePrefix(docPrefix(principal, draftId));
  const chat = await queryPrefix(userPK(principal), `WCHAT#${draftId}#`);
  for (const m of chat) await deleteItem(userPK(principal), s(m.SK));
  await deleteItem(userPK(principal), itemSK(draftId));
  return { ok: true, alreadyDeleted: false };
}

// --- Assistant chat history (per document, separate from Research) -----------------

const MAX_CHAT_TEXT = 60_000;
const MAX_TOOL_FIELD = 4_000;
const MAX_CHAT_MESSAGES = 400;

function cleanTools(v: unknown): WriterChatMessage["tools"] {
  if (!Array.isArray(v)) return undefined;
  const out = v.slice(0, 64).flatMap((t) => {
    const x = t as Item;
    if (typeof x.name !== "string") return [];
    return [
      {
        name: x.name.slice(0, 80),
        summary: s(x.summary).slice(0, 400),
        ...(x.isError === true ? { isError: true } : {}),
        ...(typeof x.input === "string" ? { input: x.input.slice(0, MAX_TOOL_FIELD) } : {}),
        ...(typeof x.output === "string" ? { output: x.output.slice(0, MAX_TOOL_FIELD) } : {}),
      },
    ];
  });
  return out.length ? out : undefined;
}

function cleanAttachments(v: unknown): WriterChatMessage["attachments"] {
  if (!Array.isArray(v)) return undefined;
  const out = v.slice(0, 20).flatMap((a) => {
    const x = a as Item;
    if (typeof x.name !== "string") return [];
    return [
      {
        name: x.name.slice(0, 200),
        ...(typeof x.path === "string" ? { path: x.path.slice(0, 200) } : {}),
        ...(typeof x.ext === "string" ? { ext: x.ext.slice(0, 10) } : {}),
        ...(typeof x.sizeBytes === "number" ? { sizeBytes: x.sizeBytes } : {}),
      },
    ];
  });
  return out.length ? out : undefined;
}

export async function loadWriterChat(
  principal: string,
  draftId: string,
  limit = 200,
): Promise<WriterChatMessage[]> {
  await loadRow(principal, draftId);
  const rows = await queryPrefix(userPK(principal), `WCHAT#${draftId}#`, {
    scanForward: false,
    limit: Math.min(Math.max(1, limit), MAX_CHAT_MESSAGES),
  });
  return rows
    .map((r) => ({
      seq: n(r.seq),
      ts: s(r.ts),
      role: (s(r.role) === "assistant" ? "assistant" : "user") as "user" | "assistant",
      text: s(r.text),
      ...(r.tools ? { tools: cleanTools(r.tools) } : {}),
      ...(r.attachments ? { attachments: cleanAttachments(r.attachments) } : {}),
    }))
    .sort((a, b) => a.seq - b.seq);
}

export async function appendWriterChat(
  principal: string,
  draftId: string,
  message: Omit<WriterChatMessage, "seq" | "ts">,
): Promise<WriterChatMessage> {
  await loadRow(principal, draftId);
  const last = await queryPrefix(userPK(principal), `WCHAT#${draftId}#`, {
    scanForward: false,
    limit: 1,
  });
  const seq = n(last[0]?.seq) + 1;
  const ts = new Date().toISOString();
  const tools = cleanTools(message.tools);
  const attachments = cleanAttachments(message.attachments);
  const item: Item = {
    PK: userPK(principal),
    SK: chatSK(draftId, seq),
    entity: "writer_chat",
    owner: principal,
    itemId: draftId,
    seq,
    ts,
    role: message.role === "assistant" ? "assistant" : "user",
    text: s(message.text).slice(0, MAX_CHAT_TEXT),
    ...(tools ? { tools } : {}),
    ...(attachments ? { attachments } : {}),
  };
  await putItem(item);
  return {
    seq,
    ts,
    role: item.role as "user" | "assistant",
    text: item.text as string,
    ...(tools ? { tools } : {}),
    ...(attachments ? { attachments } : {}),
  };
}

// --- Legacy TipTap drafts -------------------------------------------------------------

/**
 * Convert a legacy Drafts row (TipTap JSON body in doc.json) into revision 1
 * of a DOCX document. Runs once per row; the JSON body is left in place.
 */
async function convertLegacyRow(principal: string, row: Item): Promise<Item> {
  const draftId = s(row.itemId);
  const { legacyDraftToDocx } = await import("./legacy-convert.server");
  const jsonKey = `${docPrefix(principal, draftId)}doc.json`;
  const raw = await getBytes(jsonKey);
  let parsed: { doc?: unknown; text?: string } | null = null;
  if (raw) {
    try {
      parsed = JSON.parse(Buffer.from(raw).toString("utf8")) as { doc?: unknown; text?: string };
    } catch {
      parsed = null;
    }
  }
  const title = s(row.name) || "Untitled document";
  const bytes = await legacyDraftToDocx(title, parsed?.doc ?? null, parsed?.text ?? "");
  const hash = sha256(bytes);
  const now = new Date().toISOString();
  await putBytes(revisionKey(principal, draftId, 1, hash), bytes);
  const set: Item = {
    kind: "docx",
    name: cleanDocName(title),
    version: 1,
    hash,
    size: bytes.length,
    revisions: [{ version: 1, hash, size: bytes.length, createdAt: now }],
    operations: {},
    recovery: null,
    updatedAt: now,
    legacyConvertedAt: now,
  };
  await updateItem(userPK(principal), itemSK(draftId), { set });
  return { ...row, ...set };
}
