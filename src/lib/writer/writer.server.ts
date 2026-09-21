import type { OfficeChatAppendInput } from "@/lib/office/chat-persistence";
// ============================================================================
// Writer document persistence (server-only): the DOCX view of the shared
// Office document layer in @/lib/office/office.server. Kept as a stable
// surface for the Writer's server functions and /api/writer routes.
// ============================================================================
import {
  appendOfficeChat,
  assertDocId,
  createOfficeDoc,
  deleteOfficeDoc,
  docPrefix,
  getOfficeDoc,
  listOfficeDocs,
  loadOfficeChat,
  OfficeError,
  putOfficeRecovery,
  readOfficeRecovery,
  readOfficeRevision,
  renameOfficeDoc,
  saveOfficeRevision,
  sha256,
} from "@/lib/office/office.server";
import type { OfficeDocSummary } from "@/lib/office/types";

import type { WriterChatMessage, WriterDocDetail, WriterDocSummary } from "./types";

export { OfficeError as WriterError, sha256, assertDocId as assertDraftId, docPrefix };

function asWriter(d: OfficeDocSummary): WriterDocSummary {
  if (d.kind !== "docx") throw new OfficeError(404, "Document not found.");
  return { ...d, kind: "docx" };
}

export async function listWriterDocs(principal: string): Promise<WriterDocSummary[]> {
  return (await listOfficeDocs(principal, "docx")).map(asWriter);
}

export async function getWriterDoc(principal: string, draftId: string): Promise<WriterDocDetail> {
  const d = await getOfficeDoc(principal, draftId);
  return { ...asWriter(d), revisions: d.revisions };
}

export async function renameWriterDoc(
  principal: string,
  draftId: string,
  name: string,
): Promise<WriterDocSummary> {
  return asWriter(await renameOfficeDoc(principal, draftId, name));
}

export async function createWriterDoc(
  principal: string,
  input: { name?: string; bytes: Uint8Array; folderId?: string },
): Promise<WriterDocSummary> {
  return asWriter(await createOfficeDoc(principal, { kind: "docx", ...input }));
}

export async function readWriterRevision(
  principal: string,
  draftId: string,
  version?: number,
): Promise<{ bytes: Uint8Array; version: number; hash: string; name: string }> {
  const r = await readOfficeRevision(principal, draftId, version);
  if (r.kind !== "docx") throw new OfficeError(404, "Document not found.");
  return { bytes: r.bytes, version: r.version, hash: r.hash, name: r.name };
}

export async function saveWriterRevision(
  principal: string,
  input: { draftId: string; expectedVersion: number; bytes: Uint8Array; operationId: string },
): Promise<WriterDocSummary & { replayed?: boolean }> {
  const saved = await saveOfficeRevision(principal, {
    docId: input.draftId,
    expectedVersion: input.expectedVersion,
    bytes: input.bytes,
    operationId: input.operationId,
  });
  return { ...asWriter(saved), ...(saved.replayed ? { replayed: true } : {}) };
}

export async function putWriterRecovery(
  principal: string,
  input: { draftId: string; baseVersion: number; bytes: Uint8Array },
): Promise<{ ok: true }> {
  return putOfficeRecovery(principal, {
    docId: input.draftId,
    baseVersion: input.baseVersion,
    bytes: input.bytes,
  });
}

export async function readWriterRecovery(
  principal: string,
  draftId: string,
): Promise<{ bytes: Uint8Array; name: string }> {
  const r = await readOfficeRecovery(principal, draftId);
  return { bytes: r.bytes, name: r.name };
}

export async function deleteWriterDoc(
  principal: string,
  draftId: string,
): Promise<{ ok: true; alreadyDeleted: boolean }> {
  return deleteOfficeDoc(principal, draftId);
}

export async function loadWriterChat(
  principal: string,
  draftId: string,
  limit = 200,
): Promise<WriterChatMessage[]> {
  return loadOfficeChat(principal, draftId, limit);
}

export async function appendWriterChat(
  principal: string,
  draftId: string,
  message: OfficeChatAppendInput,
): Promise<WriterChatMessage> {
  return appendOfficeChat(principal, draftId, message);
}
