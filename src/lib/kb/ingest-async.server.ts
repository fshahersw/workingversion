import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";

import { loadKbAsyncIngestConfig, type KbAsyncIngestConfig } from "../config.server.ts";
import { bdaToCanonical } from "./convert.ts";
import {
  reconciliationCorrelationId,
  toIngestQueueMessage,
  type IngestCompletionEvent,
  type IngestQueueMessage,
} from "./ingest-events.ts";
import {
  bdaOutputPrefix,
  deterministicBdaClientToken,
  invocationJobId,
  requireClientFileId,
  requireOwnedBdaOutputPrefix,
  requireOwnedBdaResultUri,
  requireOwnedUploadKey,
} from "./ingest-keys.ts";
import type {
  IngestJobRecord,
  IngestJobStore,
  ReserveIngestJobInput,
} from "./ingest-job-store.server.ts";
import {
  ASYNC_INGEST_MAX_BYTES,
  ASYNC_INGEST_MAX_CHUNKS,
  ASYNC_INGEST_MAX_MARKDOWN_CHARS,
  ASYNC_INGEST_MAX_PAGES,
  isSha256,
  isTerminalErrorKind,
  terminalErrorSummary,
  type IngestStatus,
  type TerminalErrorKind,
} from "./ingest-state.ts";
import type {
  DocumentIngestPatch,
  KbDocumentInput,
  KbDocumentRecord,
  KbSurface,
} from "./aurora.server.ts";
import type { CanonicalDoc } from "./canonical.ts";
import type { BdaResult, BdaStatus } from "../agents/bda.server.ts";
import type { IngestResult } from "./ingest.server.ts";

export type AsyncIngestRegistration = {
  ownerSub: string;
  workspaceItemId: string;
  workspaceId: string;
  clientFileId: string;
  fileName: string;
  surface: KbSurface;
  mime?: string;
  /** Workspace-scoped idempotency hash; raw bytes remain in sha256. */
  documentSha256?: string;
  requestFingerprint: string;
  sha256: string;
  byteSize: number;
  inputKey: string;
};

export type AsyncIngestRegistrationResult = {
  docId: string;
  status: IngestStatus;
};

type BdaJob = { invocationArn: string; outputPrefix: string };
type BdaStatusResult = {
  status: BdaStatus;
  outputS3Uri?: string;
  error?: string;
};
type WorkspaceCheckpointPatch = {
  itemId: string;
  clientFileId: string;
  status: IngestStatus;
  docId?: string;
  jobId?: string;
  fileName?: string;
  mime?: string;
  size?: number;
  bytesKey?: string;
  pagesKey?: string;
  outputPrefix?: string;
  pageCount?: number;
  chunkCount?: number;
  errorKind?: TerminalErrorKind;
};

export type AsyncIngestDependencies = {
  jobs: IngestJobStore;
  bucket: string;
  now: () => Date;
  staleAfterSeconds: number;
  reserveDocument(ownerSub: string, input: KbDocumentInput): Promise<string>;
  getDocument(ownerSub: string, docId: string): Promise<KbDocumentRecord | null>;
  updateDocument(
    ownerSub: string,
    docId: string,
    patch: DocumentIngestPatch,
    expected?: readonly IngestStatus[],
  ): Promise<boolean>;
  startBda(
    inputKey: string,
    outputPrefix: string,
    options: { clientToken: string; eventBridgeEnabled: true },
  ): Promise<BdaJob>;
  verifyInput(inputKey: string, byteSize: number, sha256: string): Promise<void>;
  getBdaStatus(invocationArn: string): Promise<BdaStatusResult>;
  readBdaResult(outputS3Uri: string, options: { expectedOutputPrefix: string }): Promise<BdaResult>;
  putPages(
    ownerSub: string,
    docId: string,
    pages: { page: number; text: string }[],
  ): Promise<string>;
  processExisting(
    ownerSub: string,
    args: {
      docId: string;
      workspaceId: string;
      surface: KbSurface;
      doc: CanonicalDoc;
      converter: string;
      s3Key: string;
      bdaOutputS3Uri: string;
      maxChunks: number;
      deferFailure: true;
    },
  ): Promise<IngestResult>;
  reserveCheckpoint(
    ownerSub: string,
    args: {
      itemId: string;
      clientFileId: string;
      fileName: string;
      mime?: string;
      size?: number;
      bytesKey: string;
    },
  ): Promise<void>;
  checkpoint(ownerSub: string, patch: WorkspaceCheckpointPatch): Promise<void>;
  finalizeWorkspace(ownerSub: string, itemId: string): Promise<void>;
  enqueue(event: IngestQueueMessage): Promise<void>;
};

