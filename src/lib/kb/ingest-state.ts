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
export const ASYNC_INGEST_MAX_PAGES = 3_000;
export const ASYNC_INGEST_MAX_MARKDOWN_CHARS = 12_000_000;
export const ASYNC_INGEST_MAX_CHUNKS = 1_500;
export const ASYNC_INGEST_MAX_BYTES = 50 * 1024 * 1024;
/** Original-file preservation and conversion are different limits. */
export const SOURCE_FILE_MAX_BYTES = 200 * 1024 * 1024;

export function validateSaveByteSize(size: number | undefined, lane: "sync" | "async"): void {
  if (size === undefined) return;
  if (!Number.isSafeInteger(size) || size < 1 || size > SOURCE_FILE_MAX_BYTES)
    throw new Error("File size must be between 1 byte and 200 MiB.");
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
  | { lane: "async" }
  | { lane: "reject"; reason: "async-input-required" };

export function selectIngestLane(args: {
  readablePages: number;
  totalChars: number;
  bytesKey?: string;
  sha256?: string;
}): IngestLaneDecision {
  const requiresAsync =
    args.readablePages === 0 ||
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
