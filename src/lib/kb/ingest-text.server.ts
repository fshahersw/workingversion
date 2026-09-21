// Background text-ingest lane (server-only). A document that already has
// extractable page text but is too large to embed inside the synchronous save
// request is handed to the existing ingest worker as a compact "text" job:
//
//   save request  -> insert Aurora doc (queued) + store pages in S3 + enqueue
//   worker (SQS)  -> load pages -> processExistingCanonicalDoc (chunk+embed)
//
// This is the scalable, no-Bedrock-Data-Automation path: the browser already
// extracted the text, so there is nothing to OCR. Bedrock Data Automation stays
// only for documents with no extractable text at all (a true scan).
//
// Correctness properties:
//   - Tenant isolation: the worker re-fetches the document through the
//     FORCE-RLS Aurora path scoped to ownerSub, so a replayed or forged queue
//     message can never touch another principal's document.
//   - Idempotency: processExistingCanonicalDoc no-ops a document that is already
//     "ready" and uses conditional status transitions, so SQS at-least-once
//     redelivery cannot double-write chunks.
//   - Fail-safe: an embed failure marks the document "error" and finalizes the
//     workspace, so Ask degrades to its scan/partial-binding fallback instead of
//     leaving the set stuck "saving" forever (text jobs are not reconciled).
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";

import { loadKbAsyncIngestConfig } from "../config.server.ts";
import { requireClientFileId } from "./ingest-keys.ts";
import { IngestLimitError } from "./ingest.server.ts";
import {
  isTerminalErrorKind,
  type IngestStatus,
  type TerminalErrorKind,
} from "./ingest-state.ts";
import type { PageText } from "./convert.ts";
import type { CanonicalDoc } from "./canonical.ts";
import type {
  DocumentIngestPatch,
  KbDocumentInput,
  KbDocumentRecord,
  KbSurface,
} from "./aurora.server.ts";
import type { IngestResult } from "./ingest.server.ts";

export type TextIngestRegistration = {
  ownerSub: string;
  workspaceItemId: string;
  workspaceId: string;
  clientFileId: string;
  fileName: string;
  surface: KbSurface;
  mime?: string;
  sha256?: string;
  byteSize?: number;
  pages: PageText[];
};

/** Compact queue message. All authority is re-derived from Aurora under RLS;
 *  nothing here is trusted as identity beyond selecting which owned document to
 *  finish. Deliberately free of page text, file names, and object keys. */
export type TextIngestMessage = {
  version: 1;
  kind: "text";
  ownerSub: string;
  docId: string;
  workspaceItemId: string;
  workspaceId: string;
  clientFileId: string;
  surface: KbSurface;
  correlationId: string;
};

export type TextIngestRegistrationResult = { docId: string; status: IngestStatus };

const UUID = /^[0-9a-fA-F-]{8,64}$/;
const CORRELATION_ID = /^[A-Za-z0-9._:-]{1,256}$/;
const SURFACES = new Set<KbSurface>(["workingset", "deposition", "review"]);

export function parseTextIngestMessage(value: string | unknown): TextIngestMessage {
  const parsed: unknown = typeof value === "string" ? safeJson(value) : value;
  if (!parsed || typeof parsed !== "object") throw new Error("invalid text ingest message");
  const m = parsed as Record<string, unknown>;
  const str = (v: unknown, re: RegExp): string => {
    if (typeof v !== "string" || !re.test(v)) throw new Error("invalid text ingest message");
    return v;
  };
  if (m["version"] !== 1 || m["kind"] !== "text") throw new Error("invalid text ingest message");
  const surface = m["surface"];
  if (typeof surface !== "string" || !SURFACES.has(surface as KbSurface)) {
    throw new Error("invalid text ingest message");
  }
  return {
    version: 1,
    kind: "text",
    ownerSub: str(m["ownerSub"], UUID),
    docId: str(m["docId"], UUID),
    workspaceItemId: str(m["workspaceItemId"], UUID),
    workspaceId: str(m["workspaceId"], UUID),
    clientFileId: requireClientFileId(String(m["clientFileId"] ?? "")),
    surface: surface as KbSurface,
    correlationId: str(m["correlationId"], CORRELATION_ID),
  };
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("invalid text ingest message");
  }
}

