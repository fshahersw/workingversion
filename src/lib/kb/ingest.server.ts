// KB ingest orchestrator (server-only): CanonicalDoc -> chunk -> embed -> persist.
// Synchronous path for the Working Set MVP (the browser pile already extracts page
// text, so ingestPages takes {page,text}[]). Scanned/oversized docs get the async
// BDA lane later; this orchestrator is reused there too (it just takes a
// CanonicalDoc, however it was produced).

import { chunkDocument } from "./chunk";
import { embedChunks } from "./embed";
import { pagesToCanonical, type PageText } from "./convert";
import {
  insertDocument,
  insertChunks,
  updateDocumentStatus,
  type KbSurface,
} from "./aurora.server";
import type { CanonicalDoc } from "./canonical";

export type IngestResult = { docId: string; chunkCount: number; pageCount: number };

export async function ingestCanonicalDoc(
  sub: string,
  args: {
    workspaceId: string;
    surface: KbSurface;
    doc: CanonicalDoc;
    byteSize?: number;
    converter?: string;
  },
): Promise<IngestResult> {
  const { workspaceId, surface, doc } = args;
  const docId = await insertDocument(sub, {
    workspaceId,
    surface,
    fileName: doc.fileName,
    mime: doc.mime ?? null,
    sha256: doc.sha256 ?? null,
    byteSize: args.byteSize ?? null,
    pageCount: doc.pageCount,
    converter: args.converter ?? "client-text",
    status: "embedding",
  });
  try {
    const chunks = chunkDocument(doc);
    const rows = await embedChunks(doc.fileName, chunks);
    await insertChunks(sub, docId, workspaceId, surface, rows);
    await updateDocumentStatus(sub, docId, "ready", { pageCount: doc.pageCount });
    return { docId, chunkCount: rows.length, pageCount: doc.pageCount };
  } catch (e) {
    await updateDocumentStatus(sub, docId, "error", {
      error: e instanceof Error ? e.message : String(e),
    }).catch(() => {});
    throw e;
  }
}

export async function ingestPages(
  sub: string,
  args: {
    workspaceId: string;
    surface: KbSurface;
    fileName: string;
    mime?: string;
    sha256?: string;
    byteSize?: number;
    pages: PageText[];
  },
): Promise<IngestResult> {
  const doc = pagesToCanonical(args.pages, {
    fileName: args.fileName,
    ...(args.mime ? { mime: args.mime } : {}),
    ...(args.sha256 ? { sha256: args.sha256 } : {}),
  });
  return ingestCanonicalDoc(sub, {
    workspaceId: args.workspaceId,
    surface: args.surface,
    doc,
    ...(args.byteSize !== undefined ? { byteSize: args.byteSize } : {}),
    converter: "client-text",
  });
}
