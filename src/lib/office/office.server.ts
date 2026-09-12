// ============================================================================
// Office document persistence (server-only), shared by every editor kind.
// Owner-scoped Library rows:
//   PK = USER#<principal>, SK = ITEM#<docId>, type = "draft", kind = docx|xlsx
// with the GSI1 folder key the Library folders use. Bytes live in S3 as
// immutable, content-addressed revisions under drafts/<principal>/<docId>/.
//
// Concurrency: a save carries the revision the client loaded. The row update
// is conditional on that revision, so two tabs can never both advance the
// same version. A retried save with the same idempotency key returns the
// revision the first attempt produced instead of writing another one.
//
// Legacy rows (kind "word", TipTap JSON body) are converted to a DOCX
// revision the first time they are opened.
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
import { bucketName, deletePrefix, presignGet, s3 } from "@/lib/data/s3.server";
import { ROOT_FOLDER } from "@/lib/library/folder-tree";

import {
  cleanOfficeName,
  DOC_ID,
  IDEMPOTENCY_KEY,
  isOfficeKind,
  MAX_DOCS_PER_USER,
  MAX_REVISION_BYTES,
  MAX_REVISIONS,
  OFFICE_MIME,
  SHA256_HEX,
  titleOf,
  type OfficeChatMessage,
  type OfficeDocDetail,
  type OfficeDocSummary,
  type OfficeKind,
  type OfficeRevision,
} from "./types";
import { ArchiveError, validateOfficeArchive } from "./validate-archive.server";

const userPK = (p: string) => `USER#${p}`;
const itemSK = (id: string) => `ITEM#${id}`;
const chatSK = (id: string, seq: number) => `WCHAT#${id}#${String(seq).padStart(8, "0")}`;

type Item = Record<string, unknown>;
const s = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const n = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);

const PRINCIPAL = /^[A-Za-z0-9+=,.@_-]{1,160}$/;

export class OfficeError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "OfficeError";
    this.status = status;
  }
}

export const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

function assertPrincipal(principal: string): void {
  if (!PRINCIPAL.test(principal)) throw new OfficeError(401, "invalid owner principal");
}

export function assertDocId(docId: string): string {
  if (!DOC_ID.test(docId)) throw new OfficeError(404, "Document not found.");
  return docId;
}

/** Every object for a document lives under this prefix (deleted as a unit). */
export function docPrefix(principal: string, docId: string): string {
  assertPrincipal(principal);
  assertDocId(docId);
  return `drafts/${principal}/${docId}/`;
}

const revisionKey = (
  principal: string,
  docId: string,
  kind: OfficeKind,
  version: number,
  hash: string,
) => `${docPrefix(principal, docId)}r${version}-${hash}.${kind}`;
const recoveryKey = (principal: string, docId: string, kind: OfficeKind) =>
  `${docPrefix(principal, docId)}recovery.${kind}`;

/** Row kind -> Office kind. Legacy "word" rows are docx once converted. */
function kindOf(row: Item): OfficeKind {
  const k = s(row.kind);
  return isOfficeKind(k) ? k : "docx";
}