export type TextIngestDependencies = {
  insertDocument(ownerSub: string, input: KbDocumentInput): Promise<string>;
  getDocument(ownerSub: string, docId: string): Promise<KbDocumentRecord | null>;
  updateDocument(
    ownerSub: string,
    docId: string,
    patch: DocumentIngestPatch,
    expected?: readonly IngestStatus[],
  ): Promise<boolean>;
  putPages(ownerSub: string, docId: string, pages: PageText[]): Promise<string>;
  getPages(ownerSub: string, itemId: string, docId: string): Promise<PageText[]>;
  toCanonical(
    pages: PageText[],
    meta: { fileName: string; mime?: string; sha256?: string },
  ): CanonicalDoc;
  processExisting(
    ownerSub: string,
    args: {
      docId: string;
      workspaceId: string;
      surface: KbSurface;
      doc: CanonicalDoc;
      converter: string;
      s3Key: string;
    },
  ): Promise<IngestResult>;
  checkpoint(
    ownerSub: string,
    patch: {
      itemId: string;
      clientFileId: string;
      status: IngestStatus;
      docId?: string;
      fileName?: string;
      mime?: string;
      size?: number;
      pagesKey?: string;
      pageCount?: number;
      chunkCount?: number;
      errorKind?: TerminalErrorKind;
    },
  ): Promise<void>;
  finalizeWorkspace(ownerSub: string, itemId: string): Promise<void>;
  enqueue(message: TextIngestMessage): Promise<void>;
};

export function createTextIngestOrchestrator(deps: TextIngestDependencies) {
  const failClosed = async (
    input: { ownerSub: string; docId: string; workspaceItemId: string; clientFileId: string },
    kind: TerminalErrorKind,
  ): Promise<void> => {
    await deps
      .updateDocument(
        input.ownerSub,
        input.docId,
        { status: "error", errorKind: kind, markCompleted: true },
        ["queued", "converting", "embedding"],
      )
      .catch(() => false);
    await deps
      .checkpoint(input.ownerSub, {
        itemId: input.workspaceItemId,
        clientFileId: input.clientFileId,
        status: "error",
        docId: input.docId,
        errorKind: kind,
      })
      .catch(() => {});
    await deps.finalizeWorkspace(input.ownerSub, input.workspaceItemId).catch(() => {});
  };

  return {
    async register(input: TextIngestRegistration): Promise<TextIngestRegistrationResult> {
      const clientFileId = requireClientFileId(input.clientFileId);
      const readable = input.pages.filter(
        (page) => page && Number(page.page) > 0 && String(page.text).trim(),
      );
      if (!readable.length) {
        // Nothing to index without OCR; caller should have skipped this file.
        throw new Error("text ingest requires at least one page of extracted text");
      }
      const docId = await deps.insertDocument(input.ownerSub, {
        workspaceId: input.workspaceId,
        surface: input.surface,
        fileName: input.fileName,
        ...(input.mime ? { mime: input.mime } : {}),
        ...(input.sha256 ? { sha256: input.sha256.toLowerCase() } : {}),
        ...(input.byteSize !== undefined ? { byteSize: input.byteSize } : {}),
        pageCount: readable.length,
        converter: "client-text",
        status: "queued",
      });
      // Persist the source text before the checkpoint records the key, so the
      // worker's pagesKey read can never precede the object write.
      const pagesKey = await deps.putPages(input.ownerSub, docId, readable);
      await deps.checkpoint(input.ownerSub, {
        itemId: input.workspaceItemId,
        clientFileId,
        status: "embedding",
        docId,
        fileName: input.fileName,
        ...(input.mime ? { mime: input.mime } : {}),
        ...(input.byteSize !== undefined ? { size: input.byteSize } : {}),
        pagesKey,
        pageCount: readable.length,
      });
      await deps.enqueue({
        version: 1,
        kind: "text",
        ownerSub: input.ownerSub,
        docId,
        workspaceItemId: input.workspaceItemId,
        workspaceId: input.workspaceId,
        clientFileId,
        surface: input.surface,
        correlationId: `text-${docId}`,
      });
      return { docId, status: "queued" };
    },

    async handle(message: TextIngestMessage): Promise<{ status: "processed" | "duplicate" }> {
      const document = await deps.getDocument(message.ownerSub, message.docId);
      // A missing / mismatched document is a replay after delete or a message
      // that does not belong to this owner: drop it (RLS already guaranteed the
      // fetch is owner-scoped).
      if (
        !document ||
        document.doc_id !== message.docId ||
        document.workspace_id !== message.workspaceId ||
        document.surface !== message.surface
      ) {
        return { status: "duplicate" };
      }
      if (document.status === "ready") {
        await deps
          .checkpoint(message.ownerSub, {
            itemId: message.workspaceItemId,
            clientFileId: message.clientFileId,
            status: "ready",
            docId: message.docId,
            pagesKey: document.s3_key ?? undefined,
            pageCount: document.page_count ?? undefined,
          })
          .catch(() => {});
        await deps.finalizeWorkspace(message.ownerSub, message.workspaceItemId).catch(() => {});
        return { status: "duplicate" };
      }
      if (document.status === "error") return { status: "duplicate" };

      let pages: PageText[];
      try {
        pages = await deps.getPages(message.ownerSub, message.workspaceItemId, message.docId);
      } catch {
        // The pages object is written before enqueue, so a read failure here is
        // an anomaly, not a normal race. Fail closed rather than loop to the DLQ
        // and leave the set stuck "saving".
        await failClosed(message, "processing");
        return { status: "processed" };
      }
      if (!pages.length) {
        await failClosed(message, "processing");
        return { status: "processed" };
      }

      const canonical = deps.toCanonical(pages, {
        fileName: document.file_name,
        ...(document.mime ? { mime: document.mime } : {}),
        ...(document.sha256 ? { sha256: document.sha256 } : {}),
      });
      try {
        const result = await deps.processExisting(message.ownerSub, {
          docId: message.docId,
          workspaceId: message.workspaceId,
          surface: message.surface,
          doc: canonical,
          converter: "client-text",
          s3Key: document.s3_key ?? "",
        });
        await deps.checkpoint(message.ownerSub, {
          itemId: message.workspaceItemId,
          clientFileId: message.clientFileId,
          status: "ready",
          docId: message.docId,
          fileName: document.file_name,
          ...(document.mime ? { mime: document.mime } : {}),
          ...(document.byte_size !== null ? { size: document.byte_size } : {}),
          ...(document.s3_key ? { pagesKey: document.s3_key } : {}),
          pageCount: result.pageCount,
          chunkCount: result.chunkCount,
        });
        await deps.finalizeWorkspace(message.ownerSub, message.workspaceItemId);
        return { status: "processed" };
      } catch (error) {
        // processExistingCanonicalDoc already marked the document terminal; record
        // the bounded kind on the checkpoint and finalize so the set resolves.
        const kind: TerminalErrorKind = error instanceof IngestLimitError ? "limits" : "processing";
        await deps
          .checkpoint(message.ownerSub, {
            itemId: message.workspaceItemId,
            clientFileId: message.clientFileId,
            status: "error",
            docId: message.docId,
            errorKind: isTerminalErrorKind(kind) ? kind : "processing",
          })
          .catch(() => {});
        await deps.finalizeWorkspace(message.ownerSub, message.workspaceItemId).catch(() => {});
        return { status: "processed" };
      }
    },
  };
}