export class TerminalAsyncIngestError extends Error {
  readonly kind: TerminalErrorKind;

  constructor(kind: TerminalErrorKind) {
    super(terminalErrorSummary(kind));
    this.name = "TerminalAsyncIngestError";
    this.kind = kind;
  }
}

function canonicalPages(doc: CanonicalDoc): { page: number; text: string }[] {
  return doc.pages
    .map((page) => ({
      page: page.pageNo,
      text: page.blocks
        .map((block) => block.text.trim())
        .filter(Boolean)
        .join("\n\n"),
    }))
    .filter((page) => page.text.length > 0);
}

function validateJobDocumentCoordinates(
  job: IngestJobRecord,
  document: KbDocumentRecord | null,
): KbDocumentRecord {
  if (
    !document ||
    document.doc_id !== job.docId ||
    document.owner_sub !== job.ownerSub ||
    document.workspace_id !== job.workspaceId ||
    document.bda_input_key !== job.inputKey ||
    document.bda_output_prefix !== job.outputPrefix ||
    document.bda_client_file_id !== job.clientFileId
  ) {
    throw new TerminalAsyncIngestError("processing");
  }
  return document;
}

function validateJobDocument(
  job: IngestJobRecord,
  document: KbDocumentRecord | null,
): KbDocumentRecord {
  const validated = validateJobDocumentCoordinates(job, document);
  if (validated.bda_invocation_arn !== job.invocationArn) {
    throw new TerminalAsyncIngestError("processing");
  }
  return validated;
}

async function mapLimit<T>(
  values: readonly T[],
  limit: number,
  fn: (value: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= values.length) return;
        await fn(values[index]!);
      }
    }),
  );
}

async function retryIdempotent<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
  let failure: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      failure = error;
      if (attempt + 1 < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 150 * 2 ** attempt));
      }
    }
  }
  throw failure;
}

function terminalBdaStartFailure(error: unknown): boolean {
  const name = (error as { name?: unknown } | undefined)?.name;
  return (
    name === "AccessDeniedException" ||
    name === "ResourceNotFoundException" ||
    name === "ValidationException" ||
    name === "ServiceQuotaExceededException"
  );
}

function terminalInputFailure(error: unknown): TerminalErrorKind | undefined {
  const name = (error as { name?: unknown } | undefined)?.name;
  if (name === "ObjectIntegrityError" || name === "NoSuchKey" || name === "NotFound") {
    return "processing";
  }
  if (name === "AccessDenied" || name === "AccessDeniedException") {
    return "configuration";
  }
  return undefined;
}

