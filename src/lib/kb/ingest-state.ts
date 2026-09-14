export const INGEST_STATUSES = ["queued", "converting", "embedding", "ready", "error"] as const;

export type IngestStatus = (typeof INGEST_STATUSES)[number];
export type IngestTransitionDecision = "apply" | "noop" | "reject";

const ALLOWED: Readonly<Record<IngestStatus, ReadonlySet<IngestStatus>>> = {
  queued: new Set(["converting", "embedding", "error"]),
  converting: new Set(["embedding", "error"]),
  embedding: new Set(["ready", "error"]),
  ready: new Set(),
  error: new Set(),
};

export function isIngestStatus(value: unknown): value is IngestStatus {
  return typeof value === "string" && (INGEST_STATUSES as readonly string[]).includes(value);
}

export function isTerminalIngestStatus(status: IngestStatus): boolean {
  return status === "ready" || status === "error";
}

export function decideIngestTransition(
  current: IngestStatus,
  target: IngestStatus,
): IngestTransitionDecision {
  if (current === target) return "noop";
  return ALLOWED[current].has(target) ? "apply" : "reject";
}

export const SYNC_INGEST_MAX_PAGES = 2_000;
export const SYNC_INGEST_MAX_CHARS = 3_000_000;
// Above these, embedding a document inside the synchronous save request risks
// the ~120s edge timeout under concurrent load, so the text-background lane
// hands it to the worker instead. Small documents still embed inline (no queue
// latency). Only consulted when the text-background lane is enabled.
export const SYNC_INLINE_MAX_PAGES = 300;
export const SYNC_INLINE_MAX_CHARS = 900_000;
export const ASYNC_INGEST_MAX_PAGES = 3_000;
export const ASYNC_INGEST_MAX_MARKDOWN_CHARS = 12_000_000;
export const ASYNC_INGEST_MAX_CHUNKS = 1_500;
export const ASYNC_INGEST_MAX_BYTES = 50 * 1024 * 1024;
/** Original-file preservation and conversion are different limits. */
export const SOURCE_FILE_MAX_BYTES = 200 * 1024 * 1024;

export function validateSaveByteSize(
  size: number | undefined,
  lane: "sync" | "async" | "text",
): void {
  if (size === undefined) return;
  if (!Number.isSafeInteger(size) || size < 1 || size > SOURCE_FILE_MAX_BYTES)
    throw new Error("File size must be between 1 byte and 200 MiB.");
  // The text-background lane indexes extracted page text, not the original
  // bytes, so the 50 MiB BDA input cap does not apply (only "async" carries it).
  if (lane === "async" && size > ASYNC_INGEST_MAX_BYTES)
    throw new Error(
      "This file requires background conversion, which supports up to 50 MiB. Split the original file or upload a searchable transcript. Your analysis remains available in this tab.",
    );
}

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

export type IngestLaneDecision =
  | { lane: "sync" }
  | { lane: "text" }
  | { lane: "async" }
  | { lane: "reject"; reason: "async-input-required" };

/**
 * Choose how a document is ingested.
 *
 * With the text-background lane enabled (the default; kill switch
 * KB_TEXT_BACKGROUND_LANE=0), any document that has extractable text is indexed
 * from that text: small documents embed inline in the save request ("sync"),
 * larger ones defer embedding to the background worker ("text") so a big file
 * cannot blow the synchronous edge timeout under concurrent load. Bedrock Data
 * Automation ("async") is used only when there is NO extractable text at all
 * (a true scan) and the original bytes are available.
 *
 * With the lane disabled, behavior is unchanged: inline sync up to the sync
 * caps, otherwise BDA (bytes required) or reject.
 */
export function selectIngestLane(
  args: {
    readablePages: number;
    totalChars: number;
    bytesKey?: string;
    sha256?: string;
  },
  opts?: { textBackground?: boolean },
): IngestLaneDecision {
  const hasText = args.readablePages > 0;
  if (opts?.textBackground) {
    const overInline =
      args.readablePages > SYNC_INLINE_MAX_PAGES || args.totalChars > SYNC_INLINE_MAX_CHARS;
    if (hasText) return overInline ? { lane: "text" } : { lane: "sync" };
    if (args.bytesKey && isSha256(args.sha256)) return { lane: "async" };
    return { lane: "reject", reason: "async-input-required" };
  }
  const requiresAsync =
    !hasText ||
    args.readablePages > SYNC_INGEST_MAX_PAGES ||
    args.totalChars > SYNC_INGEST_MAX_CHARS;
  if (!requiresAsync) return { lane: "sync" };
  if (args.bytesKey && isSha256(args.sha256)) return { lane: "async" };
  return { lane: "reject", reason: "async-input-required" };
}

/**
 * Browser-side plan for one document before a save request is built, so the
 * server's lane check never rejects the whole workspace over one file.
 *
 *  - "async": original bytes are stored; let BDA convert (required when the
 *    text is missing or over the synchronous limits, preferred when the
 *    extraction looks poor).
 *  - "sync": index the readable text we have.
 *  - "sync-degraded": extraction looked poor but the bytes are unavailable;
 *    index what we have rather than lose the document.
 *  - "skip": nothing to index and no bytes to convert. Leave it out and say so.
 */
export type SaveLanePlan = "async" | "sync" | "sync-degraded" | "skip";

export function planSaveLane(args: {
  readablePages: number;
  totalChars: number;
  lowQuality: boolean;
  hasBytes: boolean;
}): SaveLanePlan {
  const overSync =
    args.readablePages > SYNC_INGEST_MAX_PAGES || args.totalChars > SYNC_INGEST_MAX_CHARS;
  if (args.readablePages === 0 || overSync) return args.hasBytes ? "async" : "skip";
  if (args.lowQuality) return args.hasBytes ? "async" : "sync-degraded";
  return "sync";
}

export const TERMINAL_ERROR_KINDS = [
  "conversion",
  "processing",
  "limits",
  "configuration",
  "unknown",
] as const;

export type TerminalErrorKind = (typeof TERMINAL_ERROR_KINDS)[number];

export function isTerminalErrorKind(value: unknown): value is TerminalErrorKind {
  return typeof value === "string" && (TERMINAL_ERROR_KINDS as readonly string[]).includes(value);
}

/**
 * Persist and return only bounded, predefined summaries. Raw AWS/model errors,
 * document text, object keys, file names, and principals never enter this seam.
 */
export function terminalErrorSummary(kind: TerminalErrorKind): string {
  switch (kind) {
    case "conversion":
      return "Document conversion failed.";
    case "processing":
      return "Document indexing failed.";
    case "limits":
      return "Document exceeds asynchronous ingest limits.";
    case "configuration":
      return "Asynchronous ingest is unavailable.";
    default:
      return "Document ingest failed.";
  }
}