function parseRevisions(v: unknown): OfficeRevision[] {
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

function mapSummary(i: Item): OfficeDocSummary {
  const kind = kindOf(i);
  const name = cleanOfficeName(kind, i.name);
  const recovery = i.recovery as Item | undefined;
  const version = n(i.version);
  return {
    draftId: s(i.itemId),
    kind,
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

/** A legacy TipTap draft, shown as a document until it is opened and converted. */
function mapLegacySummary(i: Item): OfficeDocSummary {
  const base = mapSummary({
    ...i,
    kind: "docx",
    name: cleanOfficeName("docx", s(i.name) || "Untitled document"),
  });
  return { ...base, version: 0, hash: "", size: 0, recovery: null };
}

const isLegacy = (row: Item) => s(row.kind) === "word";

async function loadRow(principal: string, docId: string): Promise<Item> {
  assertDocId(docId);
  const row = await getItem(userPK(principal), itemSK(docId), { consistent: true });
  if (!row || s(row.type) !== "draft" || s(row.owner) !== principal) {
    throw new OfficeError(404, "Document not found.");
  }
  return row;
}

async function putBytes(key: string, bytes: Uint8Array, kind: OfficeKind): Promise<void> {
  await s3().send(
    new PutObjectCommand({
      Bucket: bucketName(),
      Key: key,
      Body: bytes,
      ContentType: OFFICE_MIME[kind],
    }),
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

/** Full package validation; converts ArchiveError to the OfficeError the routes map. */
export function assertValidPackage(kind: OfficeKind, bytes: Uint8Array): void {
  try {
    validateOfficeArchive(bytes, kind);
  } catch (err) {
    if (err instanceof ArchiveError) throw new OfficeError(err.status, err.message);
    throw err;
  }
}

// --- Listing / metadata -------------------------------------------------------

export async function listOfficeDocs(
  principal: string,
  kind?: OfficeKind,
): Promise<OfficeDocSummary[]> {
  assertPrincipal(principal);
  const rows = await queryPrefix(userPK(principal), "ITEM#");
  return rows
    .filter((r) => s(r.type) === "draft" && (isOfficeKind(s(r.kind)) || isLegacy(r)))
    .map((r) => (isLegacy(r) ? mapLegacySummary(r) : mapSummary(r)))
    .filter((d) => !kind || d.kind === kind)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function getOfficeDoc(principal: string, docId: string): Promise<OfficeDocDetail> {
  let row = await loadRow(principal, docId);
  if (isLegacy(row)) row = await convertLegacyRow(principal, row);
  if (!isOfficeKind(s(row.kind))) throw new OfficeError(404, "Document not found.");
  return { ...mapSummary(row), revisions: parseRevisions(row.revisions) };
}

export async function renameOfficeDoc(
  principal: string,
  docId: string,
  name: string,
): Promise<OfficeDocSummary> {
  const row = await loadRow(principal, docId);
  const set = { name: cleanOfficeName(kindOf(row), name), updatedAt: new Date().toISOString() };
  await updateItem(userPK(principal), itemSK(docId), { set });
  return mapSummary({ ...row, ...set });
}

// --- Create -----------------------------------------------------------------

export async function createOfficeDoc(
  principal: string,
  input: { kind: OfficeKind; name?: string; bytes: Uint8Array; folderId?: string },
): Promise<OfficeDocSummary> {
  assertPrincipal(principal);
  assertValidPackage(input.kind, input.bytes);
  const existing = await queryPrefix(userPK(principal), "ITEM#");
  if (existing.filter((r) => s(r.type) === "draft").length >= MAX_DOCS_PER_USER) {
    throw new OfficeError(413, `This account has reached ${MAX_DOCS_PER_USER} documents.`);
  }
  const docId = ulid();
  const now = new Date().toISOString();
  const hash = sha256(input.bytes);
  const folderId = input.folderId && input.folderId !== ROOT_FOLDER ? input.folderId : ROOT_FOLDER;
  await putBytes(revisionKey(principal, docId, input.kind, 1, hash), input.bytes, input.kind);
  const row: Item = {
    PK: userPK(principal),
    SK: itemSK(docId),
    entity: "item",
    type: "draft",
    kind: input.kind,
    owner: principal,
    itemId: docId,
    name: cleanOfficeName(input.kind, input.name),
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
    GSI1SK: `ITEM#${now}#${docId}`,
  };
  await putItem(row);
  return mapSummary(row);
}

// --- Read bytes ---------------------------------------------------------------

export async function readOfficeRevision(
  principal: string,
  docId: string,
  version?: number,
): Promise<{ bytes: Uint8Array; version: number; hash: string; name: string; kind: OfficeKind }> {
  const detail = await getOfficeDoc(principal, docId);
  const v = version ?? detail.version;
  const rev = detail.revisions.find((r) => r.version === v);
  if (!rev) throw new OfficeError(404, "Document revision not found.");
  const bytes = await getBytes(revisionKey(principal, docId, detail.kind, rev.version, rev.hash));
  if (!bytes) throw new OfficeError(404, "Document revision is missing from storage.");
  if (sha256(bytes) !== rev.hash)
    throw new OfficeError(500, "Stored document integrity check failed.");
  return { bytes, version: rev.version, hash: rev.hash, name: detail.name, kind: detail.kind };
}

/**
 * Short-lived presigned GET for one revision, handed to the Office engine
 * service so it can load a workbook without any credentials to the bucket.
 */
export async function grantOfficeRevision(
  principal: string,
  docId: string,
  version?: number,
): Promise<{ url: string; version: number; hash: string; name: string; kind: OfficeKind }> {
  const detail = await getOfficeDoc(principal, docId);
  const v = version ?? detail.version;
  const rev = detail.revisions.find((r) => r.version === v);
  if (!rev) throw new OfficeError(404, "Document revision not found.");
  const url = await presignGet(
    revisionKey(principal, docId, detail.kind, rev.version, rev.hash),
    detail.name,
    OFFICE_MIME[detail.kind],
  );
  return { url, version: rev.version, hash: rev.hash, name: detail.name, kind: detail.kind };
}

// --- Save -----------------------------------------------------------------------

export async function saveOfficeRevision(
  principal: string,
  input: { docId: string; expectedVersion: number; bytes: Uint8Array; operationId: string },
): Promise<OfficeDocSummary & { replayed?: boolean }> {
  const { docId } = input;
  if (!IDEMPOTENCY_KEY.test(input.operationId)) {
    throw new OfficeError(422, "A unique operation identifier is required.");
  }
  let row = await loadRow(principal, docId);
  if (isLegacy(row)) row = await convertLegacyRow(principal, row);
  const kind = kindOf(row);
  assertValidPackage(kind, input.bytes);

  const operations = (row.operations as Record<string, { hash: string; version: number }>) ?? {};
  const hash = sha256(input.bytes);
  const prior = operations[input.operationId];
  if (prior) {
    if (prior.hash !== hash)
      throw new OfficeError(409, "Operation identifier was reused with different content.");
    return { ...mapSummary(row), version: prior.version, hash: prior.hash, replayed: true };
  }
  const current = n(row.version);
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion !== current) {
    throw new OfficeError(
      409,
      "Document changed on the server. Save a separate copy or reopen before editing again.",
    );
  }
  const revisions = parseRevisions(row.revisions);
  const total = revisions.reduce((sum, r) => sum + r.size, 0) + input.bytes.length;
  if (current >= MAX_REVISIONS || total > MAX_REVISION_BYTES) {
    throw new OfficeError(413, "Document revision quota reached.");
  }

  const next = current + 1;
  const now = new Date().toISOString();
  // Bytes first: a failure here leaves the row untouched and the save retryable.
  await putBytes(revisionKey(principal, docId, kind, next, hash), input.bytes, kind);

  // Keep the idempotency map bounded (the last 50 operations cover retries).
  const trimmed: Record<string, { hash: string; version: number }> = {};
  for (const k of Object.keys(operations).slice(-49)) trimmed[k] = operations[k]!;
  trimmed[input.operationId] = { hash, version: next };

  const rev: OfficeRevision = { version: next, hash, size: input.bytes.length, createdAt: now };
  try {
    await dynamo().send(
      new UpdateCommand({
        TableName: tableName(),
        Key: { PK: userPK(principal), SK: itemSK(docId) },
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
      throw new OfficeError(
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

export async function putOfficeRecovery(
  principal: string,
  input: { docId: string; baseVersion: number; bytes: Uint8Array },
): Promise<{ ok: true }> {
  const row = await loadRow(principal, input.docId);
  const kind = kindOf(row);
  assertValidPackage(kind, input.bytes);
  if (n(row.version) !== input.baseVersion) {
    throw new OfficeError(409, "The recovery snapshot is based on an older revision.");
  }
  const hash = sha256(input.bytes);
  await putBytes(recoveryKey(principal, input.docId, kind), input.bytes, kind);
  await updateItem(userPK(principal), itemSK(input.docId), {
    set: { recovery: { baseVersion: input.baseVersion, hash, at: new Date().toISOString() } },
  });
  return { ok: true };
}

export async function readOfficeRecovery(
  principal: string,
  docId: string,
): Promise<{ bytes: Uint8Array; name: string; kind: OfficeKind }> {
  const row = await loadRow(principal, docId);
  const kind = kindOf(row);
  const rec = row.recovery as Item | undefined;
  if (!rec || n(rec.baseVersion) !== n(row.version)) {
    throw new OfficeError(404, "The recovery snapshot is unavailable.");
  }
  const bytes = await getBytes(recoveryKey(principal, docId, kind));
  if (!bytes || sha256(bytes) !== s(rec.hash))
    throw new OfficeError(404, "The recovery snapshot is unavailable.");
  return { bytes, name: cleanOfficeName(kind, row.name), kind };
}

// --- Delete -------------------------------------------------------------------------

export async function deleteOfficeDoc(
  principal: string,
  docId: string,
): Promise<{ ok: true; alreadyDeleted: boolean }> {
  assertDocId(docId);
  const row = await getItem(userPK(principal), itemSK(docId));
  if (!row) return { ok: true, alreadyDeleted: true };
  if (s(row.type) !== "draft" || s(row.owner) !== principal)
    throw new OfficeError(404, "Document not found.");
  // Objects first, so a failure leaves a retryable row, never an orphaned body.
  await deletePrefix(docPrefix(principal, docId));
  const chat = await queryPrefix(userPK(principal), `WCHAT#${docId}#`);
  for (const m of chat) await deleteItem(userPK(principal), s(m.SK));
  await deleteItem(userPK(principal), itemSK(docId));
  return { ok: true, alreadyDeleted: false };
}

// --- Assistant chat history (per document, separate from Research) -----------------

const MAX_CHAT_TEXT = 120_000;
const MAX_TOOL_FIELD = 16_000;
const MAX_CHAT_MESSAGES = 400;

function cleanTools(v: unknown): OfficeChatMessage["tools"] {
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

function cleanAttachments(v: unknown): OfficeChatMessage["attachments"] {
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

export async function loadOfficeChat(
  principal: string,
  docId: string,
  limit = 200,
): Promise<OfficeChatMessage[]> {
  await loadRow(principal, docId);
  const rows = await queryPrefix(userPK(principal), `WCHAT#${docId}#`, {
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

export async function appendOfficeChat(
  principal: string,
  docId: string,
  message: Omit<OfficeChatMessage, "seq" | "ts">,
): Promise<OfficeChatMessage> {
  await loadRow(principal, docId);
  const last = await queryPrefix(userPK(principal), `WCHAT#${docId}#`, {
    scanForward: false,
    limit: 1,
  });
  const seq = n(last[0]?.seq) + 1;
  const ts = new Date().toISOString();
  const tools = cleanTools(message.tools);
  const attachments = cleanAttachments(message.attachments);
  const item: Item = {
    PK: userPK(principal),
    SK: chatSK(docId, seq),
    entity: "writer_chat",
    owner: principal,
    itemId: docId,
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
  const docId = s(row.itemId);
  const { legacyDraftToDocx } = await import("@/lib/writer/legacy-convert.server");
  const jsonKey = `${docPrefix(principal, docId)}doc.json`;
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
  await putBytes(revisionKey(principal, docId, "docx", 1, hash), bytes, "docx");
  const set: Item = {
    kind: "docx",
    name: cleanOfficeName("docx", title),
    version: 1,
    hash,
    size: bytes.length,
    revisions: [{ version: 1, hash, size: bytes.length, createdAt: now }],
    operations: {},
    recovery: null,
    updatedAt: now,
    legacyConvertedAt: now,
  };
  await updateItem(userPK(principal), itemSK(docId), { set });
  return { ...row, ...set };
}