export function createAsyncIngestOrchestrator(dependencies: AsyncIngestDependencies) {
  const markTerminal = async (
    job: IngestJobRecord,
    kind: TerminalErrorKind,
    processingToken?: string,
  ): Promise<void> => {
    const failed = await dependencies.jobs.fail(job.jobId, kind, processingToken);
    if (!failed) {
      // A prior delivery may have committed the job transition but failed
      // before its owner-scoped document/workspace checkpoints completed.
      const current = await dependencies.jobs.getByLookupId(job.jobId);
      if (current?.status !== "error") return;
      kind = isTerminalErrorKind(current.errorKind) ? current.errorKind : kind;
      job = current;
    }
    await dependencies.updateDocument(
      job.ownerSub,
      job.docId,
      { status: "error", errorKind: kind, markCompleted: true },
      ["queued", "converting", "embedding", "error"],
    );
    await dependencies.checkpoint(job.ownerSub, {
      itemId: job.workspaceItemId,
      clientFileId: job.clientFileId,
      status: "error",
      docId: job.docId,
      jobId: job.jobId,
      outputPrefix: job.outputPrefix,
      errorKind: kind,
    });
    await dependencies.finalizeWorkspace(job.ownerSub, job.workspaceItemId);
  };

  const ensureAttachedOwnerState = async (job: IngestJobRecord): Promise<void> => {
    if (!job.invocationArn || !job.invocationJobId) {
      throw new TerminalAsyncIngestError("processing");
    }
    let document = validateJobDocumentCoordinates(
      job,
      await dependencies.getDocument(job.ownerSub, job.docId),
    );
    if (document.bda_invocation_arn !== null && document.bda_invocation_arn !== job.invocationArn) {
      throw new TerminalAsyncIngestError("processing");
    }
    if (document.status === "ready" || document.status === "embedding") {
      if (document.bda_invocation_arn !== job.invocationArn) {
        throw new TerminalAsyncIngestError("processing");
      }
      return;
    }
    if (document.status === "error") {
      throw new TerminalAsyncIngestError("processing");
    }

    const moved = await dependencies.updateDocument(
      job.ownerSub,
      job.docId,
      {
        status: "converting",
        converter: "bda",
        bdaInvocationArn: job.invocationArn,
        bdaInputKey: job.inputKey,
        bdaOutputPrefix: job.outputPrefix,
        bdaClientFileId: job.clientFileId,
        markStarted: true,
      },
      ["queued", "converting"],
    );
    if (!moved) {
      document = validateJobDocumentCoordinates(
        job,
        await dependencies.getDocument(job.ownerSub, job.docId),
      );
      if (
        (document.status === "embedding" || document.status === "ready") &&
        document.bda_invocation_arn === job.invocationArn
      ) {
        return;
      }
      throw new TerminalAsyncIngestError("processing");
    }
    await dependencies.checkpoint(job.ownerSub, {
      itemId: job.workspaceItemId,
      clientFileId: job.clientFileId,
      status: "converting",
      docId: job.docId,
      jobId: job.jobId,
      outputPrefix: job.outputPrefix,
    });
  };

  return {
    async registerAndStart(input: AsyncIngestRegistration): Promise<AsyncIngestRegistrationResult> {
      if (!isSha256(input.sha256)) {
        throw new TerminalAsyncIngestError("processing");
      }
      if (!isSha256(input.requestFingerprint)) {
        throw new TerminalAsyncIngestError("processing");
      }
      if (input.documentSha256 && !isSha256(input.documentSha256)) {
        throw new TerminalAsyncIngestError("processing");
      }
      if (
        !Number.isSafeInteger(input.byteSize) ||
        input.byteSize === undefined ||
        input.byteSize < 1 ||
        input.byteSize > ASYNC_INGEST_MAX_BYTES
      ) {
        throw new TerminalAsyncIngestError("processing");
      }
      const clientFileId = requireClientFileId(input.clientFileId);
      const inputKey = requireOwnedUploadKey(input.ownerSub, input.inputKey);
      await dependencies.reserveCheckpoint(input.ownerSub, {
        itemId: input.workspaceItemId,
        clientFileId,
        fileName: input.fileName,
        ...(input.mime ? { mime: input.mime } : {}),
        size: input.byteSize,
        bytesKey: inputKey,
      });

      const docId = await dependencies.reserveDocument(input.ownerSub, {
        workspaceId: input.workspaceId,
        surface: input.surface,
        fileName: input.fileName,
        ...(input.mime ? { mime: input.mime } : {}),
        sha256: (input.documentSha256 ?? input.sha256).toLowerCase(),
        byteSize: input.byteSize,
        converter: "bda",
        status: "queued",
        bdaInputKey: inputKey,
        bdaClientFileId: clientFileId,
      });
      const outputPrefix = requireOwnedBdaOutputPrefix(
        input.ownerSub,
        docId,
        bdaOutputPrefix(input.ownerSub, docId),
      );
      const preparedDocument = await dependencies.updateDocument(
        input.ownerSub,
        docId,
        {
          bdaInputKey: inputKey,
          bdaOutputPrefix: outputPrefix,
          bdaClientFileId: clientFileId,
          converter: "bda",
        },
        ["queued", "converting"],
      );
      if (!preparedDocument) {
        throw new TerminalAsyncIngestError("processing");
      }
      const clientToken = deterministicBdaClientToken({
        principal: input.ownerSub,
        workspaceItemId: input.workspaceItemId,
        workspaceId: input.workspaceId,
        clientFileId,
        sha256: input.sha256,
      });
      const reservation: ReserveIngestJobInput = {
        jobId: clientToken,
        ownerSub: input.ownerSub,
        docId,
        workspaceItemId: input.workspaceItemId,
        workspaceId: input.workspaceId,
        clientFileId,
        requestFingerprint: input.requestFingerprint.toLowerCase(),
        sourceSha256: input.sha256.toLowerCase(),
        sourceByteSize: input.byteSize,
        inputKey,
        outputPrefix,
      };
      const job = await dependencies.jobs.reserve(reservation);
      try {
        await dependencies.checkpoint(input.ownerSub, {
          itemId: input.workspaceItemId,
          clientFileId,
          status: job.status,
          docId,
          jobId: job.jobId,
          outputPrefix,
        });
      } catch (error) {
        // A concurrent workspace delete can remove the child checkpoint after
        // reservation. Remove the exact job row instead of leaving correlation
        // state that could authorize later processing.
        await dependencies.jobs.delete(job.jobId).catch(() => undefined);
        throw error;
      }

      if (job.status === "ready") {
        return { docId, status: job.status };
      }
      if (job.status === "error") {
        await markTerminal(job, job.errorKind ?? "processing");
        return { docId, status: job.status };
      }
      if (job.invocationArn && job.invocationJobId) {
        try {
          await ensureAttachedOwnerState(job);
        } catch (error) {
          if (error instanceof TerminalAsyncIngestError) {
            await markTerminal(job, error.kind);
            throw new Error(terminalErrorSummary(error.kind));
          }
          throw error;
        }
        return { docId, status: job.status };
      }

      try {
        await retryIdempotent(() =>
          dependencies.verifyInput(job.inputKey, job.sourceByteSize, job.sourceSha256),
        );
      } catch (error) {
        const kind = terminalInputFailure(error);
        if (kind) {
          await markTerminal(job, kind);
          throw new Error(terminalErrorSummary(kind));
        }
        return { docId, status: "queued" };
      }

      let started: BdaJob;
      try {
        started = await retryIdempotent(() =>
          dependencies.startBda(inputKey, outputPrefix, {
            clientToken,
            eventBridgeEnabled: true,
          }),
        );
      } catch (error) {
        if (terminalBdaStartFailure(error)) {
          await markTerminal(job, "configuration");
          throw new Error(terminalErrorSummary("configuration"));
        }
        // The request may have reached BDA before the transport failed. Keep the
        // stable reservation queued so a retry/reconciler reuses this token.
        return { docId, status: "queued" };
      }
      if (
        !started.invocationArn ||
        requireOwnedBdaOutputPrefix(input.ownerSub, docId, started.outputPrefix) !== outputPrefix
      ) {
        await markTerminal(job, "configuration");
        throw new Error(terminalErrorSummary("configuration"));
      }
      const lookupId = invocationJobId(started.invocationArn);
      const attached = await retryIdempotent(
        () => dependencies.jobs.attachInvocation(job.jobId, lookupId, started.invocationArn),
        8,
      );
      try {
        await ensureAttachedOwnerState(attached);
      } catch (error) {
        if (error instanceof TerminalAsyncIngestError) {
          await markTerminal(attached, error.kind);
          throw new Error(terminalErrorSummary(error.kind));
        }
        throw error;
      }
      return { docId, status: "converting" };
    },

    async handleCompletion(
      event: IngestCompletionEvent,
    ): Promise<{ status: "processed" | "duplicate" }> {
      const job = await dependencies.jobs.getByLookupId(event.jobId);
      // A valid service event can arrive after an owner deleted the workspace
      // and its exact job mapping. Reconciliation covers the shorter race where
      // BDA completes before the initial correlation transaction commits.
      if (!job) return { status: "duplicate" };
      if (
        !job.invocationArn ||
        job.invocationArn !== event.invocationArn ||
        job.invocationJobId !== event.jobId
      ) {
        throw new Error("ingest event does not match its exact job mapping");
      }
      if (job.status === "error") {
        await markTerminal(job, job.errorKind ?? "processing");
        return { status: "duplicate" };
      }

      if (event.outcome === "failure") {
        if (job.status === "ready") {
          return { status: "duplicate" };
        }
        await markTerminal(job, "conversion");
        return { status: "processed" };
      }

      const claim = await dependencies.jobs.claimSuccess(job.jobId, event.correlationId);
      if (claim.kind !== "claimed") return { status: "duplicate" };
      const claimed = claim.job;
      const token = claim.processingToken;
      try {
        if (!claimed.invocationArn || !claimed.invocationJobId) {
          throw new TerminalAsyncIngestError("processing");
        }
        await dependencies.checkpoint(claimed.ownerSub, {
          itemId: claimed.workspaceItemId,
          clientFileId: claimed.clientFileId,
          status: "embedding",
          docId: claimed.docId,
          jobId: claimed.jobId,
          outputPrefix: claimed.outputPrefix,
        });

        const status = await dependencies.getBdaStatus(claimed.invocationArn);
        if (status.status === "ClientError" || status.status === "ServiceError") {
          throw new TerminalAsyncIngestError("conversion");
        }
        if (status.status !== "Success" || !status.outputS3Uri) {
          throw new Error("BDA completion is not observable yet");
        }
        requireOwnedBdaResultUri({
          uri: status.outputS3Uri,
          bucket: dependencies.bucket,
          principal: claimed.ownerSub,
          docId: claimed.docId,
          outputPrefix: claimed.outputPrefix,
        });
        const result = await dependencies.readBdaResult(status.outputS3Uri, {
          expectedOutputPrefix: claimed.outputPrefix,
        });
        if (
          result.pages > ASYNC_INGEST_MAX_PAGES ||
          result.markdown.length > ASYNC_INGEST_MAX_MARKDOWN_CHARS
        ) {
          throw new TerminalAsyncIngestError("limits");
        }
        const document = validateJobDocument(
          claimed,
          await dependencies.getDocument(claimed.ownerSub, claimed.docId),
        );
        const canonical = bdaToCanonical(
          { markdown: result.markdown, pageCount: result.pages },
          {
            docId: claimed.docId,
            fileName: document.file_name,
            ...(document.mime ? { mime: document.mime } : {}),
            ...(document.sha256 ? { sha256: document.sha256 } : {}),
          },
        );
        const pages = canonicalPages(canonical);
        if (!pages.length || canonical.pageCount > ASYNC_INGEST_MAX_PAGES) {
          throw new TerminalAsyncIngestError("limits");
        }
        const pagesKey = await dependencies.putPages(claimed.ownerSub, claimed.docId, pages);
        const processed = await dependencies.processExisting(claimed.ownerSub, {
          docId: claimed.docId,
          workspaceId: claimed.workspaceId,
          surface: document.surface,
          doc: canonical,
          converter: "bda",
          s3Key: pagesKey,
          bdaOutputS3Uri: status.outputS3Uri,
          maxChunks: ASYNC_INGEST_MAX_CHUNKS,
          deferFailure: true,
        });
        await dependencies.checkpoint(claimed.ownerSub, {
          itemId: claimed.workspaceItemId,
          clientFileId: claimed.clientFileId,
          status: "ready",
          docId: claimed.docId,
          jobId: claimed.jobId,
          fileName: document.file_name,
          ...(document.mime ? { mime: document.mime } : {}),
          ...(document.byte_size !== null ? { size: document.byte_size } : {}),
          bytesKey: claimed.inputKey,
          pagesKey,
          outputPrefix: claimed.outputPrefix,
          pageCount: processed.pageCount,
          chunkCount: processed.chunkCount,
        });
        await dependencies.finalizeWorkspace(claimed.ownerSub, claimed.workspaceItemId);
        await dependencies.jobs.complete(claimed.jobId, token);
        return { status: "processed" };
      } catch (error) {
        const kind =
          error instanceof TerminalAsyncIngestError
            ? error.kind
            : (error as { name?: string } | undefined)?.name === "IngestLimitError"
              ? "limits"
              : undefined;
        if (kind || claimed.attempts >= 5) {
          await markTerminal(claimed, kind ?? "processing", token);
          return { status: "processed" };
        }
        await dependencies.jobs.release(claimed.jobId, token);
        throw new Error("asynchronous ingest retry required");
      }
    },

    async reconcileStale(): Promise<{
      checked: number;
      enqueued: number;
    }> {
      const staleBefore = new Date(
        dependencies.now().getTime() - dependencies.staleAfterSeconds * 1000,
      ).toISOString();
      const jobs = await dependencies.jobs.listStale(
        ["queued", "converting", "embedding"],
        staleBefore,
        50,
      );
      let enqueued = 0;
      await mapLimit(jobs, 4, async (job) => {
        try {
          if (job.status === "queued") {
            await dependencies.verifyInput(job.inputKey, job.sourceByteSize, job.sourceSha256);
            const started = await dependencies.startBda(job.inputKey, job.outputPrefix, {
              clientToken: job.jobId,
              eventBridgeEnabled: true,
            });
            if (
              !started.invocationArn ||
              requireOwnedBdaOutputPrefix(job.ownerSub, job.docId, started.outputPrefix) !==
                job.outputPrefix
            ) {
              throw new TerminalAsyncIngestError("configuration");
            }
            const lookupId = invocationJobId(started.invocationArn);
            const attached = await dependencies.jobs.attachInvocation(
              job.jobId,
              lookupId,
              started.invocationArn,
            );
            await ensureAttachedOwnerState(attached);
            return;
          }
          if (!job.invocationArn || !job.invocationJobId) {
            throw new TerminalAsyncIngestError("processing");
          }
          await ensureAttachedOwnerState(job);
          const observed = await dependencies.getBdaStatus(job.invocationArn);
          let outcome: "success" | "failure" | undefined;
          if (observed.status === "Success") outcome = "success";
          if (observed.status === "ClientError" || observed.status === "ServiceError") {
            outcome = "failure";
          }
          if (!outcome) {
            await dependencies.jobs.touch(job.jobId);
            return;
          }
          await dependencies.enqueue(
            toIngestQueueMessage(
              job.invocationArn,
              outcome,
              reconciliationCorrelationId(job.invocationArn, job.updatedAt),
            ),
          );
          await dependencies.jobs.touch(job.jobId);
          enqueued += 1;
        } catch (error) {
          const inputFailure = job.status === "queued" ? terminalInputFailure(error) : undefined;
          if (
            error instanceof TerminalAsyncIngestError ||
            inputFailure ||
            (job.status === "queued" && terminalBdaStartFailure(error))
          ) {
            await markTerminal(
              job,
              error instanceof TerminalAsyncIngestError
                ? error.kind
                : (inputFailure ?? "configuration"),
            );
          }
          // Best-effort pass. The unchanged stale row is retried next schedule.
        }
      });
      return { checked: jobs.length, enqueued };
    },
  };
}

