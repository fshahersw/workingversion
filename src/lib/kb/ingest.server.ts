// KB ingest orchestrator (server-only): CanonicalDoc -> chunk -> embed -> persist.
// Synchronous path for the Working Set MVP (the browser pile already extracts page
// text, so ingestPages takes {page,text}[]). Scanned/oversized docs get the async
// BDA lane later; this orchestrator is reused there too (it just takes a
// CanonicalDoc, however it was produced).

import { chunkDocument } from "./chunk.ts";
import { embedChunks } from "./embed.ts";
import { pagesToCanonical, type PageText } from "./convert.ts";
import {
  getDocumentById,
  insertDocument,
  replaceDocumentChunks,
  updateDocumentIngest,
  type KbSurface,
  type KbChunkRow,
  type KbDocumentRecord,
} from "./aurora.server.ts";
import type { KbChunkInput } from "./chunk.ts";
import type { CanonicalDoc } from "./canonical.ts";
import { terminalErrorSummary } from "./ingest-state.ts";

export type IngestResult = { docId: string; chunkCount: number; pageCount: number };

export class IngestLimitError extends Error {
  constructor() {
    super(terminalErrorSummary("limits"));
    this.name = "IngestLimitError";
  }
}

export type ProcessExistingDependencies = {
  getDocument?: (sub: string, docId: string) => Promise<KbDocumentRecord | null>;
  chunk?: (doc: CanonicalDoc) => KbChunkInput[];
  embed?: (fileName: string, chunks: KbChunkInput[]) => Promise<KbChunkRow[]>;
  replaceChunks?: (
    sub: string,
    docId: string,
    workspaceId: string,
    surface: KbSurface,
    rows: KbChunkRow[],
  ) => Promise<void>;
  updateIngest?: typeof updateDocumentIngest;
};

/**
 * Chunk, embed, and atomically replace chunks for an already-registered
 * document. A ready row is a completed idempotent replay and is not re-embedded.
 */
export async function processExistingCanonicalDoc(
  sub: string,
  args: {
    docId: string;
    workspaceId: string;
    surface: KbSurface;
    doc: CanonicalDoc;
    converter?: string;
    s3Key?: string;
    bdaOutputS3Uri?: string;
    maxChunks?: number;
    /** Worker owns retry exhaustion and will mark the terminal failure itself. */
    deferFailure?: boolean;
  },
  dependencies: ProcessExistingDependencies = {},
): Promise<IngestResult> {
  const getDocument = dependencies.getDocument ?? getDocumentById;
  const chunk = dependencies.chunk ?? chunkDocument;
  const embed = dependencies.embed ?? embedChunks;
  const replaceChunks = dependencies.replaceChunks ?? replaceDocumentChunks;
  const updateIngest = dependencies.updateIngest ?? updateDocumentIngest;

  const existing = await getDocument(sub, args.docId);
  if (
    !existing ||
    existing.workspace_id !== args.workspaceId ||
    existing.surface !== args.surface
  ) {
    throw new Error(terminalErrorSummary("processing"));
  }

  const chunks = chunk(args.doc);
  if (
    !chunks.length ||
    args.doc.pageCount < 1 ||
    (args.maxChunks !== undefined && chunks.length > args.maxChunks)
  ) {
    if (!args.deferFailure) {
      await updateIngest(
        sub,
        args.docId,
        { status: "error", errorKind: "limits", markCompleted: true },
        ["queued", "converting", "embedding"],
      ).catch(() => false);
    }
    throw new IngestLimitError();
  }

  if (existing.status === "ready") {
    return {
      docId: args.docId,
      chunkCount: chunks.length,
      pageCount: existing.page_count ?? args.doc.pageCount,
    };
  }

  try {
    const moved = await updateIngest(
      sub,
      args.docId,
      {
        status: "embedding",
        converter: args.converter ?? "client-text",
        ...(args.s3Key !== undefined ? { s3Key: args.s3Key } : {}),
        ...(args.bdaOutputS3Uri !== undefined ? { bdaOutputS3Uri: args.bdaOutputS3Uri } : {}),
        markStarted: true,
      },
      ["queued", "converting", "embedding"],
    );
    if (!moved) {
      const current = await getDocument(sub, args.docId);
      if (current?.status === "ready") {
        return {
          docId: args.docId,
          chunkCount: chunks.length,
          pageCount: current.page_count ?? args.doc.pageCount,
        };
      }
      throw new Error(terminalErrorSummary("processing"));
    }

    const rows = await embed(args.doc.fileName, chunks);
    await replaceChunks(sub, args.docId, args.workspaceId, args.surface, rows);
    const completed = await updateIngest(
      sub,
      args.docId,
      {
        status: "ready",
        pageCount: args.doc.pageCount,
        converter: args.converter ?? "client-text",
        ...(args.s3Key !== undefined ? { s3Key: args.s3Key } : {}),
        ...(args.bdaOutputS3Uri !== undefined ? { bdaOutputS3Uri: args.bdaOutputS3Uri } : {}),
        markCompleted: true,
      },
      ["embedding"],
    );
    if (!completed) {
      const current = await getDocument(sub, args.docId);
      if (current?.status !== "ready") {
        throw new Error(terminalErrorSummary("processing"));
      }
    }
    return {
      docId: args.docId,
      chunkCount: rows.length,
      pageCount: args.doc.pageCount,
    };
  } catch (error) {
    if (!(error instanceof IngestLimitError) && !args.deferFailure) {
      await updateIngest(
        sub,
        args.docId,
        { status: "error", errorKind: "processing", markCompleted: true },
        ["embedding"],
      ).catch(() => false);
    }
    throw error;
  }
}

export async function ingestCanonicalDoc(
  sub: string,
  args: {
    workspaceId: string;
    surface: KbSurface;
    doc: CanonicalDoc;
    byteSize?: number;
    converter?: string;
    onRegistered?: (docId: string) => Promise<void>;
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
  await args.onRegistered?.(docId);
  return processExistingCanonicalDoc(sub, {
    docId,
    workspaceId,
    surface,
    doc,
    converter: args.converter ?? "client-text",
  });
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
    onRegistered?: (docId: string) => Promise<void>;
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
    onRegistered: args.onRegistered,
  });
}