let defaultsPromise: Promise<TextIngestDependencies> | undefined;

async function defaultDependencies(): Promise<TextIngestDependencies> {
  if (defaultsPromise) return defaultsPromise;
  defaultsPromise = (async () => {
    const config = loadKbAsyncIngestConfig();
    if (!config.queueUrl) throw new Error("text ingest queue is not configured");
    const [aurora, workspace, ingest, convert] = await Promise.all([
      import("./aurora.server.ts"),
      import("./workspace.server.ts"),
      import("./ingest.server.ts"),
      import("./convert.ts"),
    ]);
    const sqs = new SQSClient({ region: config.region });
    return {
      insertDocument: aurora.insertDocument,
      getDocument: aurora.getDocumentById,
      updateDocument: aurora.updateDocumentIngest,
      putPages: workspace.putWorkspacePages,
      getPages: workspace.getWorkspacePages,
      toCanonical: (pages, meta) => convert.pagesToCanonical(pages, meta),
      processExisting: (ownerSub, args) =>
        ingest.processExistingCanonicalDoc(ownerSub, { ...args, deferFailure: false }),
      checkpoint: workspace.checkpointWorkspaceDocument,
      finalizeWorkspace: async (ownerSub, itemId) => {
        await workspace.finalizeWorkspaceFromCheckpoints(ownerSub, itemId);
      },
      enqueue: async (message) => {
        await sqs.send(
          new SendMessageCommand({
            QueueUrl: config.queueUrl,
            MessageBody: JSON.stringify(message),
          }),
        );
      },
    };
  })();
  return defaultsPromise;
}

export async function registerTextIngest(
  input: TextIngestRegistration,
): Promise<TextIngestRegistrationResult> {
  return createTextIngestOrchestrator(await defaultDependencies()).register(input);
}

export async function handleTextIngest(
  message: TextIngestMessage,
): Promise<{ status: "processed" | "duplicate" }> {
  return createTextIngestOrchestrator(await defaultDependencies()).handle(message);
}