let defaultsPromise: Promise<AsyncIngestDependencies> | undefined;

async function defaultDependencies(): Promise<AsyncIngestDependencies> {
  if (defaultsPromise) return defaultsPromise;
  defaultsPromise = (async () => {
    const config: KbAsyncIngestConfig = loadKbAsyncIngestConfig();
    if (!config.jobsTable || !config.queueUrl) {
      throw new Error(terminalErrorSummary("configuration"));
    }
    const [jobStoreModule, aurora, bda, workspace, ingest, s3Module] = await Promise.all([
      import("./ingest-job-store.server.ts"),
      import("./aurora.server.ts"),
      import("../agents/bda.server.ts"),
      import("./workspace.server.ts"),
      import("./ingest.server.ts"),
      import("../data/s3.server.ts"),
    ]);
    const sqs = new SQSClient({ region: config.region });
    return {
      jobs: jobStoreModule.createIngestJobStore({ config }),
      bucket: s3Module.bucketName(),
      now: () => new Date(),
      staleAfterSeconds: config.staleAfterSeconds,
      reserveDocument: aurora.insertDocument,
      getDocument: aurora.getDocumentById,
      updateDocument: aurora.updateDocumentIngest,
      startBda: bda.startExtraction,
      verifyInput: s3Module.verifyUploadedObject,
      getBdaStatus: bda.getStatus,
      readBdaResult: bda.readResult,
      putPages: workspace.putWorkspacePages,
      processExisting: ingest.processExistingCanonicalDoc,
      reserveCheckpoint: workspace.reserveWorkspaceDocument,
      checkpoint: workspace.checkpointWorkspaceDocument,
      finalizeWorkspace: async (ownerSub, itemId) => {
        await workspace.finalizeWorkspaceFromCheckpoints(ownerSub, itemId);
      },
      enqueue: async (event) => {
        await sqs.send(
          new SendMessageCommand({
            QueueUrl: config.queueUrl,
            MessageBody: JSON.stringify(event),
          }),
        );
      },
    };
  })();
  return defaultsPromise;
}

export async function registerAsyncIngest(
  input: AsyncIngestRegistration,
): Promise<AsyncIngestRegistrationResult> {
  return (await createDefaultOrchestrator()).registerAndStart(input);
}

export async function handleAsyncIngestCompletion(
  event: IngestCompletionEvent,
): Promise<{ status: "processed" | "duplicate" }> {
  return (await createDefaultOrchestrator()).handleCompletion(event);
}

export async function reconcileAsyncIngestJobs(): Promise<{
  checked: number;
  enqueued: number;
}> {
  return (await createDefaultOrchestrator()).reconcileStale();
}

async function createDefaultOrchestrator() {
  return createAsyncIngestOrchestrator(await defaultDependencies());
}
